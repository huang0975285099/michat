# Admin-Managed Group Chat and Group Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver end-to-end encrypted group conversations with text, image, and file messages. Groups are created and managed exclusively by the administrator through the existing admin panel (create/dissolve, add/remove members, mute members, delete messages, delete files). Users only chat and may recall their own messages and files; a muted member sees the group but cannot send. Group voice/video calls, burn-after-read, and read receipts are out of scope.

**Architecture:** One ciphertext per group message plus one per-member ECDH key envelope — a generalization of the existing attachment `fileKey` pattern. The sender encrypts content once with a random content key and wraps that key for each member's P-256 public key. The server validates membership, stores the ciphertext once, and fans out per-member delivery rows through a persistent group inbox that reuses the 7-day retention and applied-ack semantics of the 1:1 reliable inbox. Member lists come from admin assignment, so there are no invitations, roles, or user-side group mutations. Admin operations reuse the existing cookie-session admin API group and fan out server-originated events; admins see only ciphertext metadata (IDs, sizes, timestamps) and can delete but never read content. Muting is a per-group member flag (`muted_until`) enforced by the server on every group send. Old clients negotiate a `group` capability flag and never receive group frames.

**Tech Stack:** Go 1.25, Gin 1.12, Gorilla WebSocket, MySQL 8 migrations, Vue 3/Quasar/Pinia, browser Web Crypto P-256 ECDH + AES-256-GCM, Node built-in test runner.

## Global Constraints

- Groups are admin-managed only: users never create, rename, dissolve, join, or leave groups through the client API. The user-facing group API is read-only.
- Users may recall only their own group messages and files, within the same 144-hour window used by 1:1 recall. Admin deletion is a separate server-originated tombstone so the UI can distinguish "已撤回" from "管理员已删除".
- Admins may mute a member per group (`muted_until`, NULL = not muted). Muting is server-enforced: the hub rejects `group_message` sends from muted members with rejection code `muted`. Muted members still receive messages and may still recall their own messages/files; clients disable the composer for muted members.
- Removing a member takes effect immediately on the server: their pending `group_message_deliveries` rows are deleted (reconnect replays nothing), fan-out excludes them, and `GET /api/groups` no longer returns the group for them. The removed member's client hides the group from the conversation list; local history stays on-device but hidden. If the admin re-adds the member later, the group reappears, while messages sent during the absence remain undecryptable (their key envelopes never targeted the removed member).
- Group member presence (online/offline) is not displayed in v1: the existing `status` broadcast only covers friends, and group members need not be friends.
- No group voice/video calls, no burn-after-read in groups, no group read receipts. The group message protocol carries no `burn_after_read` field; the server rejects any group frame that includes it.
- The server stays zero-knowledge: it stores and forwards only opaque Base64 ciphertext, IVs, and key envelopes. The group name is the only new plaintext the server persists. Admin message/attachment listings expose metadata only (IDs, sender, sizes, timestamps, status) — never plaintext, keys, or filenames.
- 1:1 chat behavior, quotas, reliable-inbox semantics, and the DM attachment protocol must remain unchanged.
- Existing ID formats are untouched. New group ID namespace: `^G-[0-9A-F]{12}$` (14 chars). Existing `msg_id` validation `^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$` is reused.
- Max 10 members per group. Sender attachment quota stays 5 GB per account. Server message-inbox retention stays 7 days; group attachments expire after 3 days (DM attachments keep 7 days) to relieve the sender's quota. Per-member pending inbox quota stays 500 messages / 10 MB un-acked ciphertext.
- Each group message uses an independent random content key — no group/epoch key distribution or rotation in v1.
- No admin operation audit: group management actions (create/rename/mute/remove/dissolve/delete) are recorded nowhere, consistent with the privacy-first posture.
- The WebSocket auth frame gains an optional `group: true` capability flag; `auth_result` echoes it. Clients without the flag never receive group frames; their delivery rows wait in the inbox until they upgrade.
- Logs must not persist group IDs, member identifiers, message IDs, or ciphertext (existing privacy-log conventions).
- `group_event` frames are best-effort online notifications; clients re-sync state through HTTP (`GET /api/groups`). Only `group_message`, `group_recall`, and `group_delete` require reliable server persistence.

---

## File Map

