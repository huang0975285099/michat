package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"

	"e2eechat/internal/model"
)

// SlgService 九州征途多人世界服务
type SlgService struct {
	db *sql.DB

	// 在线玩家：chatID → worldID。仅 WS slg_join/slg_leave 时写，
	// 广播领地变更时读。不加 Redis，进程内即可（单机部署够用；
	// 多实例需改为 Redis Set，当前阶段不涉及）。
	onlineMu sync.RWMutex
	online   map[string]uint64 // chatID → worldID
}

func NewSlgService(db *sql.DB) *SlgService {
	return &SlgService{db: db, online: make(map[string]uint64)}
}

// JoinResult 加入世界返回
type JoinResult struct {
	WorldID     uint64              `json:"world_id"`
	Seed        int                 `json:"seed"`
	Season      int                 `json:"season"`
	SpawnX      int                 `json:"spawn_x"`
	SpawnY      int                 `json:"spawn_y"`
	IsNewPlayer bool                `json:"is_new_player"`
	State       json.RawMessage     `json:"state,omitempty"` // 玩家上次存档（新玩家为空）
	Territories []model.TerritoryView `json:"territories"`
	Players     []model.PlayerBrief  `json:"players"`
}

// SaveStateRequest 保存玩家状态
type SaveStateRequest struct {
	State json.RawMessage `json:"state"`
}

// TerritoryUpdateRequest 领地变更
type TerritoryUpdateRequest struct {
	X         int    `json:"x"`
	Y         int    `json:"y"`
	IsCity    bool   `json:"is_city"`
	Action    string `json:"action"` // "claim" | "abandon"
}

// TerritoryChangeEvent 领地变更事件（WS 广播用）
type TerritoryChangeEvent struct {
	X           int    `json:"x"`
	Y           int    `json:"y"`
	OwnerChatID string `json:"owner_chat_id"`
	OwnerName   string `json:"owner_name"`
	IsCity      bool   `json:"is_city"`
	Action      string `json:"action"` // "claim" | "abandon"
}

