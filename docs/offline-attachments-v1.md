# Offline encrypted attachments v1

The attachment server is a temporary ciphertext mailbox, not a file backup.
It never accepts or stores a file key, filename, MIME type, thumbnail, caption,
or plaintext hash.

## Cryptographic contract

- Generate a fresh random 256-bit AES key for every attachment.
- Use 1 MiB plaintext chunks by default (accepted range: 256 KiB to 2 MiB).
- Generate a random 8-byte nonce prefix. The 12-byte AES-GCM nonce is the
  prefix followed by the unsigned 32-bit big-endian chunk index.
- Bind the marker, protocol version, attachment ID, chunk index, chunk count,
  file size, chunk size and current plaintext-chunk size as UTF-8 AES-GCM
  additional authenticated data, joined with `|` in that exact order.
- Every ciphertext chunk is exactly its plaintext length plus the 16-byte GCM
  authentication tag.
- Send the attachment ID, AES key, nonce prefix, filename, MIME type, sizes and
  chunk count only inside the existing chat E2EE envelope.
- The encrypted chat body uses the existing `yunmi.chat.text` v1 envelope and
  nests a `yunmi.chat.attachment` v1 object. Older clients show only a safe
  upgrade notice and never render the secret metadata JSON.

## Authenticated HTTP API

1. `POST /api/attachments` reserves an upload after validating friendship,
   single-file size and owner quota. It accepts only `recipient_chat_id`,
   `file_size`, `ciphertext_size`, `chunk_size`, and `chunk_count`.
2. `PUT /api/attachments/:id/chunks/:index` uploads one
   `application/octet-stream` ciphertext chunk. `X-Chunk-SHA256` is required.
3. `GET /api/attachments/:id` returns state plus uploaded/missing indexes to the
   owner. The recipient cannot observe an incomplete upload.
4. `POST /api/attachments/:id/complete` makes a fully uploaded attachment
   available for its recipient and starts the seven-day retention window.
5. `GET /api/attachments/:id/chunks/:index` downloads ciphertext only to the
   designated recipient. Responses are `no-store` and include the checksum.
6. `POST /api/attachments/:id/ack` is sent only after every chunk authenticates,
   decrypts, and the reconstructed file is durably stored locally. It deletes
   server ciphertext and releases quota.
7. `DELETE /api/attachments/:id` cancels an owner upload and deletes ciphertext.

Upload and acknowledgement operations are idempotent. A chunk index cannot be
replaced with different ciphertext; restart the attachment upload instead.

## Client recovery

- The sender persists the upload descriptor and random attachment key only
  inside its existing device-encrypted IndexedDB message record. The source
  body is encrypted and persisted in 1 MiB local chunks by the existing
  non-extractable local message key.
- Pause aborts the current HTTP request but keeps committed server chunks.
  Resume queries `missing_chunks` and uploads only those indexes.
- An upload interrupted by an application exit remains `pending` and resumes
  after message history and the current friend public key are loaded. A upload
  deliberately paused by the user stays paused after restart.
- Failed and paused offline attachment messages expose a manual retry/resume
  action. Active uploads are paused when the application security lock engages.
- Recipient ciphertext and decrypted local copies are persisted chunk by chunk.
  Restarting the application downloads only missing ciphertext chunks and does
  not assemble a large whole-file buffer during receipt.

## Retention

- Maximum plaintext file size: 500 MiB.
- Default active ciphertext quota per owner: 5 GiB.
- Incomplete upload expiry: 24 hours from initialization.
- Completed but unclaimed expiry: 7 days from completion.
- Consumed, canceled, and expired database tombstones: 7 days.
- Filesystem directories without a matching database row are removed by the
  hourly cleanup task.

All expiry decisions use server time. An expired download returns HTTP 410.
