import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers'
import { accessPendingStore, invalidPendingContent, pendingEvictions, PENDING_LIMITS } from './pending-storage.mjs'

function database(initial = []) {
  const records = new Map(initial.map(record => [record.msg_id, structuredClone(record)]))
  return {
    records,
    transaction() {
      const transaction = {}
      let pending = 0
      let finished = false
      function enqueue(execute, request = {}) {
        pending++
        queueMicrotask(() => {
          request.result = execute()
          request.onsuccess?.()
          pending--
          setImmediate(() => {
            if (!pending && !finished) {
              finished = true
              transaction.oncomplete?.()
            }
          })
        })
        return request
      }
      transaction.objectStore = () => ({
        get: id => enqueue(() => structuredClone(records.get(id))),
        put: record => enqueue(() => records.set(record.msg_id, structuredClone(record))),
        delete: id => enqueue(() => records.delete(id)),
        getAll: () => enqueue(() => [...records.values()].map(record => structuredClone(record))),
        openCursor() {
          const request = {}
          let ids
          let position = 0
          const next = () => enqueue(() => {
            ids ||= [...records.keys()]
            if (position >= ids.length) return null
            const id = ids[position++]
            return {
              primaryKey: id,
              value: structuredClone(records.get(id)),
              update: record => enqueue(() => records.set(id, structuredClone(record))),
              continue: next,
            }
          }, request)
          return next()
        },
      })
      return transaction
    },
  }
}

test('retention evicts expired, oversized and least recently updated entries within count and byte budgets', () => {
  const entries = [
    { id: 'expired', storedAt: 0, updatedAt: 99, bytes: 1 },
    { id: 'large', storedAt: 99, updatedAt: 99, bytes: 31 },
    { id: 'old', storedAt: 90, updatedAt: 90, bytes: 15 },
    { id: 'new', storedAt: 95, updatedAt: 95, bytes: 15 },
    { id: 'updated', storedAt: 90, updatedAt: 99, bytes: 15 },
  ]
  assert.deepEqual(pendingEvictions(entries, 100, { ttl: 50, entryBytes: 30, count: 2, bytes: 30 }), ['expired', 'large', 'old'])
  assert.deepEqual(pendingEvictions(entries.slice(2), 100, { ttl: 50, entryBytes: 30, count: 100, bytes: 15 }), ['old', 'new'])
})

test('pending writes preserve the first local timestamp across replays and enforce TTL on reads', async () => {
  const db = database()
  const payload = { msg_id: 'a-b-c', ts: 9999999999999, ciphertext: 'encrypted', pendingStoredAt: -1 }
  await accessPendingStore(db, 'pending', payload, 100)
  await accessPendingStore(db, 'pending', { ...payload, attachment_paused: true }, 200)
  assert.equal(db.records.size, 1)
  assert.equal(db.records.get(payload.msg_id).pendingStoredAt, 100)
  assert.equal(db.records.get(payload.msg_id).pendingUpdatedAt, 200)
  assert.equal((await accessPendingStore(db, 'pending', null, 300))[0].attachment_paused, true)
  assert.deepEqual(await accessPendingStore(db, 'pending', null, 100 + PENDING_LIMITS.ttl), [])
  assert.equal(db.records.size, 0)
})

test('pending access bounds legacy records and initializes local timestamps without trusting server time', async () => {
  const initial = Array.from({ length: PENDING_LIMITS.count + 1 }, (_, index) => ({ msg_id: `legacy-${index}`, ts: 1, ciphertext: 'encrypted' }))
  const db = database(initial)
  const retained = await accessPendingStore(db, 'pending', null, 100)
  assert.equal(retained.length, PENDING_LIMITS.count)
  assert.equal(db.records.size, PENDING_LIMITS.count)
  assert.ok(retained.every(record => record.pendingStoredAt === 100))
  assert.equal((await accessPendingStore(db, 'pending', null, 100 + PENDING_LIMITS.ttl)).length, 0)
})

test('oversized pending payloads are rejected before a transaction or acknowledgment', async () => {
  const db = database()
  await assert.rejects(accessPendingStore(db, 'pending', { msg_id: 'huge', ciphertext: 'x'.repeat(PENDING_LIMITS.entryBytes) }), /storage limit/)
  assert.equal(db.records.size, 0)
})

test('new pending writes evict the oldest entry instead of exceeding the count budget', async () => {
  const initial = Array.from({ length: PENDING_LIMITS.count }, (_, index) => ({
    msg_id: `old-${index}`, ciphertext: 'encrypted', pendingStoredAt: 1, pendingUpdatedAt: index + 1,
  }))
  const db = database(initial)
  await accessPendingStore(db, 'pending', { ...initial[0], attachment_paused: true }, 3000)
  await accessPendingStore(db, 'pending', { msg_id: 'new', ciphertext: 'encrypted' }, 4000)
  assert.equal(db.records.size, PENDING_LIMITS.count)
  assert.equal(db.records.has('new'), true)
  assert.equal(db.records.has('old-0'), true)
  assert.equal(db.records.has('old-1'), false)
})

test('aborted pending transactions reject rather than acknowledging a failed save', async () => {
  const error = new DOMException('Storage unavailable', 'QuotaExceededError')
  const db = {
    transaction() {
      const transaction = {
        error,
        objectStore: () => ({ get: () => ({}) }),
      }
      queueMicrotask(() => transaction.onabort())
      return transaction
    },
  }
  await assert.rejects(accessPendingStore(db, 'pending', { msg_id: 'a-b-c' }), error)
})

test('only permanent cryptographic or format failures qualify for ciphertext deletion', () => {
  for (const error of [new DOMException('Invalid ciphertext', 'OperationError'), new SyntaxError('Invalid JSON'), new Error('Message sender signature is invalid')]) {
    assert.equal(invalidPendingContent(error), true)
  }
  for (const message of ['Group roster unavailable', 'Private key is locked', 'Sender identity is unavailable', 'Network Error', 'QuotaExceededError']) {
    assert.equal(invalidPendingContent(new Error(message)), false)
  }
})