- `backend/migrations/031_groups.sql`: groups, group_members, group_messages, group_message_deliveries tables and indexes.
- `backend/migrations/032_group_attachments.sql`: `attachments.group_db_id` column and `attachment_acks` table.
- `backend/migrations/migrate.go`: embed and register both new migrations.
- `backend/internal/service/group.go` (+ `group_test.go`): membership queries, fan-out persistence, self-recall, admin deletion.
- `backend/internal/handler/group.go` (+ `group_test.go`): read-only user API under the authenticated group.
- `backend/internal/handler/admin.go` (+ `admin_test.go`): admin group management endpoints (create/dissolve/members/messages/attachments).
- `backend/internal/handler/admin.html`: groups management section in the admin panel.
- `backend/internal/ws/hub.go`: `group_message` / `group_recall` / `group_delete` / `group_event` dispatch, fan-out, capability gating, persistent inbox replay.
- `backend/internal/ws/group_delivery_test.go`: fan-out, inbox, validation, recall, deletion, and log-redaction tests.
- `backend/internal/service/attachment.go`, `backend/internal/handler/attachment.go` (+ tests): group-scoped init, member download auth, per-member ack, all-acked release, admin deletion.
- `backend/cmd/server/main.go`: register group routes (user + admin).
- `frontend/src/services/group-crypto.mjs` (+ `group-crypto.test.mjs`): content-key encryption, per-member key wrapping, envelope validation.
- `frontend/src/services/api.js`: `groupApi` (read-only).
- `frontend/src/services/websocket.js`: capability flag, outbox/early-buffer support for group frames.
- `frontend/src/services/offline-attachment.mjs`: group attachment send/receive.
- `frontend/src/stores/group.js` (+ `group.test.mjs`): group list, member/public-key cache, event handling.
- `frontend/src/stores/chat.js`: group message send/receive/recall state machine reusing existing persistence.
- `frontend/src/pages/ChatsPage.vue`: merged DM + group conversation list.
- `frontend/src/pages/GroupChatPage.vue`: group chat UI (text/image/file input, self-recall; no call buttons, no burn toggle).
- `frontend/src/pages/GroupInfoPage.vue`: read-only member list and group-files panel entry.
- `frontend/src/router/index.js`: `/group/:groupId` route.
- `frontend/src/layouts/MainLayout.vue`: register group event listeners.
- `frontend/src/boot/chat-service.js`: push-notification routing to `/group/:id`.
- `frontend/src/i18n/index.js` (+ `index.test.mjs`): `groups` namespace, zh-CN and en-US parity.

---

### Task 1: Group Data Model, Read-Only User API, and Admin Group APIs

