-- Read receipts are server-side tombstones that burn after reading: even if the reader subsequently logs out, the sender still needs to
-- Get first reading time. Therefore, the foreign key to users is removed, and only the "sender deleted" record is cleared when the account is deleted.
ALTER TABLE message_reads DROP FOREIGN KEY fk_mr_from;
ALTER TABLE message_reads DROP FOREIGN KEY fk_mr_to;

-- The first reading time is retained for the reader to retry idempotently; the sender stops login playback after confirming that the receipt has been written locally.
ALTER TABLE message_reads ADD COLUMN sender_applied TINYINT(1) NOT NULL DEFAULT 0 AFTER read_at;
ALTER TABLE message_reads ADD INDEX idx_pending_sender (msg_from, sender_applied);
