package model

import "time"

// IronFistStats user battle statistics (one row per person)
type IronFistStats struct {
	UserID           uint64    `json:"user_id"`
	PvpWins          int       `json:"pvp_wins"`
	PvpLosses        int       `json:"pvp_losses"`
	PvpDraws         int       `json:"pvp_draws"`
	PveWins          int       `json:"pve_wins"`
	PveLosses        int       `json:"pve_losses"`
	PveDraws         int       `json:"pve_draws"`
	FriendWins       int       `json:"friend_wins"`
	FriendLosses     int       `json:"friend_losses"`
	FriendDraws      int       `json:"friend_draws"`
	CurrentWinStreak int       `json:"current_win_streak"`
	MaxWinStreak     int       `json:"max_win_streak"`
	TotalBattles     int       `json:"total_battles"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// Achievement code (consistent with the front-end ACHIEVEMENTS list)
const (
	AchievementFirstBattle    = "first_battle"    //Fledgling: Complete 1 match
	AchievementHundredBattles = "hundred_battles" //Fight a hundred battles without danger: 100 battles in total
	AchievementWinStreak5     = "win_streak_5"    //Winning Streak: Win 5 games in a row
	AchievementCounterMaster  = "counter_master"  //Counterattack Master: Successfully counterattack 3 times in a single game
	AchievementLowHpComeback  = "low_hp_comeback" //Comeback with residual health: Win when HP < 10
	AchievementHighHpWin      = "high_hp_win"     //Guaranteed victory: Win when HP > 90
)

// AllAchievements All achievement codes
var AllAchievements = []string{
	AchievementFirstBattle,
	AchievementHundredBattles,
	AchievementWinStreak5,
	AchievementCounterMaster,
	AchievementLowHpComeback,
	AchievementHighHpWin,
}

// AchievementMeta achievement display information
type AchievementMeta struct {
	Code string `json:"code"`
	Name string `json:"name"`
	Desc string `json:"desc"`
}

// AchievementDefinitions achievement definition (code → name/condition), consistent with point 4 of Section 19 of the document
var AchievementDefinitions = map[string]AchievementMeta{
	AchievementFirstBattle:    {Code: AchievementFirstBattle, Name: "初出茅庐", Desc: "完成 1 场对战"},
	AchievementHundredBattles: {Code: AchievementHundredBattles, Name: "百战不殆", Desc: "累计 100 场对战"},
	AchievementWinStreak5:     {Code: AchievementWinStreak5, Name: "连胜达人", Desc: "连胜 5 场"},
	AchievementCounterMaster:  {Code: AchievementCounterMaster, Name: "反击大师", Desc: "单场反击成功 3 次"},
	AchievementLowHpComeback:  {Code: AchievementLowHpComeback, Name: "残血翻盘", Desc: "HP < 10 时获胜"},
	AchievementHighHpWin:      {Code: AchievementHighHpWin, Name: "稳操胜券", Desc: "HP > 90 时获胜"},
}