**Files:**
- Create: `backend/migrations/031_groups.sql`
- Create: `backend/internal/service/group.go`
- Create: `backend/internal/service/group_test.go`
- Create: `backend/internal/handler/group.go`
- Create: `backend/internal/handler/group_test.go`
- Modify: `backend/internal/handler/admin.go`
- Create: `backend/internal/handler/admin_group_test.go`
- Modify: `backend/migrations/migrate.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Produces: `type GroupService struct { ... }` with `CreateGroup(name string, memberChatIDs []string)`, `DissolveGroup(groupID string)`, `AddMembers(groupID string, chatIDs []string)`, `RemoveMember(groupID string, chatID string)`, `RenameGroup(groupID, name string)`, `MuteMember(groupID, chatID string, until time.Time)`, `UnmuteMember(groupID, chatID string)`, `ListGroupsWithCounts()`, `GetGroupDetail(groupID string)`, `ListMyGroups(chatID string)`, `IsGroupMember(groupID, chatID) bool`, `ActiveMemberChatIDs(groupID) []string`, `ListGroupMessageMetadata(groupID string, limit, offset)`, `DeleteGroupMessage(groupID, msgID string)`.
- Produces: `ErrGroupNotFound`, `ErrNotGroupMember`, `ErrGroupFull`, `ErrTooFewMembers`, `ErrDuplicateMember`, `ErrMessageNotFound`, `ErrNotMessageSender`, `ErrMemberMuted`.
- Consumes: existing `mysql.DB`, migration runner, admin auth (`adminAuth.Require()`).

- [ ] **Step 1: Write failing service tests**

Table tests against a migrated test database: admin creates a group with three members (creation rejects fewer than 2 distinct valid members with `ErrTooFewMembers`); `ListMyGroups` returns it for members only; `AddMembers` enforces the 10-member cap and rejects unknown Chat IDs and users without an uploaded public key (`is_ready=0`); `RemoveMember` sets `state='removed'` (history preserved, no re-add duplicates) and deletes that member's pending `group_message_deliveries` rows for the group so reconnect replays nothing; `DissolveGroup` removes all rows; `RenameGroup` updates the name; `ListMyGroups` excludes removed members; `ListGroupMessageMetadata` returns rows with `msg_id`, `sender_chat_id`, `sent_at`, `envelope_size`, tombstone flags and never a ciphertext column; `DeleteGroupMessage` requires the message to exist in that group. Mute lifecycle: `MuteMember` sets `muted_until`, `UnmuteMember` clears it, and an expired `muted_until` behaves as not muted; `GetGroupDetail` exposes per-member `muted_until`; a muted member still appears in `ListMyGroups` and `ActiveMemberChatIDs` (mute blocks sending only, never delivery).

- [ ] **Step 2: Run and verify failure**

```powershell
Set-Location backend
go test ./internal/service -run TestGroup -count=1
```

Expected: build failure, `GroupService` does not exist.

- [ ] **Step 3: Add the migration**

`031_groups.sql` (utf8mb4, InnoDB, `CREATE TABLE IF NOT EXISTS`, tolerate 1050/1061 error codes like existing migrations):

- `groups`: `id` PK, `group_id CHAR(14) UNIQUE`, `name VARCHAR(64)`, `created_at`, `updated_at`. No owner column — groups are admin-managed.
- `group_members`: `id` PK, `group_db_id`, `user_id`, `state ENUM('active','removed')`, `muted_until DATETIME(3) NULL` (NULL = not muted; past timestamps behave as not muted), `joined_at`, `UNIQUE uq_member(group_db_id, user_id)`. Removing a member sets `state='removed'`; muting sets `muted_until`.
- `group_messages`: `msg_id VARCHAR(64) PK`, `group_db_id`, `sender_chat_id CHAR(9)`, `iv VARCHAR(32)`, `ciphertext MEDIUMTEXT`, `envelope_size INT UNSIGNED`, `sent_at DATETIME(3)`, `recalled_at DATETIME(3) NULL` (user self-recall), `deleted_at DATETIME(3) NULL` (admin deletion), INDEX `(group_db_id, sent_at)`.
- `group_message_deliveries`: `(msg_id, member_chat_id) PK`, `key_envelope MEDIUMTEXT` (JSON: `ephemeral_pub_key`, `iv`, `key_ciphertext`), `applied_at DATETIME(3) NULL`, `removed_applied_at DATETIME(3) NULL` (shared by recall and delete tombstones), INDEX `idx_pending_member(member_chat_id, applied_at)`.

Embed 031/032 in `migrate.go` and append to the migration list.

- [ ] **Step 4: Implement the service, user handlers, and admin handlers**

`group_id` generated server-side as `G-` + 12 uppercase hex from `crypto/rand`, retried on unique collision. Membership mutations run in one transaction with `SELECT ... FOR UPDATE` on the `groups` row to serialize concurrent admin changes and message fan-out. `RemoveMember` additionally deletes the removed member's un-applied `group_message_deliveries` rows in the same transaction so reconnect never replays group frames to them. `CreateGroup`/`AddMembers` reject users without an uploaded public key (`is_ready=0`) — the sender cannot wrap key envelopes for them; group names are validated non-empty and ≤ 64 UTF-8 bytes.

User API (read-only, existing `auth` group, same JSON conventions as friend.go):

```
GET /api/groups            → my active groups: [{group_id, name, member_count, last_message_at}]
GET /api/groups/:groupId   → {group_id, name, created_at, members: [{chat_id, nickname, public_key, muted_until}]}
```

`GetGroupDetail` returns active members with `public_key` from `users` — required for sender-side encryption. Each member entry carries `muted_until` so a client can tell whether it is currently muted. Non-members receive 404 without existence details.

Admin API (existing `api.Group("/admin", adminAuth.Require())`, follow the robot-articles CRUD pattern):

```
POST   /api/admin/groups                              {name, member_chat_ids}
GET    /api/admin/groups                              all groups with member counts
GET    /api/admin/groups/:groupId                     detail + members (with states)
PUT    /api/admin/groups/:groupId                     {name}
POST   /api/admin/groups/:groupId/members             {chat_ids}
DELETE /api/admin/groups/:groupId/members/:chatId
PUT    /api/admin/groups/:groupId/members/:chatId/mute   {muted_until: RFC3339 | null}   mute / unmute
DELETE /api/admin/groups/:groupId                     dissolve
GET    /api/admin/groups/:groupId/messages?limit&before   ciphertext metadata only
DELETE /api/admin/groups/:groupId/messages/:msgId     tombstone + fan-out (Task 2)
GET    /api/admin/groups/:groupId/attachments         attachment metadata (Task 3)
DELETE /api/admin/groups/:groupId/attachments/:id     delete chunks (Task 3)
```

- [ ] **Step 5: Wire routes and run tests**

```powershell
go test ./internal/service ./internal/handler ./migrations -count=1
```

- [ ] **Step 6: Commit**

```powershell
git add backend/migrations/031_groups.sql backend/migrations/032_group_attachments.sql backend/migrations/migrate.go backend/internal/service/group.go backend/internal/service/group_test.go backend/internal/handler/group.go backend/internal/handler/group_test.go backend/internal/handler/admin.go backend/internal/handler/admin_group_test.go backend/cmd/server/main.go
git commit -m "feat: add admin-managed group data model and APIs"
```

---

### Task 2: WebSocket Fan-Out, Self-Recall, and Admin Deletion

**Files:**
- Modify: `backend/internal/ws/hub.go`
- Create: `backend/internal/ws/group_delivery_test.go`
- Modify: `backend/internal/service/group.go` (fan-out persistence helpers)
- Modify: `backend/internal/service/push.go` (group offline push)

**Interfaces:**
- Produces: `handleGroupMessage(from string, p GroupMessagePayload)` and `handleGroupRecall(from string, p GroupRecallPayload)` in the hub dispatch switch.
- Produces: `GroupService.AcceptGroupMessage(senderChatID, groupID, iv, ciphertext string, keyEnvelopes []KeyEnvelope) error` — single transaction: lock group, reject a muted sender (`ErrMemberMuted`), validate envelopes cover exactly the active members excluding the sender, per-member inbox quota, insert `group_messages` + N delivery rows.
- Produces: `GroupService.RecallGroupMessage(senderChatID, groupID, msgID) error` — verifies `sender_chat_id == from`, un-recalled, within 144h, then sets `recalled_at`.
- Produces: `GroupService.DeleteGroupMessage` fan-out hook invoked by the admin handler: sets `deleted_at` and enqueues `group_delete`.
- Produces: client capability: auth payload `{token, reliable_inbox, group}`; `auth_result` echoes `group`.
- Consumes: existing `ack` frames keyed by `msg_id`, Redis offline queue, `FlushPersistentInbox`, `PushService`.

- [ ] **Step 1: Write failing fan-out, recall, and deletion tests**

`group_delivery_test.go` with a two-member hub fixture:

1. Sender `1111-AAAA` sends `group_message` for group `G-000000000001`; both online members receive frames with the shared `iv`/`ciphertext` and each member's own `key_envelope` only (the other member's envelope is absent).
2. Offline member: delivery row exists with `applied_at IS NULL`; reconnect replays the frame with `replay: true`; `group_message_received_ack` sets `applied_at` and stops replay.
3. Validation rejects: malformed `group_id` (missing `G-` prefix), bad `msg_id`, IV not 12 decoded bytes, ciphertext over 8192 decoded bytes, envelope count mismatching active membership (rejection code `membership_changed` so clients refresh and re-encrypt), envelope `to` naming a non-member, duplicate `to`, any payload containing `burn_after_read`.
4. `ack` to the sender is `accepted`; resending the same `msg_id` yields `duplicate` without re-forwarding.
5. Self-recall: the sender's `group_recall` fans out a tombstone frame; members reply `group_recall_received_ack` and stop receiving replays. Recall from another member's connection is rejected; recall after 144h is rejected; recall of an admin-deleted message is rejected.
6. Admin deletion: invoking the admin delete hook fans out `group_delete`; members delete locally, ack `group_delete_received_ack`, and the tombstone replays for offline members exactly like recall. A message deleted by admin reports `deleted_at` and no longer accepts recalls.
7. Mute: a send from a muted member is rejected (`ack` status `rejected`, code `muted`) with no delivery rows and no fan-out; after `UnmuteMember` the same member sends successfully; an expired `muted_until` allows sending again; a muted member's `group_recall` still succeeds.

- [ ] **Step 2: Run and verify failure**

```powershell
go test ./internal/ws -run TestGroup -count=1
```

Expected: build failure, no `handleGroupMessage`.

- [ ] **Step 3: Implement hub dispatch and fan-out**

C→S frame:

```json
{"type":"group_message","payload":{"group_id":"G-...","msg_id":"...","iv":"...","ciphertext":"...",
  "key_envelopes":[{"to":"2222-BBBB","ephemeral_pub_key":"...","iv":"...","key_ciphertext":"..."}]}}
