import assert from 'node:assert/strict'
import test from 'node:test'

import {
  b64ToBuf,
  bufToB64,
  decryptMessageWithPrivateKey,
} from './crypto.js'
import {
  buildEncryptedFileOfferPayload,
  openFileOfferMetadata,
  sealFileMetadata,
  validateFileMetadata,
} from './file-metadata.mjs'

async function recipientKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits'],
  )
  const publicKey = bufToB64(await crypto.subtle.exportKey('spki', pair.publicKey))
  return { pair, publicKey }
}

test('encrypts file metadata without plaintext wire fields and decrypts it for the recipient', async () => {
  const { pair, publicKey } = await recipientKeyPair()

  const sealed = await sealFileMetadata(
    { filename: '身份证照片.jpg', filetype: 'image/jpeg' },
    publicKey,
  )

  assert.equal('filename' in sealed, false)
  assert.equal('filetype' in sealed, false)
  assert.equal(JSON.stringify(sealed).includes('身份证照片.jpg'), false)
  assert.equal(JSON.stringify(sealed).includes('image/jpeg'), false)

  const opened = await openFileOfferMetadata(
    { ...sealed, filesize: 123 },
    payload => decryptMessageWithPrivateKey(payload, pair.privateKey),
  )
  assert.deepEqual(opened, { filename: '身份证照片.jpg', filetype: 'image/jpeg' })
})

test('rejects tampered encrypted file metadata', async () => {
  const { pair, publicKey } = await recipientKeyPair()
  const sealed = await sealFileMetadata(
    { filename: 'report.pdf', filetype: 'application/pdf' },
    publicKey,
  )
  const tampered = new Uint8Array(b64ToBuf(sealed.metadata_ciphertext))
  tampered[0] ^= 0x01

  await assert.rejects(() => openFileOfferMetadata(
    {
      ...sealed,
      filesize: 123,
      metadata_ciphertext: bufToB64(tampered),
    },
    payload => decryptMessageWithPrivateKey(payload, pair.privateKey),
  ))
})

test('rejects a partial encrypted metadata envelope instead of falling back to legacy fields', async () => {
  const { publicKey } = await recipientKeyPair()
  const sealed = await sealFileMetadata(
    { filename: 'report.pdf', filetype: 'application/pdf' },
    publicKey,
  )

  await assert.rejects(() => openFileOfferMetadata({
    ...sealed,
    metadata_iv: '',
    filename: 'fallback.pdf',
    filetype: 'application/pdf',
    filesize: 123,
  }))
})

test('validates decrypted filenames using UTF-8 length and final extension', () => {
  assert.throws(() => validateFileMetadata('malware.exe', 'application/octet-stream', 123))
  assert.throws(() => validateFileMetadata('文'.repeat(86) + '.pdf', 'application/pdf', 123))
  assert.doesNotThrow(() => validateFileMetadata('archive.tar.gz', 'application/gzip', 123))
})

test('accepts files up to 100MB and rejects larger files', () => {
  assert.doesNotThrow(() => validateFileMetadata('archive.zip', 'application/zip', 100 * 1024 * 1024))
  assert.throws(() => validateFileMetadata('archive.zip', 'application/zip', 100 * 1024 * 1024 + 1))
})

test('accepts legacy plaintext metadata during the compatibility window', async () => {
  const opened = await openFileOfferMetadata({
    filename: 'legacy.docx',
    filetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filesize: 456,
  })
  assert.deepEqual(opened, {
    filename: 'legacy.docx',
    filetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
})

test('builds a new-client file offer without plaintext metadata', () => {
  const payload = buildEncryptedFileOfferPayload({
    to: '2222-BBBB',
    transferId: '11111111-1111-1111-1111-111111111111',
    msgId: 'loyw3v28-1-abc123',
    filesize: 123,
    totalChunks: 1,
    ephemeralPubKey: 'file-public-key',
    iv: 'file-iv',
    burnAfterRead: true,
    sealedMetadata: {
      metadata_ephemeral_pub_key: 'metadata-public-key',
      metadata_iv: 'metadata-iv',
      metadata_ciphertext: 'metadata-ciphertext',
    },
  })

  assert.deepEqual(payload, {
    to: '2222-BBBB',
    transfer_id: '11111111-1111-1111-1111-111111111111',
    msg_id: 'loyw3v28-1-abc123',
    filesize: 123,
    total_chunks: 1,
    ephemeral_pub_key: 'file-public-key',
    iv: 'file-iv',
    burn_after_read: true,
    metadata_ephemeral_pub_key: 'metadata-public-key',
    metadata_iv: 'metadata-iv',
    metadata_ciphertext: 'metadata-ciphertext',
  })
  assert.equal('filename' in payload, false)
  assert.equal('filetype' in payload, false)
})