// GetActiveWorld 获取当前活跃世界，没有则创建
func (s *SlgService) GetActiveWorld(ctx context.Context) (*model.SlgWorld, error) {
	var w model.SlgWorld
	err := s.db.QueryRowContext(ctx,
		`SELECT id, seed, season, status, created_at FROM slg_worlds WHERE status='active' ORDER BY id DESC LIMIT 1`,
	).Scan(&w.ID, &w.Seed, &w.Season, &w.Status, &w.CreatedAt)
	if err == nil {
		return &w, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("query active world: %w", err)
	}

	// 创建新世界：种子用当前时间戳
	seed := int(time.Now().UnixNano() & 0x7FFFFFFF)
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO slg_worlds (seed, season, status) VALUES (?, 1, 'active')`, seed)
	if err != nil {
		return nil, fmt.Errorf("create world: %w", err)
	}
	id, _ := res.LastInsertId()
	w = model.SlgWorld{ID: uint64(id), Seed: seed, Season: 1, Status: "active", CreatedAt: time.Now()}
	return &w, nil
}

// calcSpawnPoint 根据已有玩家数量计算新出生点
// 使用黄金角分布，在地图外圈（70%~90% 半径）均匀散布，保证玩家间有足够距离。
// 地图为 48×48，中心 (24,24)，最远距离 ≈ 33.94
func calcSpawnPoint(existingCount int) (int, int) {
	const mapW, mapH = 48, 48
	cx, cy := float64(mapW)/2, float64(mapH)/2
	maxDist := math.Hypot(cx, cy)
	// 半径在 0.72~0.88 之间，随玩家数微抖动避免完美同心圆
	radius := 0.80 * maxDist
	// 黄金角（137.5°）散布
	const goldenAngle = 2.39996323
	angle := float64(existingCount) * goldenAngle
	x := int(math.Round(cx + math.Cos(angle)*radius))
	y := int(math.Round(cy + math.Sin(angle)*radius))
	// 钳制到地图边界内
	if x < 1 { x = 1 }
	if y < 1 { y = 1 }
	if x >= mapW-1 { x = mapW - 2 }
	if y >= mapH-1 { y = mapH - 2 }
	return x, y
}

// Join 加入世界。返回世界种子、出生点、玩家存档与全图领地。
func (s *SlgService) Join(ctx context.Context, userID uint64, chatID, nickname string) (*JoinResult, error) {
	w, err := s.GetActiveWorld(ctx)
	if err != nil {
		return nil, err
	}

	// 查询是否已有玩家记录
	var (
		playerID  uint64
		spawnX    int
		spawnY    int
		stateJSON []byte
	)
	err = s.db.QueryRowContext(ctx,
		`SELECT id, spawn_x, spawn_y, state_json FROM slg_players WHERE world_id=? AND user_id=?`,
		w.ID, userID,
	).Scan(&playerID, &spawnX, &spawnY, &stateJSON)

	isNew := false
	if errors.Is(err, sql.ErrNoRows) {
		// 新玩家：分配出生点
		isNew = true
		// 统计当前世界已有玩家数，用于散布出生点
		var count int
		s.db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM slg_players WHERE world_id=?`, w.ID).Scan(&count)
		spawnX, spawnY = calcSpawnPoint(count)

		// 初始空状态 JSON（前端会发送完整存档）
		emptyState, _ := json.Marshal(map[string]any{"v": 0})
		res, err := s.db.ExecContext(ctx,
			`INSERT INTO slg_players (world_id, user_id, chat_id, nickname, spawn_x, spawn_y, state_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			w.ID, userID, chatID, nickname, spawnX, spawnY, emptyState)
		if err != nil {
			return nil, fmt.Errorf("create slg player: %w", err)
		}
		lastID, _ := res.LastInsertId()
		playerID = uint64(lastID)

		// 初始领地：出生点即主城
		s.db.ExecContext(ctx,
			`INSERT INTO slg_territories (world_id, x, y, owner_chat_id, owner_name, is_city)
			 VALUES (?, ?, ?, ?, ?, 1)`,
			w.ID, spawnX, spawnY, chatID, nickname)
	} else if err != nil {
		return nil, fmt.Errorf("query slg player: %w", err)
	}

	// 更新昵称与最后活跃时间
	s.db.ExecContext(ctx,
		`UPDATE slg_players SET nickname=?, last_active=NOW() WHERE id=?`,
		nickname, playerID)

	// 获取全图领地
	territories, err := s.GetTerritories(ctx, w.ID)
	if err != nil {
		return nil, err
	}

	// 获取玩家摘要
	players, err := s.GetPlayers(ctx, w.ID)
	if err != nil {
		return nil, err
	}

	result := &JoinResult{
		WorldID:     w.ID,
		Seed:        w.Seed,
		Season:      w.Season,
		SpawnX:      spawnX,
		SpawnY:      spawnY,
		IsNewPlayer: isNew,
		Territories: territories,
		Players:     players,
	}
	if len(stateJSON) > 0 && string(stateJSON) != `{"v":0}` {
		result.State = json.RawMessage(stateJSON)
	}

	// 标记在线
	s.onlineMu.Lock()
	s.online[chatID] = w.ID
	s.onlineMu.Unlock()

	return result, nil
}

// Leave 离开世界（标记离线）
func (s *SlgService) Leave(chatID string) {
	s.onlineMu.Lock()
	delete(s.online, chatID)
	s.onlineMu.Unlock()
}

// SetOnline 标记玩家在线（WS slg_join 时调用）。
// 若玩家已通过 HTTP Join 设置过 worldID 则保留；否则从 DB 查找。
func (s *SlgService) SetOnline(chatID string) {
	s.onlineMu.Lock()
	if _, ok := s.online[chatID]; ok {
		s.onlineMu.Unlock()
		return
	}
	s.onlineMu.Unlock()

	// 从 DB 查找玩家的世界（服务重启后 online map 清空的恢复路径）
	var worldID uint64
	err := s.db.QueryRowContext(context.Background(),
		`SELECT p.world_id FROM slg_players p
		 JOIN slg_worlds w ON w.id = p.world_id
		 WHERE p.chat_id=? AND w.status='active'
		 ORDER BY p.id DESC LIMIT 1`, chatID).Scan(&worldID)
	if err != nil {
		return // 玩家未加入任何世界，静默跳过
	}
	s.onlineMu.Lock()
	s.online[chatID] = worldID
	s.onlineMu.Unlock()
}

// IsOnline 检查玩家是否在线（在 SLG 世界中）
func (s *SlgService) IsOnline(chatID string) bool {
	s.onlineMu.RLock()
	_, ok := s.online[chatID]
	s.onlineMu.RUnlock()
	return ok
}

// GetWorldIDByChatID 获取玩家所在世界 ID（用于 WS 广播路由）
func (s *SlgService) GetWorldIDByChatID(chatID string) (uint64, bool) {
	s.onlineMu.RLock()
	wid, ok := s.online[chatID]
	s.onlineMu.RUnlock()
	return wid, ok
}

// GetOnlinePlayersInWorld 获取指定世界中的在线玩家 chatID 列表
func (s *SlgService) GetOnlinePlayersInWorld(worldID uint64) []string {
	s.onlineMu.RLock()
	defer s.onlineMu.RUnlock()
	var result []string
	for chatID, wid := range s.online {
		if wid == worldID {
			result = append(result, chatID)
		}
	}
	return result
}

// GetTerritories 获取世界全图领地
func (s *SlgService) GetTerritories(ctx context.Context, worldID uint64) ([]model.TerritoryView, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT x, y, owner_chat_id, owner_name, is_city FROM slg_territories WHERE world_id=?`,
		worldID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []model.TerritoryView
	for rows.Next() {
		var t model.TerritoryView
		var isCity int
		if err := rows.Scan(&t.X, &t.Y, &t.OwnerChatID, &t.OwnerName, &isCity); err != nil {
			return nil, err
		}
		t.IsCity = isCity == 1
		result = append(result, t)
	}
	return result, nil
}