```

S→C per member (online, capability-gated):

```json
{"type":"group_message","payload":{"group_id":"G-...","from":"1111-AAAA","msg_id":"...","iv":"...","ciphertext":"...",
  "key_envelope":{"ephemeral_pub_key":"...","iv":"...","key_ciphertext":"..."},"ts":1699...,"replay":false}}
```

Flow: validate → `AcceptGroupMessage` (persist first; muted senders rejected with `ack` status `rejected`, code `muted`) → for each active member with the `group` capability, non-blocking `client.send <- frame`; members without capability or offline keep the delivery row (7-day expiry cleanup reuses the inbox cron). Offline members get `PushService.NotifyOfflineGroupMember(groupID, from)` — JPush body "您收到一条群消息" / extras `group_id` only, no content; pushes batch recipients and are rate-limited per group to protect the JPush quota. Sender ACK reuses the `ack` frame with `msg_id` (idempotent by `group_messages` PK). Group sends rate-limit through the existing per-connection `msgLimiter`. Cold-start reconciliation reuses `message_status_query`: its server handler resolves queried `msg_id`s against `group_messages` as well as `message_deliveries`, so the WS outbox keeps group messages consistent after restarts.

Self-recall (user): C→S `group_recall {group_id, msg_id}` → `RecallGroupMessage` (own message only, 144h) → fan out `group_recall {group_id, from, msg_id, recalled_at}` to members excluding the sender → member replies `group_recall_received_ack {group_id, msg_id}` setting `removed_applied_at`. If the recalled message carries an attachment, the sender's client also cancels its own upload through the existing owner `DELETE /api/attachments/:id` (the server cannot map ciphertext to an attachment).

Admin deletion (server-originated): admin handler calls `DeleteGroupMessage` → sets `deleted_at` → hub fans out `group_delete {group_id, msg_id, deleted_at}` → members reply `group_delete_received_ack {group_id, msg_id}`. Inbox replay sends whichever tombstone exists (recall or delete) until `removed_applied_at` is set.

Events: `group_event {group_id, event, member?, name?, muted_until?, ts}` where `event` ∈ `member_added|member_removed|renamed|dissolved|muted|unmuted`. Best-effort online fan-out only (no persistence); receivers re-pull `GET /api/groups`. On `dissolved`, the server rejects further sends with a `group_not_found` rejection code; clients keep local history and show a "群已解散" system notice. Sends from a removed member are rejected with code `not_group_member`; on `member_removed` for self, clients hide the group from the conversation list immediately (local history stays on-device but hidden).

- [ ] **Step 4: Redact logs and run package tests**

Add a log-redaction test asserting hub logs contain only constant categories (`group message rejected`, `group recall rejected`, `group delete rejected`) — no group IDs, Chat IDs, or envelope contents.

```powershell
go test ./internal/ws ./internal/service -count=1
```

- [ ] **Step 5: Commit**

```powershell
git add backend/internal/ws/hub.go backend/internal/ws/group_delivery_test.go backend/internal/service/group.go backend/internal/service/group_test.go backend/internal/service/push.go backend/internal/handler/admin.go
git commit -m "feat: fan out encrypted group messages with admin deletion"
```

---

### Task 3: Group Attachments and Admin Attachment Deletion

**Files:**
- Create: `backend/migrations/032_group_attachments.sql`
- Modify: `backend/internal/service/attachment.go`
- Modify: `backend/internal/service/attachment_test.go`
- Modify: `backend/internal/handler/attachment.go`
- Modify: `backend/internal/service/attachment_storage.go` (only if cleanup needs the new release condition)

**Interfaces:**
- Produces: `AttachmentService.InitGroupAttachment(ownerUserID, groupID string, shape AttachmentShape) (id string, err error)`.
- Produces: `attachment_acks(attachment_id CHAR(36), member_user_id BIGINT UNSIGNED, acked_at DATETIME(3), PRIMARY KEY(attachment_id, member_user_id))`.
- Produces: admin attachment listing/deletion endpoints under `/api/admin/groups/:groupId/attachments`.
- Consumes: existing chunk upload/complete/download paths, quota accounting, expiry cron (3 days for group attachments, 7 days for DM).

- [ ] **Step 1: Write failing tests**

1. Init with `group_id` creates an attachment with null `recipient_user_id`; init with both `group_id` and `recipient_chat_id` is rejected; init with neither is rejected.
2. An active group member (not owner) can `GET /:id/chunks/:index` while `status='available'`; a non-member and a removed member cannot (404 without leaking existence details).
3. `POST /:id/ack` from one member records an ack row; chunks are deleted only when every member that had a delivery row for the attachment's message has acked (all-acked → `status='consumed'`, chunks removed, tombstone kept 7 days); a single ack never deletes chunks.
4. Members added after the file was sent have no delivery row for that `msg_id` and are not counted toward the all-acked condition.
5. `DissolveGroup` also cancels every unconsumed group attachment: chunks removed, `status` set to a terminal deleted/expired state, `attachment_acks` rows deleted, sender quota released — no orphaned ciphertext remains on disk.
6. Admin `GET /api/admin/groups/:groupId/attachments` lists metadata only (id, status, sizes, created_at, expires_at — no filename, no key); admin `DELETE` removes chunks and marks the status deleted regardless of acks; owner `DELETE /:id` still releases the attachment; DM attachments keep the 7-day expiry while group attachments expire after 3 days; owner quota counts group attachments exactly like DM attachments.

- [ ] **Step 2: Run and verify failure**

```powershell
go test ./internal/service -run TestAttachmentGroup -count=1
```

- [ ] **Step 3: Implement**

`ALTER TABLE attachments ADD COLUMN group_db_id BIGINT UNSIGNED NULL` (+ index `(group_db_id, status, expires_at)`), create `attachment_acks`. The client links the attachment to its group message by `msg_id`; the server resolves "members with a delivery row for the message" from `group_message_deliveries` joined with `group_messages` on `msg_id`. Download auth becomes: `group_db_id` set → caller must be an active member; else legacy `recipient_user_id` check (unchanged). Group attachments set `expires_at` = completed_at + 3 days (DM unchanged at 7 days); the existing expiry cron handles both. The all-acked evaluation runs inside the ack transaction with the group row locked. `DissolveGroup` cancels the group's unconsumed attachments in the same transaction family (chunks deleted, acks cleared, quota released). Admin deletion emits a `group_event {event: 'attachment_deleted', attachment_id}` so members can mark local file messages expired.

- [ ] **Step 4: Run tests and commit**

```powershell
go test ./internal/service ./internal/handler -count=1
git add backend/migrations/032_group_attachments.sql backend/internal/service/attachment.go backend/internal/service/attachment_test.go backend/internal/handler/attachment.go backend/internal/service/attachment_storage.go backend/internal/handler/admin.go backend/internal/handler/admin_group_test.go backend/migrations/migrate.go
git commit -m "feat: group attachment sharing with admin deletion"
```

---

### Task 4: Admin Panel Group Management UI

**Files:**
- Modify: `backend/internal/handler/admin.html`

**Interfaces:**
- Consumes: Task 1 admin endpoints and Task 2/3 deletion hooks.
- Produces: a "群组管理" section in the existing admin panel; no new backend API.

- [ ] **Step 1: Add the groups section**

Follow the existing section pattern used by robot articles / intelligence companies in `admin.html`: a login-gated section listing groups (name, group ID, member count, last message time) with actions:

- Create group: name + member Chat ID list (textarea, one per line, validated `^\d{4}-[A-Z]{4}$`).
- Member management: open a group → member table with states (incl. mute status) → add members / remove member / mute with a duration picker or custom end time / unmute.
- Rename, dissolve (with confirm).
- Message moderation: paginated ciphertext-metadata table (msg_id, sender, time, size, recalled/deleted flags) with a delete action per row. The UI must not imply content is readable — a caption states "端到端加密：仅可删除，不可查看内容".
- Attachment moderation: metadata table (id, status, size, created, expires) with delete action.

- [ ] **Step 2: Verify against the live admin API**

Run the server with a test database, log in through `/admin`, create a group, add/remove members, delete a message and an attachment; confirm each action returns success and the corresponding WS fan-out fires (covered by Task 2/3 tests; here verify only the panel wiring).

- [ ] **Step 3: Commit**

```powershell
git add backend/internal/handler/admin.html
git commit -m "feat: admin panel group management"
```

---

### Task 5: Frontend Group Crypto Module

**Files:**
- Create: `frontend/src/services/group-crypto.mjs`
- Create: `frontend/src/services/group-crypto.test.mjs`
- Modify: `frontend/src/services/crypto.js` (only to export an AES content-key helper)
- Modify: `frontend/src/services/api.js` (`groupApi`: `list`, `detail`)
- Modify: `frontend/src/services/websocket.js` (auth capability, outbox, early buffer)
- Modify: `frontend/package.json`

**Interfaces:**
- Produces: `encryptGroupMessageContent(plaintext, memberPubKeys: Array<{chat_id, public_key}>, msgId) -> {iv, ciphertext, keyEnvelopes: [{to, ephemeral_pub_key, iv, key_ciphertext}]}`.
- Produces: `decryptGroupMessageContent({iv, ciphertext, key_envelope}, privateKey) -> string`.
- Produces: `wrapContentKey(contentKeyB64, memberPubKeyB64, msgId) -> KeyEnvelope` and `unwrapContentKey(keyEnvelope, privateKey) -> contentKeyB64` — both delegate to existing `encryptMessage` / `decryptMessageWithPrivateKey`.
- Consumes: existing Web Crypto helpers, `crypto.js` message primitives.

- [ ] **Step 1: Write failing real-crypto tests**

Generate three P-256 member key pairs; encrypt a text:

```js
const envelope = await encryptGroupMessageContent('群聊秘密', members, msgId)
assert.equal(envelope.keyEnvelopes.length, 3)
assert.ok(!JSON.stringify(envelope).includes('群聊秘密'))

