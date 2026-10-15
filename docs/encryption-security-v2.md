# Encryption security update

## Implemented protections

- Clearing an identity clears the unlocked private key, invalidates in-flight unlock/export operations, and stops the auto-lock timer.
- Device-protected private keys no longer store an extractable private CryptoKey alongside their encrypted backup. Legacy copies are removed when loaded or unlocked.
- New security codes are 12–128 characters and require letters and numbers. PBKDF2-SHA-256 uses 600,000 iterations. Existing six-digit codes remain readable and their KDF is upgraded after a successful unlock; their limited entropy cannot be improved without choosing a new code. Use **Profile → Security code → Change security code** to replace one.
- Local message and attachment keys are wrapped with AES-GCM using an HKDF-SHA-256 key derived from the private identity key. Locking clears the cached history key, plaintext message state and message object URLs. A locked identity cannot unwrap the stored history key.
- Legacy local ciphertext is migrated one record at a time. The migration keeps the previous key until all records are converted, marks converted records, and resumes after interruption. The final key record contains only a wrapped key. Web Locks serialize migration between updated browser tabs.
- Text, replies, offline attachment metadata, group content and realtime file offers carry an ECDSA-P256 signature inside their encrypted content. The signed context binds sender, recipient/group, message ID, message kind and burn flag. Realtime file metadata additionally binds transfer ID, ephemeral key, IV, size and chunk count.
- Peer identity keys are pinned per local account using first-use trust. A later key substitution is rejected. The chat header exposes a shared identity safety number for comparison over an independently trusted channel.

## Deployment and compatibility

This changes the client wire protocol. Release updated Windows, Android and web clients together. Both participants, and every receiving group member, must upgrade. New clients reject unsigned live messages; old clients cannot understand the new signed content envelope. Do not publish this as a mixed-client compatible update.

Close older running application instances and browser tabs before migrating their local history. Old implementations do not understand the wrapped-key record and must not continue writing to the same local database. Back up the identity through the existing backup UI before the coordinated update. Do not erase local history to perform the upgrade.

Update/restart the backend as well: realtime file metadata now permits up to 4,096 ciphertext bytes to accommodate the signature and bound file parameters. Unsigned offline ciphertext already received is retained in pending storage rather than accepted as authenticated or deleted. Old queued outgoing messages may need to be resent from the updated client.

## Additional hardening before release

- Call offers, answers, ICE and call controls are signed with the pinned participant identity. Signatures bind call ID, action and sequence; stale or replayed signaling is rejected using calibrated time.
- Group sending and incoming authentication require explicit approval of the exact active roster. Approval is signed locally, scoped to the account/group and replaced by the latest approved roster. Message signatures bind its shared roster fingerprint. Compare the entire roster fingerprint independently before approving; automatic approval is absent.
- Direct/group recalls and read receipts require author signatures. Read-triggered deletion uses the signed timestamp, not mutable server metadata. A server-only administrative deletion does not erase the local archive.
- Automatic sender attachment cleanup requires a verified read receipt. Unsigned file-transfer completion or server attachment status alone cannot authorize deletion of the local file copy.
- Locking invalidates attachment operations, aborts network requests, clears cached metadata/URLs and preserves encrypted pending downloads for retry. Old operations cannot resume merely because the application unlocks again.
- Session revocation closes matching local WebSockets immediately. Other instances check session validity periodically; this is bounded revocation, not instantaneous distributed invalidation.
- Web/Tauri CSP, Android backup exclusions, approved update origins and explicit deployment admin credentials add defense in depth.

The backend must apply migration `034_authenticated_control_proofs.sql` through startup migration before this release. Close older clients, deploy the backend and distribute the updated clients together. Every group must independently review and approve its roster. Old unsigned controls are not accepted as authenticated.

These roster approvals are not an administrator-authenticated membership protocol, global ordered membership epochs or MLS. A compromised server can still withhold/reorder traffic, present inconsistent rosters, or replay an old roster that remains the latest locally approved roster. Offline messages signed under another roster remain pending. Independent fingerprint comparison is necessary; this change does not remove that trust requirement.

The existing Windows/APK downloads have not been rebuilt or replaced by these source changes. Windows publisher signing requires a trusted signing certificate; the existing unsigned installer remains unsigned. Verify Android release certificate continuity and exercise two real clients before publishing. Production CSP and backup rules still require deployed-server/device verification.

## Remaining protocol limits

This update does **not** implement forward secrecy or post-compromise security. The transport still wraps content for a long-term recipient key, so a stolen identity private key can decrypt captured historical transport ciphertext. This needs a separately designed protocol migration using a reviewed implementation of authenticated prekeys and a ratchet, including asynchronous delivery, replay handling, groups, device restoration and version negotiation. Do not claim Signal-level protection based on the signed envelope.

First-use key pinning alone does not authenticate the initial server-provided key. Compare the complete safety number with the other participant outside this server before trusting that initial association. A changed pin fails closed; automatic re-trust is deliberately absent.

Neither an application lock nor a nonextractable CryptoKey protects against an attacker already executing arbitrary code in an unlocked application, or against a compromised operating system. Previously copied keys, old database copies and exported backups cannot be invalidated by this update.

Relevant protocol background: [Signal X3DH](https://signal.org/docs/specifications/x3dh/) and [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/).

## Checks

Follow-up regression fixes: calibrated control timestamps are integer milliseconds; fresh in-memory messages retain their chat identity; local deletion is separate from authenticated remote recall; failed group attachment persistence keeps its pending ciphertext and rolls back transient memory for retry. Unlock restoration keeps the lock overlay and defers recovery until history is loaded. Restored group trust triggers serialized pending-message retries. These paths are covered by `chat-recovery-regression.test.mjs` and included in `test:crypto-security`.

Local verification on 2026-10-13: 172 non-call frontend tests and 21 call-store tests passed; frontend lint, SPA build and the built inline-script CSP hash check passed. `go test ./...` and CGO-enabled race tests for WebSocket, handler and service packages passed with environment-dependent database tests skipped. An explicit isolated MySQL persistence test could not run because `127.0.0.1:3306` refused the connection. These are not substitutes for a deployed-server, Android/Windows or real two-client acceptance test.

Run `npm run test:crypto-security`, the existing group-crypto, offline-attachment, security-lock and i18n tests, frontend lint/build, and `go test ./internal/ws`. A release still needs two-client verification for normal and offline text, replies, group messages, voice/files, interrupted migration, lock/unlock and mixed-version rejection.
