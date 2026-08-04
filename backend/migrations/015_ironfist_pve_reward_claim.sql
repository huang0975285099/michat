-- PvE rewards must be bound to and consumed by a winning game that has been saved to prevent repeated calls to the reward interface.
-- NULL means the prize has not been claimed; the timestamp is used for auditing.

USE e2eechat;

-- Eligible defaults to 0, and historical records before the upgrade will not be re-claimed; new wins are explicitly set to 1 by ReportMatch.
ALTER TABLE ironfist_matches ADD COLUMN pve_reward_eligible TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE ironfist_matches ADD COLUMN pve_reward_claimed_at DATETIME(3) NULL;
ALTER TABLE ironfist_matches ADD KEY idx_im_pve_reward (user_id, pve_reward_eligible, pve_reward_claimed_at, id);