for (const member of members) {
  const text = await decryptGroupMessageContent(
    { ...envelope, key_envelope: envelope.keyEnvelopes.find(e => e.to === member.chat_id) },
    member.privateKey)
  assert.equal(text, '群聊秘密')
}
```

Additional cases: a fourth member's private key fails to decrypt any envelope; tampering one ciphertext byte rejects authentication; the inner key-envelope plaintext contains `msg_id` binding so a swapped envelope from another message fails validation; inputs containing `burn_after_read` throw; the envelope list missing a member throws.

- [ ] **Step 2: Run and verify failure**

```powershell
Set-Location frontend
node --test src/services/group-crypto.test.mjs
```

Expected: module not found.

- [ ] **Step 3: Implement**

Content encryption: generate a random 256-bit AES-GCM `contentKey` + 12-byte IV (reusing the chunk-key helper style from `offline-attachment.mjs`), encrypt `JSON.stringify({marker: 'yunmi.group.text', version: 1, text})`. Key wrapping: `wrapContentKey` encrypts `JSON.stringify({marker: 'yunmi.group.key', version: 1, msg_id, content_key})` per member via `encryptMessage` (the msg_id binding inside the encrypted payload rejects envelope swapping). Add the read-only `groupApi` client. In `websocket.js`: send `group: true` in the auth frame, read `auth_result.group`; if `auth_result` lacks `group` (older server), the client hides all group UI until the server is upgraded; add `group_message`, `group_recall`, `group_delete`, `group_event` to the persistent outbox types (message/recall/delete only) and the early-buffer whitelist.

- [ ] **Step 4: Add the script, run tests and lint**

```json
"test:group-crypto": "node --test src/services/group-crypto.test.mjs"
```

```powershell
pnpm test:group-crypto
pnpm lint
```

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/services/group-crypto.mjs frontend/src/services/group-crypto.test.mjs frontend/src/services/crypto.js frontend/src/services/api.js frontend/src/services/websocket.js frontend/package.json
git commit -m "feat: group message crypto helpers"
```

