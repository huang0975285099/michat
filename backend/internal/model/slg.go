package model

import (
	"encoding/json"
	"time"
)

// SlgWorld SLG 赛季世界
type SlgWorld struct {
	ID        uint64    `json:"id"`
	Seed      int       `json:"seed"`
	Season    int       `json:"season"`
	Status    string    `json:"status"` // active / ended
	CreatedAt time.Time `json:"created_at"`
}

// SlgPlayer SLG 玩家状态
type SlgPlayer struct {
	ID         uint64          `json:"id"`
	WorldID    uint64          `json:"world_id"`
	UserID     uint64          `json:"user_id"`
	ChatID     string          `json:"chat_id"`
	Nickname   string          `json:"nickname"`
	SpawnX     int             `json:"spawn_x"`
	SpawnY     int             `json:"spawn_y"`
	StateJSON  json.RawMessage `json:"state_json"` // 前端 GameState 存档格式
	LastActive time.Time       `json:"last_active"`
	CreatedAt  time.Time       `json:"created_at"`
}

// SlgTerritory SLG 领地归属
type SlgTerritory struct {
	ID          uint64    `json:"id"`
	WorldID     uint64    `json:"world_id"`
	X           int       `json:"x"`
	Y           int       `json:"y"`
	OwnerChatID string    `json:"owner_chat_id"`
	OwnerName   string    `json:"owner_name"`
	IsCity      bool      `json:"is_city"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// TerritoryView 返回给前端的最简领地视图（减少传输量）
type TerritoryView struct {
	X           int    `json:"x"`
	Y           int    `json:"y"`
	OwnerChatID string `json:"owner_chat_id"`
	OwnerName   string `json:"owner_name"`
	IsCity      bool   `json:"is_city"`
	TileLevel   int    `json:"tile_level,omitempty"`
	TileType    string `json:"tile_type,omitempty"`
}

// PlayerBrief 返回给前端的其他玩家摘要（地图标记/在线列表用）
type PlayerBrief struct {
	ChatID   string `json:"chat_id"`
	Nickname string `json:"nickname"`
	SpawnX   int    `json:"spawn_x"`
	SpawnY   int    `json:"spawn_y"`
	CityLv   int    `json:"city_lv"`
	Online   bool   `json:"online"`
}

// PathPoint 地图坐标点（行军路径用）
type PathPoint struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// MarchUnit 部队快照中的单个作战单位。字段对应前端 core/battle.js#resolveBattle 的
// unit 入参形状；服务端只存转不解析（与领地 claim 一致的信任模型）。
type MarchUnit struct {
	Key       string          `json:"key"`
	Name      string          `json:"name"`
	Atk       float64         `json:"atk"`
	Def       float64         `json:"def"`
	Int       float64         `json:"int"`
	Spd       float64         `json:"spd"`
	Troops    float64         `json:"troops"`
	TroopType string          `json:"troopType"`
	Quality   string          `json:"quality,omitempty"`
	Lv        int             `json:"lv,omitempty"`
	Skills    json.RawMessage `json:"skills,omitempty"`
}

// MarchView 返回给前端的在途部队视图（Join/GetWorld 全量下发，含自己与他人的行军/出征）
type MarchView struct {
	MarchUID    string      `json:"march_uid"`
	OwnerChatID string      `json:"owner_chat_id"`
	OwnerName   string      `json:"owner_name"`
	Intent      string      `json:"intent"`
	From        PathPoint   `json:"from"`
	To          PathPoint   `json:"to"`
	Path        []PathPoint `json:"path"`
	DepartAtMs  int64       `json:"depart_at_ms"`
	ArriveAtMs  int64       `json:"arrive_at_ms"`
	Units       []MarchUnit `json:"units"`
	Status      string      `json:"status"`
}
