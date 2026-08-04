-- Fix: Earlier existing ironfist_pvp_rooms table was missing a double-reported arbitration column.
-- 008 Using CREATE TABLE IF NOT EXISTS, if the table has been created by an earlier version, the columns will not be added, resulting in
-- SettlePVP's SELECT report_a/report_b reports 1054 (settlement always fails). Use ALTER to complete this.
-- ADD COLUMN repeated execution triggers 1060, silently skipped by AutoMigrate (idempotent).

USE e2eechat;

ALTER TABLE ironfist_pvp_rooms ADD COLUMN report_a VARCHAR(16) NULL;
ALTER TABLE ironfist_pvp_rooms ADD COLUMN report_b VARCHAR(16) NULL;