---

### Task 6: Frontend Group Store and Group Chat UI

**Files:**
- Create: `frontend/src/stores/group.js`
- Create: `frontend/src/stores/group.test.mjs`
- Modify: `frontend/src/stores/chat.js`
- Modify: `frontend/src/pages/ChatsPage.vue`
- Create: `frontend/src/pages/GroupChatPage.vue`
- Create: `frontend/src/pages/GroupInfoPage.vue`
- Modify: `frontend/src/router/index.js`
- Modify: `frontend/src/layouts/MainLayout.vue`
- Modify: `frontend/src/boot/chat-service.js`
- Modify: `frontend/src/i18n/index.js`, `frontend/src/i18n/index.test.mjs`

**Interfaces:**
- Produces (group.js): state `groups`, `membersByGroup`, `mutedByGroup` (self mute state); actions `loadGroups()`, `loadGroupDetail(groupID)`, `getMemberPubKeys(groupID)`, `getGroupName(groupID)`, `amIMuted(groupID)`, `startListening()` for `group_event` (refresh cache; mark conversations dissolved; track `muted`/`unmuted` for self; drop the group from the local list on `member_removed` for self).
- Produces (chat.js): `sendGroupMessage(groupID, text, reply?)`, `onGroupMessage(payload)`, `recallGroupMessage(groupID, msgId)` (own messages/files only), `onGroupRecall(payload)`, `onGroupDelete(payload)`, reusing `addMessage`, `dbAddMessage`, lock-screen pending, ack timers, and the WS outbox.
- Consumes: `group-crypto.mjs`, `websocket.js`, `groupApi`, existing local message encryption.

