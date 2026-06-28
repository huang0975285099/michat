package model

import "time"

type FistAccount struct {
	UserID      uint64    `json:"user_id"`
	Balance     int64     `json:"balance"`
	TotalEarned uint64    `json:"total_earned"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type FistTransaction struct {
	ID           uint64    `json:"id"`
	UserID       uint64    `json:"user_id"`
	Amount       int64     `json:"amount"`        // 正数=收入，负数=支出
	BalanceAfter int64     `json:"balance_after"` // 本次变动后的余额快照
	Type         string    `json:"type"`
	RefID        *string   `json:"ref_id,omitempty"`
	Remark       *string   `json:"remark,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

type PveDailyProgress struct {
	UserID      uint64 `json:"user_id"`
	Date        string `json:"date"`
	WinsCount   int    `json:"wins_count"`
	EarnedToday int64  `json:"earned_today"`
}
