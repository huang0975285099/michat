-- PvE 奖励必须绑定并消费一条已落库的胜局，阻止直接重复调用领奖接口。
-- NULL 表示尚未领奖；时间戳用于审计。

USE e2eechat;

-- eligible 默认 0，升级前的历史记录不会被重新领取；新胜局由 ReportMatch 显式置 1。
ALTER TABLE ironfist_matches ADD COLUMN pve_reward_eligible TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE ironfist_matches ADD COLUMN pve_reward_claimed_at DATETIME(3) NULL;
ALTER TABLE ironfist_matches ADD KEY idx_im_pve_reward (user_id, pve_reward_eligible, pve_reward_claimed_at, id);
