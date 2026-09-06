-- Keep transaction types extensible. AutoMigrate replays this migration on
-- every startup, so narrowing the column back to a historical ENUM would fail
-- as soon as a newer feature has written its own transaction type.
-- The backend writeFistTx writes 'pvp_refund' in all refund paths such as match cancellation/tie settlement/timeout settlement, etc.
-- If the old enumeration does not contain this value, 1265 (Data truncated) will be triggered, causing the entire refund transaction to be rolled back——
-- The performance is "unable to cancel the match, no refund for draw/timeout, and the pledge is locked".
-- VARCHAR preserves every existing value and remains idempotent on replay.

USE e2eechat;

ALTER TABLE fist_transactions MODIFY COLUMN type VARCHAR(64) NOT NULL;
