package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"time"

	"e2eechat/internal/model"
)

// 错误定义
var (
	ErrWorldFull            = errors.New("world full")
	ErrNotAdmin             = errors.New("not admin")
	ErrTileOwnedByOther     = errors.New("tile owned by another player")
	ErrNotAdjacent          = errors.New("tile not adjacent to owned territory")
	ErrInvalidClaim         = errors.New("invalid claim request")
	ErrMarchNotFound        = errors.New("march not found")
	ErrMarchNotOwner        = errors.New("not the owner of this march")
	ErrMarchAlreadyResolved = errors.New("march battle already resolved")
)

// SlgService 九州征途多人世界服务
type SlgService struct {
	db *sql.DB

	// 在线玩家：chatID → worldID。仅 WS slg_join/slg_leave 时写，
	// 广播领地变更时读。不加 Redis，进程内即可（单机部署够用；
	// 多实例需改为 Redis Set，当前阶段不涉及）。
	onlineMu sync.RWMutex
	online   map[string]uint64 // chatID → worldID

	// 地图缓存：worldID → *SlgMap（从种子确定性生成，用于 AI 扩张判定）
	mapMu    sync.RWMutex
	mapCache map[uint64]*SlgMap

	// AI 扩张事件广播回调（由 main.go 注入，避免 service→ws 循环依赖）
	broadcastAI func(worldID uint64, ev *AITerritoryEvent)

	// worldCreateMu/joinMu 串行化"查后建"临界区（单进程部署假设，与 online map 一致），
	// 避免并发请求同时判断"条件未满足"而重复创建世界、或读到同一份玩家计数/出生点。
	worldCreateMu sync.Mutex
	joinMu        sync.Mutex
}

func NewSlgService(db *sql.DB) *SlgService {
	return &SlgService{
		db:       db,
		online:   make(map[string]uint64),
		mapCache: make(map[uint64]*SlgMap),
	}
}

// SetBroadcastAI 注入 AI 扩张事件广播函数（由 main.go 调用）
func (s *SlgService) SetBroadcastAI(fn func(worldID uint64, ev *AITerritoryEvent)) {
	s.broadcastAI = fn
}

// JoinResult 加入世界返回
type JoinResult struct {
	WorldID       uint64                `json:"world_id"`
	Seed          int                   `json:"seed"`
	Season        int                   `json:"season"`
	SpawnX        int                   `json:"spawn_x"`
	SpawnY        int                   `json:"spawn_y"`
	IsNewPlayer   bool                  `json:"is_new_player"`
	State         json.RawMessage       `json:"state,omitempty"` // 玩家上次存档（新玩家为空）
	Territories   []model.TerritoryView `json:"territories"`
	Players       []model.PlayerBrief   `json:"players"`
	ActiveMarches []model.MarchView     `json:"active_marches"`
}

// SaveStateRequest 保存玩家状态
type SaveStateRequest struct {
	State json.RawMessage `json:"state"`
}

