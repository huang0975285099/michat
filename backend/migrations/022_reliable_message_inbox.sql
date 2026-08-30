-- Temporarily retain only E2EE ciphertext until the recipient confirms that it
-- has been persisted locally. Plaintext and private keys never reach this table.
ALTER TABLE message_deliveries
  ADD COLUMN encrypted_envelope MEDIUMTEXT NULL AFTER sent_at;

ALTER TABLE message_deliveries
  ADD COLUMN envelope_size INT UNSIGNED NOT NULL DEFAULT 0 AFTER encrypted_envelope;

ALTER TABLE message_deliveries
  ADD COLUMN recipient_applied_at DATETIME(3) NULL AFTER envelope_size;

-- A recall is a durable tombstone. It is retained until the recipient applies it
-- locally, including when the recipient was offline when the recall was issued.
ALTER TABLE message_deliveries
  ADD COLUMN recalled_at DATETIME(3) NULL AFTER recipient_applied_at;

ALTER TABLE message_deliveries
  ADD COLUMN recall_applied_at DATETIME(3) NULL AFTER recalled_at;

ALTER TABLE message_deliveries
  ADD INDEX idx_pending_recipient (msg_to, recipient_applied_at, sent_at);

ALTER TABLE message_deliveries
  ADD INDEX idx_pending_recall (msg_to, recall_applied_at, recalled_at);
