-- 修复：早期已存在的 ironfist_pvp_rooms 表缺少双上报仲裁列。
-- 008 用 CREATE TABLE IF NOT EXISTS，若表已由更早版本创建则不会补列，导致
-- SettlePVP 的 SELECT report_a/report_b 报 1054（结算始终失败）。此处用 ALTER 补齐。
-- ADD COLUMN 重复执行触发 1060，由 AutoMigrate 静默跳过（幂等）。

USE e2eechat;

ALTER TABLE ironfist_pvp_rooms ADD COLUMN report_a VARCHAR(16) NULL;
ALTER TABLE ironfist_pvp_rooms ADD COLUMN report_b VARCHAR(16) NULL;