// GetPlayers 获取世界所有玩家摘要
func (s *SlgService) GetPlayers(ctx context.Context, worldID uint64) ([]model.PlayerBrief, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT chat_id, nickname, spawn_x, spawn_y FROM slg_players WHERE world_id=?`,
		worldID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []model.PlayerBrief
	for rows.Next() {
		var p model.PlayerBrief
		if err := rows.Scan(&p.ChatID, &p.Nickname, &p.SpawnX, &p.SpawnY); err != nil {
			return nil, err
		}
		// 从 state_json 提取 cityLv（前端存档格式）
		p.Online = s.IsOnline(p.ChatID)
		result = append(result, p)
	}
	return result, nil
}

// SaveState 保存玩家状态
func (s *SlgService) SaveState(ctx context.Context, userID uint64, state json.RawMessage) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE slg_players SET state_json=?, last_active=NOW() WHERE user_id=? AND world_id=(
		  SELECT id FROM slg_worlds WHERE status='active' ORDER BY id DESC LIMIT 1
		)`,
		[]byte(state), userID)
	return err
}

// UpdateTerritory 更新领地归属（claim/abandon），返回变更事件供 WS 广播
func (s *SlgService) UpdateTerritory(ctx context.Context, userID uint64, chatID, nickname string, req *TerritoryUpdateRequest) (*TerritoryChangeEvent, error) {
	w, err := s.GetActiveWorld(ctx)
	if err != nil {
		return nil, err
	}

	// 验证玩家属于该世界
	var playerID uint64
	err = s.db.QueryRowContext(ctx,
		`SELECT id FROM slg_players WHERE world_id=? AND user_id=?`,
		w.ID, userID).Scan(&playerID)
	if err != nil {
		return nil, fmt.Errorf("player not in world: %w", err)
	}

	ev := &TerritoryChangeEvent{
		X:           req.X,
		Y:           req.Y,
		OwnerChatID: chatID,
		OwnerName:   nickname,
		IsCity:      req.IsCity,
		Action:      req.Action,
	}

	if req.Action == "abandon" {
		_, err = s.db.ExecContext(ctx,
			`DELETE FROM slg_territories WHERE world_id=? AND x=? AND y=? AND owner_chat_id=?`,
			w.ID, req.X, req.Y, chatID)
		if err != nil {
			return nil, err
		}
		ev.OwnerChatID = ""
		ev.OwnerName = ""
	} else {
		// claim：UPSERT（同一地块只能有一个领主）
		_, err = s.db.ExecContext(ctx,
			`INSERT INTO slg_territories (world_id, x, y, owner_chat_id, owner_name, is_city)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE owner_chat_id=VALUES(owner_chat_id), owner_name=VALUES(owner_name), is_city=VALUES(is_city), updated_at=NOW()`,
			w.ID, req.X, req.Y, chatID, nickname, req.IsCity)
		if err != nil {
			return nil, err
		}
	}

	return ev, nil
}
