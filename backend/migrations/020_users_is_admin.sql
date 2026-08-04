-- Restore users.is_admin.
--
-- The column was originally created by 013_slg_shared_ai.sql. That file was deleted
-- when the SLG feature was removed, but internal/service/identity.go still selects
-- is_admin on every authenticated request. Databases that had already run 013 kept
-- the column and carried on working; any database created afterwards never got it,
-- so every login failed with "Unknown column 'is_admin'".
--
-- Re-adding it here is safe for both: AutoMigrate treats MySQL 1060
-- (ER_DUP_FIELDNAME) as already-applied, so existing installs skip this silently.

USE e2eechat;

ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0;
