import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { identityLocalDatabaseName, migrateLocalRecord, openLocalKeyVault } from './local-key-vault.mjs'
import { bufToB64, b64ToBuf } from './crypto.js'

const newKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

test('changing identity opens a separate local database, survives reload and preserves old encrypted history', async () => {
  const source = await readFile(new URL('../stores/chat.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function getOrCreateMessageEncryptKey()')
  const end = source.indexOf('\n/**', start)
  const oldWrapper = await newKey()
  const newWrapper = await newKey()
  const oldVault = await openLocalKeyVault(null, oldWrapper)
  const oldRecord = { ...oldVault.record, migrating: false }
  const databases = new Map([['test_messages', new Map([['message_key', new Map([['encrypt_key', oldRecord]])], ['messages', new Map([['old-message', { text: 'preserved encrypted history' }]])]])]])
  const publicKey = bufToB64(await crypto.subtle.exportKey('spki', (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])).publicKey))
  const build = wrappingKey => {
    let databaseName = 'test_messages'
    const dependencies = {
      DB_NAME: 'test_messages', KEY_STORE_NAME: 'message_key', STORE_NAME: 'messages', FILE_STORE_NAME: 'files', FILE_CHUNK_STORE_NAME: 'chunks',
      getLocalDataWrappingKey: async () => wrappingKey,
      loadKeyPair: async () => ({ pubKeyB64: publicKey }),
      openLocalKeyVault, migrateLocalRecord, identityLocalDatabaseName,
      openMessagesDB: async name => {
        if (!databases.has(name)) databases.set(name, new Map())
        const stores = databases.get(name)
        return {
          close() {},
          transaction(storeName) {
            if (!stores.has(storeName)) stores.set(storeName, new Map())
            const records = stores.get(storeName)
            const transaction = {}
            const operation = execute => {
              const request = {}
              queueMicrotask(() => {
                request.result = execute()
                request.onsuccess?.()
                queueMicrotask(() => transaction.oncomplete?.())
              })
              return request
            }
            transaction.objectStore = () => ({
              get: id => operation(() => records.get(id)),
              put: record => operation(() => records.set(record.id, structuredClone(record))),
              openCursor: () => operation(() => null),
            })
            return transaction
          },
        }
      },
    }
    const run = new Function(...Object.keys(dependencies), 'getName', 'setName', `let activeDatabaseName = getName(); ${source.slice(start, end)}; return async () => { const key = await getOrCreateMessageEncryptKey(); setName(activeDatabaseName); return key }`)(...Object.values(dependencies), () => databaseName, value => { databaseName = value })
    return { run, name: () => databaseName }
  }
  const fresh = build(newWrapper)
  const currentKey = await fresh.run()
  assert.equal(fresh.name(), await identityLocalDatabaseName('test_messages', publicKey))
  assert.equal(databases.get('test_messages').get('message_key').get('encrypt_key'), oldRecord)
  assert.equal(databases.get('test_messages').get('messages').size, 1)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, currentKey, new TextEncoder().encode('new group message'))
  const reloaded = await build(newWrapper).run()
  assert.equal(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, reloaded, ciphertext)), 'new group message')
  const original = build(oldWrapper)
  await original.run()
  assert.equal(original.name(), 'test_messages')
})

test('persists only a wrapped local data key and rejects the wrong identity wrapping key', async () => {
  const wrapper = await newKey()
  const vault = await openLocalKeyVault(null, wrapper)
  assert.equal(vault.record.cryptoKey, undefined)
  assert.equal(vault.record.key, undefined)
  const restored = await openLocalKeyVault(vault.record, wrapper)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vault.key, new TextEncoder().encode('local'))
  assert.equal(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, restored.key, encrypted)), 'local')
  await assert.rejects(openLocalKeyVault(vault.record, await newKey()))
})

test('migrates old encrypted and plaintext history and can resume without encrypting twice', async () => {
  const oldKey = await newKey()
  const wrapper = await newKey()
  const vault = await openLocalKeyVault({ cryptoKey: oldKey }, wrapper)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, oldKey, new TextEncoder().encode('history'))
  const oldRecord = { id: 'message', text: { encrypted: true, iv: bufToB64(iv), ciphertext: bufToB64(ciphertext) } }
  const migrated = await migrateLocalRecord('messages', oldRecord, oldKey, vault.key)
  const resumed = await openLocalKeyVault(vault.record, wrapper)
  assert.equal(await migrateLocalRecord('messages', migrated, oldKey, resumed.key), migrated)
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(migrated.text.iv) }, resumed.key, b64ToBuf(migrated.text.ciphertext))
  assert.equal(new TextDecoder().decode(decrypted), 'history')
  const plaintext = await migrateLocalRecord('messages', { id: 'legacy', text: 'plaintext' }, oldKey, vault.key)
  assert.equal(plaintext.text.encrypted, true)
})

test('migrates attachment chunks while preserving message and chunk authentication', async () => {
  const oldKey = await newKey()
  const vault = await openLocalKeyVault({ cryptoKey: oldKey }, await newKey())
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const additionalData = new TextEncoder().encode('yunmi.local-file-chunk|1|message|3')
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, oldKey, new Uint8Array([1, 2, 3]))
  const record = { id: 'message:3', msgId: 'message', index: 3, iv, ciphertext }
  const migrated = await migrateLocalRecord('message_file_chunks', record, oldKey, vault.key)
  assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: migrated.iv, additionalData }, vault.key, migrated.ciphertext)), new Uint8Array([1, 2, 3]))
  await assert.rejects(migrateLocalRecord('message_file_chunks', { ...record, index: 4 }, oldKey, vault.key))
})