- [ ] **Step 1: Write failing store tests**

`group.test.mjs` with a Pinia test instance and stubbed `groupApi`: `group_event` handlers refresh the cached group on `member_added`/`member_removed`/`renamed` and flag `dissolved`; a `member_removed` event for the current user drops the group from the list state and hides its conversation; the member public-key cache invalidates on membership events; `sendGroupMessage` encrypts via `encryptGroupMessageContent` and stores a `pending` message keyed under the group conversation; `recallGroupMessage` on a peer message throws; `onGroupDelete` removes the local message and shows an "管理员已删除" tombstone entry distinct from "已撤回". Mute state: a `muted` event (or detail flag) for the current user disables the composer state, `unmuted` re-enables it, and a server `muted` rejection marks the pending message failed with the muted reason.

- [ ] **Step 2: Run and verify failure**

```powershell
node --test src/stores/group.test.mjs
```

- [ ] **Step 3: Implement the stores**

`chat.js`: group conversations reuse the existing `messages[conversationId]` map keyed by group ID; message objects gain `groupId` and keep every existing field except `read`/`burnAfterRead` (never set for groups). Local persistence, genMsgId, ack-status flow, lock-screen `dbAddPending`, and recall limits (144h) are reused unchanged. `onGroupMessage` decrypts the member's key envelope → content key → plaintext; failure falls into the existing pending/decryption-failed paths. A `membership_changed` rejection triggers a member refresh, re-encryption, and one automatic resend; group failure codes (`muted`, `not_group_member`, `group_not_found`, `membership_changed`) map to i18n failure strings.

- [ ] **Step 4: Implement the pages**

- `ChatsPage.vue`: merge group conversations into the existing derived list (last message, unread = count of non-mine group messages since the local `lastReadAt` per conversation); group card shows `DeterministicAvatar` with the group name. No create-group or invite UI. Only groups present in the groups store appear; removed/dissolved groups are hidden even if local messages remain.
- `GroupChatPage.vue`: route `/group/:groupId`; message list and composer mirror ChatPage patterns (text, images sent as group attachments through the offline encrypted-attachment path, Task 7; file entry from Task 7; reply support) while omitting the voice/video call buttons, the burn-after-read toggle, and read receipts; the screenshot-deterrent watermark is reused. `onActivated` loads group detail + members (public keys) before enabling the composer; encryption targets `getMemberPubKeys()` minus self. The message action menu exposes recall only on `mine` messages within 144h. On `dissolved`, the composer disables with a "群已解散" notice. On self-removal, the page shows a "你已被移出群聊" notice, the composer disables, and the conversation disappears from the ChatsPage list (local history stays on-device). While self-muted (`muted_until` in the future), the composer disables with a "你已被禁言" notice showing the end time when timed; recall of own messages stays available.
- `GroupInfoPage.vue`: read-only — group name, member list with nicknames/Chat IDs, and the group-files panel entry (Task 7). No management actions.
- Router: add `/group/:groupId` with the same identity guard; `boot/chat-service.js` maps push extras `group_id` → `/group/:id`; `MainLayout.vue` registers `groupStore.startListening()` next to the existing listeners.
- i18n: add the `groups` namespace (zh-CN + en-US, same E2EE-aware copy style); extend `index.test.mjs` to assert key parity between locales.

- [ ] **Step 5: Run tests, lint, and commit**

```powershell
pnpm test:group-crypto
node --test src/stores/group.test.mjs
node --test src/i18n/index.test.mjs
pnpm lint
git add frontend/src/stores/group.js frontend/src/stores/group.test.mjs frontend/src/stores/chat.js frontend/src/pages/ChatsPage.vue frontend/src/pages/GroupChatPage.vue frontend/src/pages/GroupInfoPage.vue frontend/src/router/index.js frontend/src/layouts/MainLayout.vue frontend/src/boot/chat-service.js frontend/src/i18n/index.js frontend/src/i18n/index.test.mjs
git commit -m "feat: group chat UI with self-recall"
```

---

### Task 7: Group Files UI

**Files:**
- Modify: `frontend/src/services/offline-attachment.mjs`
- Modify: `frontend/src/services/offline-attachment.test.mjs`
- Modify: `frontend/src/stores/chat.js`
- Modify: `frontend/src/pages/GroupChatPage.vue`
- Modify: `frontend/src/pages/GroupInfoPage.vue`
- Modify: `frontend/src/pages/AttachmentStoragePage.vue`
- Modify: `frontend/src/i18n/index.js`

**Interfaces:**
- Produces: `createGroupAttachmentUpload(file, {msgId, groupId})` — chunk encryption identical to DM; the `fileKey` metadata envelope is delivered as a group message via `encryptGroupMessageContent`.
- Produces: `receiveGroupAttachmentMessage(payload, privateKey)` mirroring the DM download/ack flow with per-member ack.
- Consumes: Task 3 server semantics, existing chunk cache, space pre-check, and transfer pause/resume.

