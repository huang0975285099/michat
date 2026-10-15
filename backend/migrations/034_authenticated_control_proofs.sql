ALTER TABLE message_deliveries ADD COLUMN recall_proof TEXT NULL;
ALTER TABLE message_reads ADD COLUMN proof TEXT NULL;
ALTER TABLE group_messages ADD COLUMN recall_proof TEXT NULL;
