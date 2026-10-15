# Pending storage, read acknowledgments and call cleanup

## Pending ciphertext retention

The per-account IndexedDB pending store is limited to 2,000 records and a
64 MiB serialized-record budget. Individual records are limited to 512 KiB.
Records expire 30 days after their first local insertion. Server timestamps
do not control retention, and replaying a message does not restart its TTL.
Writes and recovery reads prune the store within a read/write transaction.
When a count or capacity limit is reached, the least recently updated records
are removed first. This policy applies to pending ciphertext, including paused
attachment descriptors; it does not delete saved chat history or file bodies.

Legacy records receive local retention timestamps on their first access.
Oversized writes and aborted transactions reject the save instead of reporting
that the pending ciphertext was persisted successfully.

Recovery discards definitively invalid encrypted content or signatures after
unlocking. Missing private keys, local key-vault failures, unavailable group
rosters or sender keys, account/lock transitions, network errors and storage
failures retain ciphertext for retry within the retention limits. Private-key
loading is outside the invalid-ciphertext classification step.

## Direct-message read acknowledgments

Only receipt IDs present in both the acknowledgment ID list and independently
verified signed receipts may leave the resend queue. Missing or invalid proofs,
wrong conversation bindings and failed local persistence leave the queue and
in-memory receipt flag untouched. Mixed batches confirm only valid receipts.
Burn countdown corrections use the signed timestamp, not the unsigned server
timestamp. This check authenticates the reader's proof; it cannot compel a
malicious relay to persist or deliver the receipt.

## Call signaling

Call cleanup releases outgoing sequence counters for that call ID. Terminal
signaling also releases its counters after signing/sending settles, including
busy rejections for calls that never become the active call. Outstanding signing
does not recreate released counters. An additional 10,000-slot limit bounds
outgoing allocation. Incoming replay records remain independent and retain
their existing expiration and size limit.

## Verification

Regression tests are in `pending-storage.test.mjs`,
`chat-control-security.test.mjs`, `chat-recovery-regression.test.mjs` and
`call-signaling.test.mjs`, included in `pnpm run test:crypto-security`.
`pnpm run test:call` exercises store cleanup and asynchronous terminal signing.
The broader security suite currently also reports an existing failure in
`group-membership-store.test.mjs` for the old failed-refresh blocking behavior;
this change does not modify group membership policy.