- [ ] **Step 1: Write failing tests**

DM upload flow reused with a group target: metadata JSON gains `group_id`; the attachment message decrypts for every member key pair; ack POST targets the group attachment; the local manifest records the group conversation so `AttachmentStoragePage` cleanup and stats group by group conversation ID.

- [ ] **Step 2: Run and verify failure**

```powershell
node --test src/services/offline-attachment.test.mjs
```

- [ ] **Step 3: Implement**

Group file sends always use the server-relayed offline transport (no realtime P2P path in groups); `POST /api/attachments` passes `group_id`; the send confirmation dialog copy explains the group semantics (members download independently; chunks release when every member has downloaded or after 3 days). `GroupChatPage` file entry reuses the DM progress/pause/resume UI. Recalling an own file message sends `group_recall` and also cancels the upload via the existing owner `DELETE /api/attachments/:id`. `GroupInfoPage` gains the "群文件" panel: a local list derived from `messages[groupId]` where the decrypted payload is an attachment message — filename, size, sender, download state, and per-file cleanup (local copy only, mirroring DM behavior). `attachment_deleted` events mark local file messages expired. `AttachmentStoragePage` shows group attachments within the same local-storage accounting keyed by conversation ID.

- [ ] **Step 4: Run tests, lint, and commit**

```powershell
node --test src/services/offline-attachment.test.mjs
pnpm lint
git add frontend/src/services/offline-attachment.mjs frontend/src/services/offline-attachment.test.mjs frontend/src/stores/chat.js frontend/src/pages/GroupChatPage.vue frontend/src/pages/GroupInfoPage.vue frontend/src/pages/AttachmentStoragePage.vue frontend/src/i18n/index.js
git commit -m "feat: group file transfer UI"
```

---

### Task 8: Full Regression and Release Verification

**Files:**
- Modify only if a verification failure reveals an in-scope defect in files listed above.

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: verified release candidate; no new code API.

- [ ] **Step 1: Run all backend tests**

```powershell
Set-Location backend
go test ./... -count=1
```

- [ ] **Step 2: Run all frontend test suites**

```powershell
Set-Location frontend
pnpm test:group-crypto
pnpm test:file-metadata
node --test src/stores/group.test.mjs
node --test src/services/offline-attachment.test.mjs
node --test src/i18n/index.test.mjs
pnpm test:call
pnpm test:ironfist
pnpm test:version
```

- [ ] **Step 3: Run frontend lint and four-platform builds**

```powershell
pnpm lint
pnpm exec quasar build
pnpm exec quasar build -m electron
pnpm exec quasar build -m capacitor -T android --skip-pkg
pnpm exec tauri build --debug
```

If a native SDK/toolchain is unavailable, record the missing prerequisite and still complete every available build.

- [ ] **Step 4: Static privacy and protocol scans**

```powershell
Set-Location ..
rg -n 'group_message|group_recall|group_delete|group_event' frontend/src backend/internal
rg -n 'burn_after_read' frontend/src/pages/GroupChatPage.vue frontend/src/stores/chat.js
rg -n 'log\.(Printf|Println).*?(groupID|GroupID|memberChatID|chatID)' backend/internal
git diff --check
git status --short
```

Inspect every group-frame hit to confirm: no `burn_after_read` on group paths, no plaintext message content outside the encrypted envelopes, no group identifiers in logs, no whitespace errors, and only intended changes present.

- [ ] **Step 5: Commit any verification-only correction**

If verification required an in-scope correction, stage the complete in-scope file set; otherwise do not create an empty commit.

```powershell
git add backend/migrations/031_groups.sql backend/migrations/032_group_attachments.sql backend/migrations/migrate.go backend/internal/service/group.go backend/internal/service/group_test.go backend/internal/handler/group.go backend/internal/handler/group_test.go backend/internal/handler/admin.go backend/internal/handler/admin_group_test.go backend/internal/handler/admin.html backend/internal/ws/hub.go backend/internal/ws/group_delivery_test.go backend/internal/service/attachment.go backend/internal/service/attachment_test.go backend/internal/handler/attachment.go backend/internal/service/attachment_storage.go backend/internal/service/push.go backend/cmd/server/main.go frontend/src/services/group-crypto.mjs frontend/src/services/group-crypto.test.mjs frontend/src/services/crypto.js frontend/src/services/api.js frontend/src/services/websocket.js frontend/src/services/offline-attachment.mjs frontend/src/services/offline-attachment.test.mjs frontend/src/stores/group.js frontend/src/stores/group.test.mjs frontend/src/stores/chat.js frontend/src/pages/ChatsPage.vue frontend/src/pages/GroupChatPage.vue frontend/src/pages/GroupInfoPage.vue frontend/src/pages/AttachmentStoragePage.vue frontend/src/router/index.js frontend/src/layouts/MainLayout.vue frontend/src/boot/chat-service.js frontend/src/i18n/index.js frontend/src/i18n/index.test.mjs frontend/package.json
git commit -m "fix: complete group chat verification"
```