// TerritoryUpdateRequest 领地变更
type TerritoryUpdateRequest struct {
	X      int    `json:"x"`
	Y      int    `json:"y"`
	IsCity bool   `json:"is_city"`
	Action string `json:"action"` // "claim" | "abandon"
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

// ── 玩家部队位置同步（出征/行军广播 + 玩家碰撞遭遇战）───────────────────────
// 战斗结果本身由客户端用 core/battle.js#resolveBattle 确定性计算（双方拿到同样的
// units+seed 必然算出同样结果），服务端只负责：校验归属、落库存证、广播给同世界玩家，
// 并在断线重连时把权威结果回放给本地校正——与领地 claim 的信任模型完全一致。

// MarchStartRequest 出征/行军开始上报
type MarchStartRequest struct {
	MarchUID   string            `json:"march_uid"`
	Intent     string            `json:"intent"` // attack | march
	From       model.PathPoint   `json:"from"`
	To         model.PathPoint   `json:"to"`
	Path       []model.PathPoint `json:"path"`
	DepartAtMs int64             `json:"depart_at_ms"`
	ArriveAtMs int64             `json:"arrive_at_ms"`
	Units      []model.MarchUnit `json:"units"`
}

// MarchEndRequest 行军结束上报（到达/驻扎/召回/被消灭后客户端主动清理）
type MarchEndRequest struct {
	MarchUID string `json:"march_uid"`
}

// MarchBattleRequest 玩家部队碰撞遭遇战结果上报。上报者必须是 MarchUID 一方的 owner；
// OtherMarchUID 是对方部队的 march_uid（不要求上报者是对方 owner）。
type MarchBattleRequest struct {
	MarchUID      string            `json:"march_uid"`
	Units         []model.MarchUnit `json:"units"`
	Status        string            `json:"status"` // active | done
	OtherMarchUID string            `json:"other_march_uid"`
	OtherUnits    []model.MarchUnit `json:"other_units"`
	OtherStatus   string            `json:"other_status"`
	Seed          int64             `json:"seed"`
}

// MarchEvent 部队事件（WS 广播用），action 为 start|end|battle。
// battle 事件一次性带出双方战后状态，接收端按 march_uid 是否属于自己分别处理。
type MarchEvent struct {
	Action      string            `json:"action"`
	MarchUID    string            `json:"march_uid"`
	OwnerChatID string            `json:"owner_chat_id"`
	OwnerName   string            `json:"owner_name"`
	Intent      string            `json:"intent,omitempty"`
	From        *model.PathPoint  `json:"from,omitempty"`
	To          *model.PathPoint  `json:"to,omitempty"`
	Path        []model.PathPoint `json:"path,omitempty"`
	DepartAtMs  int64             `json:"depart_at_ms,omitempty"`
	ArriveAtMs  int64             `json:"arrive_at_ms,omitempty"`
	Units       []model.MarchUnit `json:"units,omitempty"`
	Status      string            `json:"status,omitempty"`

	OtherMarchUID    string            `json:"other_march_uid,omitempty"`
	OtherOwnerChatID string            `json:"other_owner_chat_id,omitempty"`
	OtherUnits       []model.MarchUnit `json:"other_units,omitempty"`
	OtherStatus      string            `json:"other_status,omitempty"`
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

	// 并发首次创建保护：持锁后二次确认，避免多个请求同时判断"无 active 世界"
	// 而各自建出多个世界（玩家被短暂分裂到不同世界）。
	s.worldCreateMu.Lock()
	defer s.worldCreateMu.Unlock()
	err = s.db.QueryRowContext(ctx,
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

	// 初始化 AI 势力老巢（共享 AI：所有玩家看到同一份 AI）
	if err := s.initAITerritories(ctx, w.ID, seed); err != nil {
		return nil, fmt.Errorf("init AI: %w", err)
	}
	return &w, nil
}

// initAITerritories 在新建世界时放置 AI 势力老巢到 slg_territories 表。
// AI 老巢等级固定 AI_LAIR_LEVEL(6)，类型 plain，由服务端确定性地图生成位置。
func (s *SlgService) initAITerritories(ctx context.Context, worldID uint64, seed int) error {
	m := s.getOrBuildMap(worldID, seed)
	for i, f := range slgAiFactions {
		if i >= len(m.aiLairs) {
			break
		}
		lair := m.aiLairs[i]
		_, err := s.db.ExecContext(ctx,
			`INSERT INTO slg_territories (world_id, x, y, owner_chat_id, owner_name, is_city, tile_level, tile_type)
			 VALUES (?, ?, ?, ?, ?, 0, ?, 'plain')
			 ON DUPLICATE KEY UPDATE owner_chat_id=VALUES(owner_chat_id), tile_level=VALUES(tile_level), tile_type=VALUES(tile_type)`,
			worldID, lair.x, lair.y, f.id, f.name, aiLairLevel)
		if err != nil {
			return err
		}
	}
	return nil
}

// getOrBuildMap 获取或构建世界地图缓存（从种子确定性生成）
func (s *SlgService) getOrBuildMap(worldID uint64, seed int) *SlgMap {
	s.mapMu.RLock()
	if m, ok := s.mapCache[worldID]; ok {
		s.mapMu.RUnlock()
		return m
	}
	s.mapMu.RUnlock()

	m := NewSlgMap(seed)
	s.mapMu.Lock()
	s.mapCache[worldID] = m
	s.mapMu.Unlock()
	return m
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
	if x < 1 {
		x = 1
	}
	if y < 1 {
		y = 1
	}
	if x >= mapW-1 {
		x = mapW - 2
	}
	if y >= mapH-1 {
		y = mapH - 2
	}
	return x, y
}

// createNewPlayer 在世界未满员的前提下，原子地创建新玩家记录与初始主城领地。
// joinMu 串行化"查人数→判满→插入"，事务保证两条 INSERT 同生共死：
// 避免并发加入导致超员、拿到重复出生点，或主城领地插入失败被静默吞掉
// （原实现里 territory INSERT 的 err 完全没检查，失败后玩家会没有主城）。
func (s *SlgService) createNewPlayer(ctx context.Context, worldID, userID uint64, chatID, nickname string) (playerID uint64, spawnX, spawnY int, err error) {
	s.joinMu.Lock()
	defer s.joinMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	var count int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM slg_players WHERE world_id=?`, worldID).Scan(&count); err != nil {
		return 0, 0, 0, fmt.Errorf("count players: %w", err)
	}
	if count >= maxPlayersPerWorld {
		return 0, 0, 0, ErrWorldFull
	}
	spawnX, spawnY = calcSpawnPoint(count)

	emptyState, _ := json.Marshal(map[string]any{"v": 0})
	res, err := tx.ExecContext(ctx,
		`INSERT INTO slg_players (world_id, user_id, chat_id, nickname, spawn_x, spawn_y, state_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		worldID, userID, chatID, nickname, spawnX, spawnY, emptyState)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("create slg player: %w", err)
	}
	lastID, _ := res.LastInsertId()
	playerID = uint64(lastID)

	// 初始领地：出生点即主城
	if _, err = tx.ExecContext(ctx,
		`INSERT INTO slg_territories (world_id, x, y, owner_chat_id, owner_name, is_city, tile_level, tile_type)
		 VALUES (?, ?, ?, ?, ?, 1, 0, '')`,
		worldID, spawnX, spawnY, chatID, nickname); err != nil {
		return 0, 0, 0, fmt.Errorf("create initial territory: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return 0, 0, 0, fmt.Errorf("commit: %w", err)
	}
	return playerID, spawnX, spawnY, nil
}

// Join 加入世界。返回世界种子、出生点、玩家存档与全图领地。
// 世界玩家上限 maxPlayersPerWorld(5)，满后返回 ErrWorldFull（不创建新世界）。
// 已在该世界的老玩家始终可以重返。
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
		isNew = true
		playerID, spawnX, spawnY, err = s.createNewPlayer(ctx, w.ID, userID, chatID, nickname)
		if err != nil {
			return nil, err
		}
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

	// 获取全图在途部队（自己 + 他人的出征/行军，供客户端渲染与自我校正）
	marches, err := s.GetActiveMarches(ctx, w.ID)
	if err != nil {
		return nil, err
	}

	result := &JoinResult{
		WorldID:       w.ID,
		Seed:          w.Seed,
		Season:        w.Season,
		SpawnX:        spawnX,
		SpawnY:        spawnY,
		IsNewPlayer:   isNew,
		Territories:   territories,
		Players:       players,
		ActiveMarches: marches,
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

// GetTerritories 获取世界全图领地（含 AI 领地的 tile_level/tile_type）
func (s *SlgService) GetTerritories(ctx context.Context, worldID uint64) ([]model.TerritoryView, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT x, y, owner_chat_id, owner_name, is_city, tile_level, tile_type FROM slg_territories WHERE world_id=?`,
		worldID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []model.TerritoryView
	for rows.Next() {
		var t model.TerritoryView
		var isCity int
		if err := rows.Scan(&t.X, &t.Y, &t.OwnerChatID, &t.OwnerName, &isCity, &t.TileLevel, &t.TileType); err != nil {
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
		// claim 校验（client-authoritative 战斗结果目前无法完全验证，这里堵住明显的伪造/越权路径）：
		// - 主城归属只在 Join() 时确定，claim 请求一律不许携带 is_city=true（否则可伪造"占领主城"）
		// - 目标地块若已属于另一名真人玩家，拒绝——游戏本身不支持攻打玩家领地（client 的
		//   isOtherPlayerTile 也会拦，这里是服务端兜底，防止绕过前端直接打接口）
		// - 目标必须与本人已有领地相邻，拒绝隔空/远距离伪造占领请求
		if req.IsCity {
			return nil, ErrInvalidClaim
		}
		var curOwner string
		err = s.db.QueryRowContext(ctx,
			`SELECT owner_chat_id FROM slg_territories WHERE world_id=? AND x=? AND y=?`,
			w.ID, req.X, req.Y).Scan(&curOwner)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("query tile owner: %w", err)
		}
		if curOwner != "" && curOwner != chatID && !isAIFactionID(curOwner) {
			return nil, ErrTileOwnedByOther
		}
		var adjacent int
		err = s.db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM slg_territories WHERE world_id=? AND owner_chat_id=? AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?`,
			w.ID, chatID, req.X-1, req.X+1, req.Y-1, req.Y+1).Scan(&adjacent)
		if err != nil {
			return nil, fmt.Errorf("check adjacency: %w", err)
		}
		if adjacent == 0 {
			return nil, ErrNotAdjacent
		}

		// claim：UPSERT（同一地块只能有一个领主）
		_, err = s.db.ExecContext(ctx,
			`INSERT INTO slg_territories (world_id, x, y, owner_chat_id, owner_name, is_city)
			 VALUES (?, ?, ?, ?, ?, 0)
			 ON DUPLICATE KEY UPDATE owner_chat_id=VALUES(owner_chat_id), owner_name=VALUES(owner_name), is_city=0, updated_at=NOW()`,
			w.ID, req.X, req.Y, chatID, nickname)
		if err != nil {
			return nil, err
		}
	}

	return ev, nil
}

// StartMarch 出征/行军开始：落库存证 + 返回广播事件。同 march_uid 重复上报按最新数据覆盖
// （幂等，允许客户端断线重连后补发）。
func (s *SlgService) StartMarch(ctx context.Context, userID uint64, chatID, nickname string, req *MarchStartRequest) (*MarchEvent, error) {
	w, err := s.GetActiveWorld(ctx)
	if err != nil {
		return nil, err
	}
	var playerID uint64
	if err := s.db.QueryRowContext(ctx,
		`SELECT id FROM slg_players WHERE world_id=? AND user_id=?`,
		w.ID, userID).Scan(&playerID); err != nil {
		return nil, fmt.Errorf("player not in world: %w", err)
	}

	pathJSON, err := json.Marshal(req.Path)
	if err != nil {
		return nil, err
	}
	unitsJSON, err := json.Marshal(req.Units)
	if err != nil {
		return nil, err
	}

	_, err = s.db.ExecContext(ctx,
		`INSERT INTO slg_marches
		   (world_id, march_uid, owner_chat_id, owner_name, intent, from_x, from_y, to_x, to_y,
		    path_json, depart_at_ms, arrive_at_ms, units_json, status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
		 ON DUPLICATE KEY UPDATE
		   owner_name=VALUES(owner_name), intent=VALUES(intent),
		   from_x=VALUES(from_x), from_y=VALUES(from_y), to_x=VALUES(to_x), to_y=VALUES(to_y),
		   path_json=VALUES(path_json), depart_at_ms=VALUES(depart_at_ms), arrive_at_ms=VALUES(arrive_at_ms),
		   units_json=VALUES(units_json), status='active', updated_at=NOW()`,
		w.ID, req.MarchUID, chatID, nickname, req.Intent,
		req.From.X, req.From.Y, req.To.X, req.To.Y,
		string(pathJSON), req.DepartAtMs, req.ArriveAtMs, string(unitsJSON))
	if err != nil {
		return nil, err
	}

	from, to := req.From, req.To
	return &MarchEvent{
		Action: "start", MarchUID: req.MarchUID, OwnerChatID: chatID, OwnerName: nickname,
		Intent: req.Intent, From: &from, To: &to, Path: req.Path,
		DepartAtMs: req.DepartAtMs, ArriveAtMs: req.ArriveAtMs, Units: req.Units, Status: "active",
	}, nil
}

// EndMarch 行军结束（到达/驻扎/召回/清理）：标记 done。只允许清理自己的 march。
func (s *SlgService) EndMarch(ctx context.Context, userID uint64, chatID string, req *MarchEndRequest) (*MarchEvent, error) {
	w, err := s.GetActiveWorld(ctx)
	if err != nil {
		return nil, err
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE slg_marches SET status='done', updated_at=NOW() WHERE world_id=? AND march_uid=? AND owner_chat_id=?`,
		w.ID, req.MarchUID, chatID)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrMarchNotFound
	}
	return &MarchEvent{Action: "end", MarchUID: req.MarchUID, OwnerChatID: chatID, Status: "done"}, nil
}

// ReportMarchBattle 玩家部队碰撞遭遇战结果上报。req.MarchUID 必须是上报者自己的部队；
// req.OtherMarchUID 是对方部队（无需上报者是其 owner）。两条记录须都是 active 才会落地
// （幂等：任一方已被结算过则视为重复上报，直接返回 ErrMarchAlreadyResolved，调用方据此
// 跳过重复广播——最先落库的那次上报才是权威结果）。
func (s *SlgService) ReportMarchBattle(ctx context.Context, userID uint64, chatID string, req *MarchBattleRequest) (*MarchEvent, error) {
	w, err := s.GetActiveWorld(ctx)
	if err != nil {
		return nil, err
	}

	var mineOwner, mineStatus string
	if err := s.db.QueryRowContext(ctx,
		`SELECT owner_chat_id, status FROM slg_marches WHERE world_id=? AND march_uid=?`,
		w.ID, req.MarchUID).Scan(&mineOwner, &mineStatus); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrMarchNotFound
		}
		return nil, err
	}
	if mineOwner != chatID {
		return nil, ErrMarchNotOwner
	}
	var otherOwner, otherStatus string
	if err := s.db.QueryRowContext(ctx,
		`SELECT owner_chat_id, status FROM slg_marches WHERE world_id=? AND march_uid=?`,
		w.ID, req.OtherMarchUID).Scan(&otherOwner, &otherStatus); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrMarchNotFound
		}
		return nil, err
	}
	if mineStatus != "active" || otherStatus != "active" {
		return nil, ErrMarchAlreadyResolved
	}

	unitsJSON, err := json.Marshal(req.Units)
	if err != nil {
		return nil, err
	}
	otherUnitsJSON, err := json.Marshal(req.OtherUnits)
	if err != nil {
		return nil, err
	}
	status := req.Status
	if status != "active" && status != "done" {
		status = "done"
	}
	otherStatusOut := req.OtherStatus
	if otherStatusOut != "active" && otherStatusOut != "done" {
		otherStatusOut = "done"
	}

	if _, err := s.db.ExecContext(ctx,
		`UPDATE slg_marches SET units_json=?, status=?, updated_at=NOW() WHERE world_id=? AND march_uid=?`,
		string(unitsJSON), status, w.ID, req.MarchUID); err != nil {
		return nil, err
	}
	if _, err := s.db.ExecContext(ctx,
		`UPDATE slg_marches SET units_json=?, status=?, updated_at=NOW() WHERE world_id=? AND march_uid=?`,
		string(otherUnitsJSON), otherStatusOut, w.ID, req.OtherMarchUID); err != nil {
		return nil, err
	}

	return &MarchEvent{
		Action: "battle", MarchUID: req.MarchUID, OwnerChatID: chatID,
		Units: req.Units, Status: status,
		OtherMarchUID: req.OtherMarchUID, OtherOwnerChatID: otherOwner,
		OtherUnits: req.OtherUnits, OtherStatus: otherStatusOut,
	}, nil
}

// GetActiveMarches 获取世界内全部在途部队（自己 + 他人），供 Join/GetWorld 全量下发
func (s *SlgService) GetActiveMarches(ctx context.Context, worldID uint64) ([]model.MarchView, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT march_uid, owner_chat_id, owner_name, intent, from_x, from_y, to_x, to_y,
		        path_json, depart_at_ms, arrive_at_ms, units_json, status
		 FROM slg_marches WHERE world_id=? AND status='active'`,
		worldID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []model.MarchView
	for rows.Next() {
		var (
			mv                  model.MarchView
			pathJSON, unitsJSON string
		)
		if err := rows.Scan(&mv.MarchUID, &mv.OwnerChatID, &mv.OwnerName, &mv.Intent,
			&mv.From.X, &mv.From.Y, &mv.To.X, &mv.To.Y,
			&pathJSON, &mv.DepartAtMs, &mv.ArriveAtMs, &unitsJSON, &mv.Status); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(pathJSON), &mv.Path); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(unitsJSON), &mv.Units); err != nil {
			return nil, err
		}
		result = append(result, mv)
	}
	return result, nil
}

