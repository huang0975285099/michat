# Private File Metadata and Privacy-Preserving Logging Design

**Date:** 2026-08-09

## Goal

Protect file names and MIME types with end-to-end encryption, and prevent application and reverse-proxy logs from persisting user identifiers or communication metadata.

This change deliberately does not modify session-token storage, database retention, credentials/configuration, message read receipts, or other broader privacy concerns.

## File Metadata Encryption

### Protocol

New clients encrypt a compact JSON metadata object before sending a file:

```json
{
  "filename": "report.pdf",
  "filetype": "application/pdf"
}
```

The metadata uses the same existing recipient-public-key encryption primitive as text messages, but with a fresh ephemeral key and IV. The encrypted file body continues to use its existing independent ephemeral key and IV.

The new `file_offer` payload contains:

- routing and transfer fields required by the server: `to`, `transfer_id`, `msg_id`, `filesize`, `total_chunks`, and `burn_after_read`;
- encrypted file-body parameters: the existing `ephemeral_pub_key` and `iv`;
- encrypted metadata parameters: `metadata_ephemeral_pub_key`, `metadata_iv`, and `metadata_ciphertext`;
- no plaintext `filename` or `filetype` from new clients.

`filesize` remains visible. The server needs it to enforce the 10 MB limit and validate encrypted chunk counts, and the ciphertext length would reveal approximately the same information without padding. Size-hiding padding is outside this change.

### Server Behavior

For the new protocol, the server:

- validates routing IDs, declared size, chunk count, and the presence and encoded-size bounds of encrypted metadata;
- does not decrypt or inspect file metadata;
- forwards encrypted metadata unchanged;
- never logs metadata values or ciphertext.

The server temporarily accepts the legacy plaintext `filename` and `filetype` fields so older installed clients can still transfer files. New clients always send the encrypted form. Privacy documentation must describe metadata protection as applying to updated clients. Legacy support can be removed after the minimum supported client version has advanced.

### Client Behavior

The receiving client decrypts metadata before accepting or displaying the file. It applies the existing filename length and extension allow-list checks after decryption. Invalid metadata causes a generic rejection without printing the decrypted values.

The sender performs the existing local filename and extension validation before encryption. File content encryption, transfer chunking, persistence, and burn-after-read behavior remain otherwise unchanged.

## Privacy-Preserving Logging

### Backend HTTP Access Logs

Replace `gin.Default()` with `gin.New()`, recovery middleware, and a small privacy access logger. Each completed request logs only:

- a freshly generated request/correlation ID;
- HTTP method;
- the Gin route template such as `/api/friends/:peerId/read-receipts`, never the concrete path;
- status code;
- elapsed time.

The logger does not persist client IP addresses, raw paths, query strings, headers, request or response bodies, tokens, Chat IDs, message IDs, transfer IDs, or room/game IDs. Unknown routes use the constant label `unmatched-route` instead of the raw requested path.

### Application and WebSocket Logs

Existing log statements are rewritten to retain the error category and underlying operational error where safe, while removing user- and communication-specific values. In particular, logs must not include:

- Chat IDs or database user IDs;
- message IDs;
- transfer IDs or file metadata;
- PvP room IDs or authoritative game IDs;
- peer identities from call, game, friendship, or presence events;
- authentication tokens, push registration IDs, public keys, signatures, or ciphertext.

Validation failures use stable categories such as `invalid recipient`, `invalid message id`, or `file chunk rejected`. Database/network errors may be logged, but SQL arguments and user-supplied payloads are not.

### Nginx

Disable access logging for `/api/` and `/ws` in both the edge virtual-host configuration and the frontend reverse proxy. IP-based rate limiting remains active in memory. Critical Nginx error logging remains available; request payloads and application identifiers are not intentionally added to it.

Static-asset access logging is outside this change.

## Compatibility and Failure Handling

- Updated sender to updated receiver: file name and MIME type are E2EE.
- Legacy sender to updated receiver: the updated receiver accepts the existing plaintext metadata protocol.
- Updated sender to legacy receiver: not guaranteed; releasing this change requires advancing the minimum supported client version or deploying the updated clients before relying on encrypted-metadata transfer.
- Metadata decryption or validation failure: reject the transfer with a generic user-visible error and a non-identifying server/client log category.
- Backend HTTP panic: Gin recovery still returns a server error; the privacy logger records only the route template and status.

## Testing

Backend tests verify that:

- encrypted metadata offers are accepted and forwarded byte-for-byte;
- plaintext metadata is not required for the new protocol;
- malformed or oversized encrypted metadata is rejected;
- legacy offers remain accepted during the compatibility window;
- privacy HTTP logs exclude raw paths, queries, IP addresses, tokens, and concrete identifiers;
- representative WebSocket validation failures do not emit Chat IDs, message IDs, transfer IDs, or room IDs.

Frontend tests verify that:

- file metadata encrypts and decrypts successfully;
- tampered metadata fails authentication;
- decrypted metadata is validated before display or file reconstruction;
- new outgoing offers contain no plaintext file name or MIME type;
- legacy incoming offers remain readable during the compatibility window.

Configuration checks verify that both Nginx layers disable access logs specifically for API and WebSocket locations without removing their existing proxying and rate limiting directives.

## Release Notes

Deploy the backend first because it accepts both protocol versions, then release all updated clients. Do not claim that file metadata is protected for legacy clients. Once the minimum supported version excludes legacy clients, remove plaintext metadata acceptance in a separate change.
