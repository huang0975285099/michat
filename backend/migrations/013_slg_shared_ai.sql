-- SLG 共享 AI + 管理员重置
-- 1. 管理员标识（重置世界权限）
ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0;

-- 2. AI 领地需要存储地块等级/类型（AI 扩张时由服务端生成，客户端恢复守军用）
ALTER TABLE slg_territories
  ADD COLUMN tile_level INT NOT NULL DEFAULT 0,
  ADD COLUMN tile_type  VARCHAR(20) NOT NULL DEFAULT '';