// isAIFactionID 判断 chat_id 字段是否实际是 AI 势力 id（AI 领地也存在 slg_territories.owner_chat_id 里）
func isAIFactionID(id string) bool {
	for _, f := range slgAiFactions {
		if f.id == id {
			return true
		}
	}
	return false
}

// ── AI 扩张定时器（服务端权威，所有玩家共享同一份 AI）──────────────────────────

// StartAITicker 启动 AI 扩张定时器：每 aiTickRealSeconds(60) 真实秒执行一次。
// 对每个活跃世界，加载全图领地，运行各 AI 势力的一次扩张判定，
// 将新占领地块写入 slg_territories 并通过 WS 广播给在线玩家。
func (s *SlgService) StartAITicker() {
	go func() {
		ticker := time.NewTicker(time.Duration(aiTickRealSeconds) * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			s.tickAllWorlds()
		}
	}()
}

// tickAllWorlds 遍历所有活跃世界，执行 AI 扩张
func (s *SlgService) tickAllWorlds() {
	ctx := context.Background()
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, seed FROM slg_worlds WHERE status='active'`)
	if err != nil {
		return
	}
	type worldInfo struct {
		id   uint64
		seed int
	}
	var worlds []worldInfo
	for rows.Next() {
		var wi worldInfo
		rows.Scan(&wi.id, &wi.seed)
		worlds = append(worlds, wi)
	}
	rows.Close()

	for _, w := range worlds {
		s.tickAIWorld(ctx, w.id, w.seed)
	}
}

// tickAIWorld 执行单个世界的 AI 扩张
func (s *SlgService) tickAIWorld(ctx context.Context, worldID uint64, seed int) {
	m := s.getOrBuildMap(worldID, seed)

	// 加载全图领地，构建 ownerMap 和 isCityMap
	rows, err := s.db.QueryContext(ctx,
		`SELECT x, y, owner_chat_id, is_city FROM slg_territories WHERE world_id=?`,
		worldID)
	if err != nil {
		return
	}
	ownerMap := make(map[string]string)
	isCityMap := make(map[string]bool)
	for rows.Next() {
		var x, y int
		var ownerChatID string
		var isCity int
		rows.Scan(&x, &y, &ownerChatID, &isCity)
		ownerMap[key2d(x, y)] = ownerChatID
		isCityMap[key2d(x, y)] = isCity == 1
	}
	rows.Close()

	// 每个存活 AI 势力执行一次扩张
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	for i, f := range slgAiFactions {
		if i >= len(m.aiLairs) {
			break
		}
		lair := m.aiLairs[i]
		ev := m.RunAIExpansionForFaction(f, lair.x, lair.y, ownerMap, isCityMap, rng)
		if ev == nil {
			continue
		}
		// 持久化到 DB
		_, err := s.db.ExecContext(ctx,
			`INSERT INTO slg_territories (world_id, x, y, owner_chat_id, owner_name, is_city, tile_level, tile_type)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?)
			 ON DUPLICATE KEY UPDATE owner_chat_id=VALUES(owner_chat_id), owner_name=VALUES(owner_name),
			   tile_level=VALUES(tile_level), tile_type=VALUES(tile_type), updated_at=NOW()`,
			worldID, ev.X, ev.Y, f.id, f.name, ev.Level, ev.TileType)
		if err != nil {
			continue
		}
		// 更新内存 map（供后续势力判定使用，避免同一 tick 内重复占领）
		ownerMap[key2d(ev.X, ev.Y)] = f.id

		// 广播给在线玩家
		if s.broadcastAI != nil {
			s.broadcastAI(worldID, ev)
		}
	}
}

// ── 管理员重置 ──────────────────────────────────────────────────────────────

// IsAdmin 检查用户是否为管理员
func (s *SlgService) IsAdmin(ctx context.Context, userID uint64) (bool, error) {
	var isAdmin int
	err := s.db.QueryRowContext(ctx,
		`SELECT is_admin FROM users WHERE id=?`, userID).Scan(&isAdmin)
	if err != nil {
		return false, err
	}
	return isAdmin == 1, nil
}

// ResetWorld 管理员重置当前世界：标记为 ended，删除所有玩家与领地。
// 下次 Join 时 GetActiveWorld 会创建新世界（新种子 + 新 AI 老巢）。
func (s *SlgService) ResetWorld(ctx context.Context, userID uint64) error {
	isAdmin, err := s.IsAdmin(ctx, userID)
	if err != nil {
		return fmt.Errorf("check admin: %w", err)
	}
	if !isAdmin {
		return ErrNotAdmin
	}

	w, err := s.GetActiveWorld(ctx)
	if err != nil {
		return err
	}

	// 标记世界结束
	_, err = s.db.ExecContext(ctx,
		`UPDATE slg_worlds SET status='ended' WHERE id=?`, w.ID)
	if err != nil {
		return fmt.Errorf("end world: %w", err)
	}

	// 删除领地与玩家记录
	s.db.ExecContext(ctx, `DELETE FROM slg_territories WHERE world_id=?`, w.ID)
	s.db.ExecContext(ctx, `DELETE FROM slg_players WHERE world_id=?`, w.ID)

	// 清理地图缓存与在线状态
	s.mapMu.Lock()
	delete(s.mapCache, w.ID)
	s.mapMu.Unlock()

	s.onlineMu.Lock()
	for cid, wid := range s.online {
		if wid == w.ID {
			delete(s.online, cid)
		}
	}
	s.onlineMu.Unlock()

	return nil
}

// GetWorldStatus 返回世界状态摘要（玩家数/上限），供前端判断是否可进入
func (s *SlgService) GetWorldStatus(ctx context.Context) (playerCount int, full bool, err error) {
	w, err := s.GetActiveWorld(ctx)
	if err != nil {
		return 0, false, err
	}
	s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM slg_players WHERE world_id=?`, w.ID).Scan(&playerCount)
	return playerCount, playerCount >= maxPlayersPerWorld, nil
}
