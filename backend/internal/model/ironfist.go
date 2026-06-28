package model

import "time"

// IronFistStats 用户对战统计（每人一行）
type IronFistStats struct {
	UserID           uint64    `json:"user_id"`
	PvpWins          int       `json:"pvp_wins"`
	PvpLosses        int       `json:"pvp_losses"`
	PvpDraws         int       `json:"pvp_draws"`
	PveWins          int       `json:"pve_wins"`
	PveLosses        int       `json:"pve_losses"`
	PveDraws         int       `json:"pve_draws"`
	CurrentWinStreak int       `json:"current_win_streak"`
	MaxWinStreak     int       `json:"max_win_streak"`
	TotalBattles     int       `json:"total_battles"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// 成就代号（与前端 ACHIEVEMENTS 列表保持一致）
const (
	AchievementFirstBattle    = "first_battle"    // 初出茅庐：完成 1 场对战
	AchievementHundredBattles = "hundred_battles" // 百战不殆：累计 100 场对战
	AchievementWinStreak5     = "win_streak_5"    // 连胜达人：连胜 5 场
	AchievementCounterMaster  = "counter_master"  // 反击大师：单场反击成功 3 次
	AchievementLowHpComeback  = "low_hp_comeback" // 残血翻盘：HP < 10 时获胜
	AchievementHighHpWin      = "high_hp_win"     // 稳操胜券：HP > 90 时获胜
)

// AllAchievements 全部成就代号
var AllAchievements = []string{
	AchievementFirstBattle,
	AchievementHundredBattles,
	AchievementWinStreak5,
	AchievementCounterMaster,
	AchievementLowHpComeback,
	AchievementHighHpWin,
}

// AchievementMeta 成就展示信息
type AchievementMeta struct {
	Code string `json:"code"`
	Name string `json:"name"`
	Desc string `json:"desc"`
}

// AchievementDefinitions 成就定义（代号 → 名称/条件），与文档第十九节第4点一致
var AchievementDefinitions = map[string]AchievementMeta{
	AchievementFirstBattle:    {Code: AchievementFirstBattle, Name: "初出茅庐", Desc: "完成 1 场对战"},
	AchievementHundredBattles: {Code: AchievementHundredBattles, Name: "百战不殆", Desc: "累计 100 场对战"},
	AchievementWinStreak5:     {Code: AchievementWinStreak5, Name: "连胜达人", Desc: "连胜 5 场"},
	AchievementCounterMaster:  {Code: AchievementCounterMaster, Name: "反击大师", Desc: "单场反击成功 3 次"},
	AchievementLowHpComeback:  {Code: AchievementLowHpComeback, Name: "残血翻盘", Desc: "HP < 10 时获胜"},
	AchievementHighHpWin:      {Code: AchievementHighHpWin, Name: "稳操胜券", Desc: "HP > 90 时获胜"},
}
