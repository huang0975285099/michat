import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bufToB64, clearKeyPair, exportPrivateKey, generateAndStoreKeyPair, getLocalDataWrappingKey, isUnlocked, loadKeyPair, lock, pinPeerPublicKey, setupSecurityCode, unlock } from './crypto.js'
import { openLocalKeyVault } from './local-key-vault.mjs'

const stores = new Map()
globalThis.indexedDB = {
  open() {
    const request = {}
    queueMicrotask(() => {
      const db = {
        close() {},
        transaction(name) {
          if (!stores.has(name)) stores.set(name, new Map())
          const records = stores.get(name)
          const transaction = { pending: 0, aborted: false }
          transaction.abort = () => {
            transaction.aborted = true
            queueMicrotask(() => transaction.onabort?.())
          }
          const operation = execute => {
            const result = {}
            transaction.pending++
            queueMicrotask(() => {
              if (transaction.aborted) return
              result.result = execute()
              result.onsuccess?.({ target: result })
              transaction.pending--
              queueMicrotask(() => {
                if (!transaction.pending && !transaction.aborted) transaction.oncomplete?.()
              })
            })
            return result
          }
          transaction.objectStore = () => ({
            get: id => operation(() => structuredClone(records.get(id))),
            put: record => operation(() => records.set(record.id, structuredClone(record))),
            delete: id => operation(() => records.delete(id)),
          })
          return transaction
        },
      }
      request.onsuccess?.({ target: { result: db } })
    })
    return request
  },
}

const passphrase = 'long-security-code-1234'

test('stores device-protected private keys without an extractable private CryptoKey', async () => {
  await generateAndStoreKeyPair()
  assert.equal(stores.get('identity').get('keypair').privateKey, undefined)
  assert.ok((await loadKeyPair()).privateKey)
  assert.equal(stores.get('identity').get('keypair').privateKey, undefined)
})

test('clearing identity also clears unlocked private key and prevents subsequent exports', async () => {
  await setupSecurityCode(passphrase)
  assert.equal(await unlock(passphrase), true)
  assert.ok(await exportPrivateKey())
  await clearKeyPair()
  assert.equal(isUnlocked(), false)
  await assert.rejects(exportPrivateKey(), /no key pair/)
})

test('locking while an unlock is in flight cannot restore the private key cache', async () => {
  await generateAndStoreKeyPair()
  await setupSecurityCode(passphrase)
  const pending = unlock(passphrase)
  lock()
  assert.equal(await pending, false)
  assert.equal(isUnlocked(), false)
  await assert.rejects(getLocalDataWrappingKey(), /locked/)
})

test('new security codes reject six-digit PINs and require a stronger passphrase', async () => {
  await assert.rejects(setupSecurityCode('123456'), /12/)
  await assert.rejects(setupSecurityCode('abcdefghijkl'), /letters and numbers/)
})

test('pins peer identity keys and rejects later substitutions without overwriting the original', async () => {
  const original = await generateAndStoreKeyPair()
  const replacement = await generateAndStoreKeyPair()
  assert.equal(await pinPeerPublicKey('account', 'friend', original), original)
  await assert.rejects(pinPeerPublicKey('account', 'friend', replacement), /changed/)
  assert.equal(await pinPeerPublicKey('account', 'friend', original), original)
})

test('restores a wrapped local history key after unlocking and refuses access while locked', async () => {
  await generateAndStoreKeyPair()
  const wrappingKey = await getLocalDataWrappingKey()
  const vault = await openLocalKeyVault(null, wrappingKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vault.key, new TextEncoder().encode('private history'))
  await setupSecurityCode(passphrase)
  await assert.rejects(getLocalDataWrappingKey(), /locked/)
  assert.equal(await unlock(passphrase), true)
  const restored = await openLocalKeyVault(vault.record, await getLocalDataWrappingKey())
  assert.equal(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, restored.key, ciphertext)), 'private history')
  lock()
})

test('legacy six-digit codes still unlock, upgrade the KDF, and remove any old plaintext key copy', async () => {
  const publicKey = await generateAndStoreKeyPair()
  const privateKey = (await loadKeyPair()).privateKey
  const rawKey = await crypto.subtle.exportKey('pkcs8', privateKey)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode('123456'), 'PBKDF2', false, ['deriveKey'])
  const codeKey = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, codeKey, rawKey)
  stores.get('identity').set('keypair', { id: 'keypair', hasSecurityCode: true, pubKeyB64: publicKey, salt: bufToB64(salt), iv: bufToB64(iv), encryptedPrivateKey: bufToB64(ciphertext), privateKey })
  lock()
  await assert.rejects(loadKeyPair(), /locked/)
  assert.equal(await unlock('123456'), true)
  const record = stores.get('identity').get('keypair')
  assert.equal(record.iterations, 600000)
  assert.equal(record.privateKey, undefined)
  lock()
})
