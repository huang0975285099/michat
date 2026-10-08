-- Group attachments have no single recipient; allow recipient_user_id to be NULL.
ALTER TABLE attachments MODIFY COLUMN recipient_user_id BIGINT UNSIGNED NULL;
ALTER TABLE attachments DROP FOREIGN KEY fk_attachments_recipient;
ALTER TABLE attachments ADD CONSTRAINT fk_attachments_recipient
  FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE;
