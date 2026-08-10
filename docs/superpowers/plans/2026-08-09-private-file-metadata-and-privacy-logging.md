# Private File Metadata and Privacy Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** End-to-end encrypt file names and MIME types for updated clients, and stop the backend and API/WebSocket reverse proxies from persisting user and communication identifiers in logs.

**Architecture:** Add an encrypted-metadata envelope beside the existing encrypted file-body envelope. The backend validates bounded opaque Base64 fields and forwards them without decryption, while temporarily retaining the legacy plaintext protocol for old senders. Replace Gin's default logger/recovery with request-data-free middleware, sanitize application logs, and disable Nginx API/WebSocket access logs.

**Tech Stack:** Go 1.25, Gin 1.12, Gorilla WebSocket, Vue/Quasar, browser Web Crypto P-256 ECDH + AES-256-GCM, Node's built-in test runner, Nginx.

## Global Constraints

- Do not change session-token storage, database retention, credentials/configuration, or message read-receipt behavior.
- New clients must never send plaintext \`filename\` or \`filetype\` in \`file_offer\`.
- \`filesize\` remains visible so the backend can enforce the existing 10 MB limit and chunk geometry.
- The backend must temporarily accept legacy plaintext file offers.
- Logs must not persist IP addresses, raw paths, query strings, headers, bodies, tokens, Chat IDs, message IDs, transfer IDs, room/game IDs, push IDs, public keys, signatures, or ciphertext.
- Existing file content encryption, transfer chunking, persistence, and burn-after-read behavior must remain unchanged.

---

## File Map

- \`backend/internal/ws/hub.go\`: accept, validate, and forward encrypted or legacy file metadata; remove identifying WebSocket logs.
- \`backend/internal/ws/file_validation_test.go\`: protocol validation/forwarding tests.
- \`backend/internal/ws/privacy_log_test.go\`: representative WebSocket log-redaction regression tests.
- \`frontend/src/services/crypto.js\`: expose private-key-injected message decryption for deterministic Web Crypto tests without IndexedDB.
- \`frontend/src/services/file-metadata.mjs\`: serialize, encrypt, decrypt, and validate file metadata.
- \`frontend/src/services/file-metadata.test.mjs\`: real Web Crypto round-trip, tamper, legacy, and no-plaintext tests.
- \`frontend/src/stores/chat.js\`: use encrypted metadata for outgoing offers and decrypt it before accepting incoming offers.
- \`frontend/package.json\`: add the focused file-metadata test command.
- \`backend/internal/middleware/privacylog.go\`: privacy-safe Gin access logging and panic recovery.
- \`backend/internal/middleware/privacylog_test.go\`: prove sensitive request fields never reach logs.
- \`backend/cmd/server/main.go\`: install privacy middleware instead of \`gin.Default()\`.
- \`backend/internal/service/identity.go\`, \`backend/internal/service/push.go\`, \`backend/internal/service/ironfist.go\`, \`backend/internal/handler/ironfist.go\`: remove identifiers and unsafe error details from operational logs.
- \`nginx-vhost/yb.yzs88.com.conf\`, \`frontend/nginx.conf\`: disable access logs for API and WebSocket locations.

---

### Task 1: Backend Encrypted File-Metadata Protocol

**Files:**
- Modify: \`backend/internal/ws/hub.go\`
- Modify: \`backend/internal/ws/file_validation_test.go\`

**Interfaces:**
- Produces: \`validateFileOffer(FileOfferPayload) (metadataMode, error)\`, where \`metadataMode\` is \`fileMetadataEncrypted\` or \`fileMetadataLegacy\`.
- Produces: \`newForwardFileOffer(from string, offer FileOfferPayload, timestamp int64, mode metadataMode) ForwardFileOffer\`.
- Consumes: existing \`expectedFileChunks\`, \`validFileMetadata\`, routing regexes, and file-size limits.

- [ ] **Step 1: Add failing encrypted-offer validation tests**

Add table tests that construct this new payload without plaintext metadata:

\`\`\`go
offer := FileOfferPayload{
    To: "2222-BBBB", TransferID: "11111111-1111-1111-1111-111111111111",
    MsgID: "loyw3v28-1-abc123", Filesize: 128, TotalChunks: 1,
    EphemeralPubKey: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 91)),
    IV: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 12)),
    MetadataEphemeralPubKey: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 91)),
    MetadataIV: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{4}, 12)),
    MetadataCiphertext: base64.StdEncoding.EncodeToString([]byte("authenticated metadata")),
}
mode, err := validateFileOffer(offer)
if err != nil || mode != fileMetadataEncrypted {
    t.Fatalf("encrypted offer rejected: mode=%v err=%v", mode, err)
}
\`\`\`

Cover missing one-of-three metadata fields, invalid Base64, IV length other than 12 bytes, decoded ciphertext over 1024 bytes, invalid size, and wrong chunk count. Keep a passing legacy case with \`Filename: "report.pdf"\` and \`Filetype: "application/pdf"\`.

- [ ] **Step 2: Run the focused backend test and verify failure**

Run from \`backend\`:

\`\`\`powershell
go test ./internal/ws -run 'TestValidate(FileOffer|EncryptedFileMetadata)' -count=1
\`\`\`

Expected: build failure because the new fields and validation function do not exist.

- [ ] **Step 3: Add a failing forwarding privacy test**

Create an encrypted offer whose legacy fields deliberately contain \`diagnosis-report.pdf\` and \`application/pdf\`, call \`newForwardFileOffer\`, marshal it, and assert:

\`\`\`go
if bytes.Contains(raw, []byte("diagnosis-report.pdf")) || bytes.Contains(raw, []byte("application/pdf")) {
    t.Fatalf("encrypted forward leaked plaintext metadata: %s", raw)
}
if !bytes.Contains(raw, []byte(offer.MetadataCiphertext)) {
    t.Fatal("encrypted metadata was not forwarded")
}
\`\`\`

Also assert the legacy forwarding result still contains legacy fields.

- [ ] **Step 4: Implement bounded dual-protocol validation**

Extend \`FileOfferPayload\` with:

\`\`\`go
MetadataEphemeralPubKey string \`json:"metadata_ephemeral_pub_key"\`
MetadataIV              string \`json:"metadata_iv"\`
MetadataCiphertext      string \`json:"metadata_ciphertext"\`
\`\`\`

Add \`metadataMode\`, a Base64 decoded-length helper, \`validateFileOffer\`, and a named \`ForwardFileOffer\` type. Treat the offer as encrypted only when all three encrypted metadata fields are present; reject partial encrypted envelopes instead of falling back to plaintext. Bounds are: ephemeral key 1–256 decoded bytes, IV exactly 12 decoded bytes, and ciphertext 1–1024 decoded bytes. For encrypted mode, ignore and omit any supplied plaintext metadata when forwarding. For legacy mode, retain the current filename length and extension checks.

Refactor \`handleFileOffer\` to call these helpers before friendship/database checks and forward the returned named structure.

- [ ] **Step 5: Run focused and package tests**

\`\`\`powershell
go test ./internal/ws -count=1
\`\`\`

Expected: all \`internal/ws\` tests pass.

- [ ] **Step 6: Commit the backend protocol**

\`\`\`powershell
git add backend/internal/ws/hub.go backend/internal/ws/file_validation_test.go
git commit -m "feat: relay encrypted file metadata"
\`\`\`

---

### Task 2: Frontend File-Metadata Encryption and Compatibility

**Files:**
- Create: \`frontend/src/services/file-metadata.mjs\`
- Create: \`frontend/src/services/file-metadata.test.mjs\`
- Modify: \`frontend/src/services/crypto.js\`
- Modify: \`frontend/src/stores/chat.js\`
- Modify: \`frontend/package.json\`

**Interfaces:**
- Produces: \`decryptMessageWithPrivateKey(payload, privateKey): Promise<string>\` in \`crypto.js\`.
- Produces: \`sealFileMetadata({ filename, filetype }, recipientPublicKey, encrypt?): Promise<object>\`.
- Produces: \`openFileOfferMetadata(payload, decrypt?): Promise<{ filename, filetype }>\`.
- Produces: \`validateFileMetadata(filename, filetype, filesize): void\`.
- Consumes: existing \`encryptMessage\`, \`decryptMessage\`, and Web Crypto.

- [ ] **Step 1: Write failing real-crypto metadata tests**

Generate a P-256 recipient key pair, export its public key with \`bufToB64\`, and test:

\`\`\`js
const sealed = await sealFileMetadata(
  { filename: '身份证照片.jpg', filetype: 'image/jpeg' },
  recipientPublicKey,
)
assert.equal('filename' in sealed, false)
assert.equal('filetype' in sealed, false)

const opened = await openFileOfferMetadata({ ...sealed, filesize: 123 }, payload =>
  decryptMessageWithPrivateKey(payload, recipient.privateKey))
assert.deepEqual(opened, { filename: '身份证照片.jpg', filetype: 'image/jpeg' })
\`\`\`

Flip one decoded ciphertext byte, re-encode it, and assert \`openFileOfferMetadata\` rejects authentication. Add tests for disallowed extensions, filenames over 255 UTF-8 bytes, partial encrypted envelopes, and a legacy \`{filename, filetype, filesize}\` offer.

- [ ] **Step 2: Run the focused frontend test and verify failure**

Run from \`frontend\`:

\`\`\`powershell
node --test src/services/file-metadata.test.mjs
\`\`\`

Expected: module-not-found failure for \`file-metadata.mjs\`.

- [ ] **Step 3: Extract private-key-injected decryption**

Move the current ECDH/AES decryption body into:

\`\`\`js
export async function decryptMessageWithPrivateKey(payload, privateKey) {
  // Import ephemeral SPKI, derive AES-256-GCM, authenticate/decrypt ciphertext.
}
\`\`\`

Keep \`decryptMessage(payload)\` by loading the IndexedDB key pair and delegating to the new function. Do not alter encryption parameters or stored-key behavior.

- [ ] **Step 4: Implement the focused metadata module**

\`sealFileMetadata\` validates locally, encrypts exactly \`JSON.stringify({ filename, filetype })\`, and returns only:

\`\`\`js
{
  metadata_ephemeral_pub_key: encrypted.ephemeralPubKey,
  metadata_iv: encrypted.iv,
  metadata_ciphertext: encrypted.ciphertext,
}
\`\`\`

\`openFileOfferMetadata\` rejects partial encrypted envelopes, decrypts/parses the new form, validates the parsed object, and otherwise validates/returns the legacy plaintext form. Errors are generic and do not embed metadata, ciphertext, or identifiers.

- [ ] **Step 5: Integrate outgoing and incoming file offers**

In \`sendFile\`, seal metadata before \`send('file_offer', ...)\`, spread the encrypted fields, and remove \`filename\`/\`filetype\` from the wire payload. Keep them only in the sender's in-memory/local encrypted record.

Make \`onFileOffer\` asynchronous. Resolve metadata through \`openFileOfferMetadata\` before creating \`fileTransfers[transfer_id]\` or sending \`file_accept\`. Store decrypted values only on the client transfer record. On failure, send the existing generic \`file_error\` and log only \`rejected invalid file offer\`.

- [ ] **Step 6: Add and run the focused package script**

Add:

\`\`\`json
"test:file-metadata": "node --test src/services/file-metadata.test.mjs"
\`\`\`

Run:

\`\`\`powershell
pnpm test:file-metadata
pnpm lint
\`\`\`

Expected: metadata tests and lint pass.

- [ ] **Step 7: Commit the frontend protocol**

\`\`\`powershell
git add frontend/src/services/crypto.js frontend/src/services/file-metadata.mjs frontend/src/services/file-metadata.test.mjs frontend/src/stores/chat.js frontend/package.json
git commit -m "feat: encrypt file transfer metadata"
\`\`\`

---

### Task 3: Privacy-Safe Gin Logging and Recovery

**Files:**
- Create: \`backend/internal/middleware/privacylog.go\`
- Create: \`backend/internal/middleware/privacylog_test.go\`
- Modify: \`backend/cmd/server/main.go\`

**Interfaces:**
- Produces: \`PrivacyLogger(out io.Writer) gin.HandlerFunc\`.
- Produces: \`PrivacyRecovery(out io.Writer) gin.HandlerFunc\`.
- Produces: context key \`request_id\` containing a server-generated 16-hex-character correlation ID.

- [ ] **Step 1: Write failing sensitive-request log tests**

Create a Gin test router with a buffer writer, both new middleware functions, and a templated route. Request:

\`\`\`text
GET /api/friends/1234-ABCD/read-receipts?token=secret-token
RemoteAddr: 203.0.113.42:4321
Authorization: Bearer secret-token
\`\`\`

Assert the log contains \`method=GET\`, \`route=/api/friends/:peerId/read-receipts\`, \`status=204\`, and a request ID matching \`[0-9a-f]{16}\`. Assert it excludes \`1234-ABCD\`, \`203.0.113.42\`, \`secret-token\`, \`Authorization\`, and the raw query.

Add an unmatched-route test that logs \`route=unmatched-route\`, and a panic test that returns 500 without logging the raw URL or headers.

- [ ] **Step 2: Run tests and verify failure**

\`\`\`powershell
go test ./internal/middleware -run 'TestPrivacy(Logger|Recovery)' -count=1
\`\`\`

Expected: build failure because the middleware functions do not exist.

- [ ] **Step 3: Implement privacy logger and recovery**

\`PrivacyLogger\` generates 8 random bytes with \`crypto/rand\`, hex-encodes them, stores the ID in Gin context, calls \`c.Next()\`, then logs one structured line containing only request ID, method, \`c.FullPath()\` or \`unmatched-route\`, status, and integer latency milliseconds.

\`PrivacyRecovery\` uses \`defer/recover\`, logs only \`request_id=<id> event=request-panic\`, and calls \`c.AbortWithStatus(http.StatusInternalServerError)\`. It must not use Gin's default recovery because that recovery can dump request details.

- [ ] **Step 4: Install the middleware**

Replace:

\`\`\`go
r := gin.Default()
\`\`\`

with:

\`\`\`go
r := gin.New()
r.Use(middleware.PrivacyLogger(log.Writer()), middleware.PrivacyRecovery(log.Writer()))
\`\`\`

Keep trusted-proxy, CORS, routing, and rate-limit behavior unchanged.

- [ ] **Step 5: Format and run tests**

\`\`\`powershell
gofmt -w internal/middleware/privacylog.go internal/middleware/privacylog_test.go cmd/server/main.go
go test ./internal/middleware ./cmd/server -count=1
\`\`\`

Expected: tests pass.

- [ ] **Step 6: Commit HTTP privacy logging**

\`\`\`powershell
git add backend/internal/middleware/privacylog.go backend/internal/middleware/privacylog_test.go backend/cmd/server/main.go
git commit -m "fix: remove request metadata from backend logs"
\`\`\`

---

### Task 4: Sanitize Application Logs and Disable Proxy Access Logs

**Files:**
- Create: \`backend/internal/ws/privacy_log_test.go\`
- Modify: \`backend/internal/ws/hub.go\`
- Modify: \`backend/internal/service/identity.go\`
- Modify: \`backend/internal/service/push.go\`
- Modify: \`backend/internal/service/ironfist.go\`
- Modify: \`backend/internal/handler/ironfist.go\`
- Modify: \`nginx-vhost/yb.yzs88.com.conf\`
- Modify: \`frontend/nginx.conf\`

**Interfaces:**
- Consumes: standard Go logger with constant event names and safe infrastructure errors.
- Produces: no new runtime API.

- [ ] **Step 1: Write a failing WebSocket log-redaction test**

Capture \`log.Writer()\` into a buffer, dispatch an unknown message from client \`1234-ABCD\` with attacker-controlled type \`private-room-99\`, and trigger an invalid chat-message destination containing \`9999-ZZZZ\`. Assert logs contain stable categories \`unknown message type\` and \`invalid recipient\`, but exclude all three attacker/user strings.

- [ ] **Step 2: Run the focused test and verify failure**

\`\`\`powershell
go test ./internal/ws -run TestWebSocketLogsRedactIdentifiers -count=1
\`\`\`

Expected: failure because current logs interpolate Chat IDs and message types.

- [ ] **Step 3: Replace identifying application logs**

In \`hub.go\`, replace interpolated logs with constant categories. Keep \`%v\` only for JSON, Redis, database, or network errors that do not contain user payload values; otherwise log the category alone:

\`\`\`go
log.Printf("[ws] invalid recipient")
log.Printf("[ws] message delivery rejected")
log.Printf("[ws] file chunk rejected")
log.Printf("[ws] unknown message type")
\`\`\`

Apply the same rule to account-deletion cleanup, push failure, IronFist settlement, and authority-handler logs: remove Chat ID, numeric user ID, room/game ID, and user-controlled values. Keep aggregate cron counts because they do not identify a user.

- [ ] **Step 4: Disable Nginx access logs for sensitive routes**

Add \`access_log off;\` inside each \`/api/\` and \`/ws\` location in both Nginx files. Do not change \`limit_req\`, \`limit_conn\`, proxy headers, upgrade headers, or timeouts.

- [ ] **Step 5: Run tests and static privacy scans**

\`\`\`powershell
go test ./internal/ws ./internal/service ./internal/handler -count=1
rg -n 'log\.(Printf|Println).*?(ChatID|chatID|MsgID|msgID|TransferID|transferID|RoomID|roomID|userID|recipientChatID|p\.To)' backend/internal backend/cmd
rg -n -C 8 'location /api/|location /ws|access_log off' nginx-vhost/yb.yzs88.com.conf frontend/nginx.conf
\`\`\`

Expected: tests pass; the sensitive-identifier log scan returns no matches; all four sensitive Nginx locations show \`access_log off;\` while retaining proxy/rate-limit directives.

- [ ] **Step 6: Commit application and proxy log privacy**

\`\`\`powershell
git add backend/internal/ws/hub.go backend/internal/ws/privacy_log_test.go backend/internal/service/identity.go backend/internal/service/push.go backend/internal/service/ironfist.go backend/internal/handler/ironfist.go nginx-vhost/yb.yzs88.com.conf frontend/nginx.conf
git commit -m "fix: redact communication metadata from logs"
\`\`\`

---

### Task 5: Full Regression and Release Verification

**Files:**
- Modify only if a verification failure reveals an in-scope defect in files listed above.

**Interfaces:**
- Consumes: encrypted metadata protocol and privacy logging from Tasks 1–4.
- Produces: verified release candidate; no new code API.

- [ ] **Step 1: Run all backend tests**

\`\`\`powershell
Set-Location backend
go test ./... -count=1
\`\`\`

Expected: all packages pass.

- [ ] **Step 2: Run all frontend test suites**

\`\`\`powershell
Set-Location frontend
pnpm test:file-metadata
pnpm test:call
pnpm test:ironfist
pnpm test:sugar-pop
pnpm test:version
\`\`\`

Expected: all Node test suites pass.

- [ ] **Step 3: Run frontend lint and four-platform builds**

\`\`\`powershell
pnpm lint
pnpm exec quasar build
pnpm exec quasar build -m electron
pnpm exec quasar build -m capacitor -T android --skip-pkg
pnpm exec tauri build --debug
\`\`\`

Expected: lint and Web, Electron, Android, and Tauri compilation complete without errors. If a native SDK/toolchain is unavailable, record the exact missing prerequisite and still complete every available build.

- [ ] **Step 4: Perform final plaintext and log scans**

\`\`\`powershell
Set-Location ..
rg -n 'file_offer' frontend/src backend/internal/ws
rg -n 'filename|filetype' backend/internal/ws/hub.go
rg -n 'log\.(Printf|Println).*?(ChatID|chatID|MsgID|msgID|TransferID|transferID|RoomID|roomID|userID|recipientChatID|p\.To)' backend
git diff --check
git status --short
\`\`\`

Inspect each file-offer hit and confirm new-client wire payloads have only encrypted metadata fields, while plaintext fields exist only in the documented legacy receive path. Expected: no sensitive identifier interpolation in logs, no whitespace errors, and only intended changes present.

- [ ] **Step 5: Commit any verification-only correction**

If verification required an in-scope correction, stage the complete in-scope file set; unchanged files are ignored by Git:

\`\`\`powershell
git add backend/internal/ws/hub.go backend/internal/ws/file_validation_test.go backend/internal/ws/privacy_log_test.go backend/internal/middleware/privacylog.go backend/internal/middleware/privacylog_test.go backend/cmd/server/main.go backend/internal/service/identity.go backend/internal/service/push.go backend/internal/service/ironfist.go backend/internal/handler/ironfist.go frontend/src/services/crypto.js frontend/src/services/file-metadata.mjs frontend/src/services/file-metadata.test.mjs frontend/src/stores/chat.js frontend/package.json nginx-vhost/yb.yzs88.com.conf frontend/nginx.conf
git commit -m "fix: complete private file metadata verification"
\`\`\`

Otherwise, do not create an empty commit.
