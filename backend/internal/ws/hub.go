package ws

import (
	"context"
	"encoding/json"
	"log"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	rdb "github.com/redis/go-redis/v9"

	"e2eechat/internal/service"
	pkgredis "e2eechat/pkg/redis"
)

var (
	chatIDRe     = regexp.MustCompile(`^\d{4}-[A-Z]{4}$`)
	msgIDRe      = regexp.MustCompile(`^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$`)
	transferIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = 30 * time.Second
	maxMessageSize = 256 * 1024       // 256KB（支持文件分块传输）
	maxChunkData   = 200 * 1024       // 单块 base64 数据最大长度
	fileChunkSize  = 128 * 1024       // 前端分块大小（原始字节），用于校验 total_chunks 与 filesize 是否相符
	maxFileSize    = 10 * 1024 * 1024 // 10MB
	maxFilename    = 255
	maxTotalChunks = 100
)

// Message 是 WebSocket 消息的通用结构
type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// Client 代表一个 WebSocket 连接
type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	send   chan []byte
	ChatID string
	UserID uint64 // 用于查询好友列表

	// 消息限流状态：固定窗口计数。仅在该连接自身的 readPump goroutine 内访问
	// （dispatch 同步执行），故无需加锁。
	msgLimiter         fixedWindow // 所有入站消息的总闸
	lobbyLimiter       fixedWindow // 大厅加入/离开（会触发 O(N) 广播，单独严格限）
	ifActionLimiter    fixedWindow
	ifReconnectLimiter fixedWindow
}

// fixedWindow 是一个非并发安全的固定窗口限流器，仅供单 goroutine 使用。
type fixedWindow struct {
	windowStart time.Time
	count       int
}

// allow 在当前 1 秒窗口内放行不超过 max 次，超限返回 false。
func (w *fixedWindow) allow(now time.Time, max int) bool {
	if now.Sub(w.windowStart) >= time.Second {
		w.windowStart = now
		w.count = 0
	}
	if w.count >= max {
		return false
	}
	w.count++
	return true
}

// InitClient 由 handler 层调用，设置连接和发送通道
func InitClient(c *Client, conn *websocket.Conn, send chan []byte) {
	c.conn = conn
	c.send = send
}

// 单连接每秒允许的消息上限（固定窗口）。
const (
	msgMaxPerSec         = 100 // 所有入站消息总闸：挡单连接刷消息打 CPU/Redis/DB
	lobbyMaxPerSec       = 5   // 大厅加入/离开：每次触发全大厅广播，严格限
	ifActionMaxPerSec    = 30  // ironfist_action：实时对战动作，给足余量
	ifReconnectMaxPerSec = 5   // ironfist_reconnect：低频操作，每次都做全量 LRANGE
)

// Hub 管理所有在线连接
type Hub struct {
	mu             sync.RWMutex
	clients        map[string]*Client // chatID → client
	redis          *rdb.Client
	friendSvc      *service.FriendService
	identitySvc    *service.IdentityService
	messageReadSvc *service.MessageReadService
	pushSvc        *service.PushService                 // 可为 nil（未配置时禁用推送）
	ironFistSvc    *service.IronFistService             // 可为 nil（PVP 大厅禁用）
	pvpLobby       map[string]*service.LobbyUserProfile // chatID → 大厅用户档案（PVP 大厅在线列表）

	// PVP 房间参与方短 TTL 缓存：避免 ironfist_action 热路径每个动作打一次 DB
	// （否则已认证用户狂刷 action 会把 WS 流量放大成等量 DB 查询）。状态陈旧度
	// 上限为 pvpPartCacheTTL，对越权校验足够（参与方 chatID 撮合后不变）。
	pvpPartMu    sync.Mutex
	pvpPartCache map[uint64]pvpPartCacheEntry
}

// pvpPartCacheEntry 缓存项；part 为 nil 表示"已确认房间不存在"，同样缓存以挡住
// 对不存在 room_id 的枚举刷查。
type pvpPartCacheEntry struct {
	part    *service.PVPRoomParticipants
	expires time.Time
}

// pvpPartCacheTTL 参与方缓存有效期，决定房间状态变更（结算/取消）的最大可见延迟。
const pvpPartCacheTTL = 5 * time.Second

func NewHub(redis *rdb.Client, friendSvc *service.FriendService, identitySvc *service.IdentityService, messageReadSvc *service.MessageReadService) *Hub {
	return &Hub{
		clients:        make(map[string]*Client),
		redis:          redis,
		friendSvc:      friendSvc,
		identitySvc:    identitySvc,
		messageReadSvc: messageReadSvc,
		pvpLobby:       make(map[string]*service.LobbyUserProfile),
		pvpPartCache:   make(map[uint64]pvpPartCacheEntry),
	}
}

// getRoomParticipants 带短 TTL 缓存地查询 PVP 房间参与方，供 WS 越权校验使用。
// 命中缓存时不打 DB；未命中时用带超时的 context 查询（避免慢/挂死的 DB 阻塞
// 该连接的读循环），并顺带清理过期项防止 map 无界增长。
func (h *Hub) getRoomParticipants(roomID uint64) (*service.PVPRoomParticipants, error) {
	now := time.Now()

	h.pvpPartMu.Lock()
	if e, ok := h.pvpPartCache[roomID]; ok && now.Before(e.expires) {
		part := e.part
		h.pvpPartMu.Unlock()
		return part, nil
	}
	h.pvpPartMu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	part, err := h.ironFistSvc.GetPVPRoomParticipants(ctx, roomID)
	if err != nil {
		return nil, err
	}

	// 不缓存 matching：这是个会很快翻转成 matched 的过渡态，若缓存住会导致撮合
	// 完成后最多一个 TTL 内 from 的合法 action 被当作"未 matched"丢弃（永久丢失，
	// 重连补不回），造成开局 desync。其它状态（matched/settled/cancelled）与 nil
	// 都相对稳定，缓存其陈旧度可接受。
	if part != nil && part.Status == "matching" {
		return part, nil
	}

	h.pvpPartMu.Lock()
	for id, e := range h.pvpPartCache {
		if now.After(e.expires) {
			delete(h.pvpPartCache, id)
		}
	}
	h.pvpPartCache[roomID] = pvpPartCacheEntry{part: part, expires: now.Add(pvpPartCacheTTL)}
	h.pvpPartMu.Unlock()
	return part, nil
}

// SetPushService 注入推送服务（在 main.go 中 hub 创建后调用）
func (h *Hub) SetPushService(svc *service.PushService) {
	h.pushSvc = svc
}

// SetIronFistService 注入铁拳服务，启用 PVP 大厅在线列表功能
func (h *Hub) SetIronFistService(svc *service.IronFistService) {
	h.ironFistSvc = svc
}

// Register 注册客户端，标记在线，通知好友
func (h *Hub) Register(c *Client) {
	h.mu.Lock()
	// 若同一 chatID 已有连接，关闭旧连接
	if old, ok := h.clients[c.ChatID]; ok {
		close(old.send)
	}
	h.clients[c.ChatID] = c
	h.mu.Unlock()

	ctx := context.Background()
	h.redis.Set(ctx, pkgredis.OnlineKey(c.ChatID), "1", pkgredis.OnlineTTL)

	// 通知好友：上线
	h.notifyFriendsStatus(c.UserID, c.ChatID, true)
}

// Unregister 注销客户端，标记离线，通知好友
func (h *Hub) Unregister(c *Client) {
	h.mu.Lock()
	isCurrent := h.clients[c.ChatID] == c
	if isCurrent {
		delete(h.clients, c.ChatID)
	}
	// 若该用户在 PVP 大厅，一并移除（断线即离开大厅）
	_, inLobby := h.pvpLobby[c.ChatID]
	if inLobby {
		delete(h.pvpLobby, c.ChatID)
	}
	h.mu.Unlock()

	// 仅当该客户端仍是当前活跃连接时才清理在线状态
	// 若新连接已抢占该 chatID（如重连），跳过清理，避免误删新连接的 Redis key 并误发 status:false
	if !isCurrent {
		return
	}

	ctx := context.Background()
	h.redis.Del(ctx, pkgredis.OnlineKey(c.ChatID))

	// 通知好友：下线
	h.notifyFriendsStatus(c.UserID, c.ChatID, false)

	// 离开 PVP 大厅：广播更新给仍在场的大厅用户
	if inLobby {
		h.broadcastLobbyUpdate()
	}

	// 取消该用户在 PVP 撮合队列中的等待（避免被匹配给他人后无人开局）。
	// 加 5 秒宽限期：ws.js 会自动重连，重连窗口内的短暂断线不应触发取消，
	// 否则用户前端仍显示"搜索中"但后端已退款，再也等不到匹配。
	// 异步执行，不阻塞 Unregister；失败仅日志，不影响断线流程。
	if h.ironFistSvc != nil {
		go func(chatID string) {
			time.Sleep(5 * time.Second)
			h.mu.RLock()
			_, online := h.clients[chatID]
			h.mu.RUnlock()
			if online {
				return // 已重连，跳过取消
			}
			if _, err := h.ironFistSvc.CancelPVPQueue(context.Background(), chatID); err != nil {
				log.Printf("[ws] auto cancel pvp queue for %s: %v", chatID, err)
			}
		}(c.ChatID)
	}
}

// notifyFriendsStatus 向好友广播在线状态变更
func (h *Hub) notifyFriendsStatus(userID uint64, chatID string, online bool) {
	if h.friendSvc == nil {
		return
	}

	ctx := context.Background()
	friendChatIDs, err := h.friendSvc.GetFriendChatIDs(ctx, userID)
	if err != nil {
		log.Printf("[ws] get friends for status notify: %v", err)
		return
	}

	type StatusPayload struct {
		ChatID string `json:"chat_id"`
		Online bool   `json:"online"`
	}

	msg, _ := json.Marshal(Message{
		Type: "status",
		Payload: mustMarshal(StatusPayload{
			ChatID: chatID,
			Online: online,
		}),
	})

	h.mu.RLock()
	for _, friendChatID := range friendChatIDs {
		if c, ok := h.clients[friendChatID]; ok {
			select {
			case c.send <- msg:
			default:
			}
		}
	}
	h.mu.RUnlock()
}

// Send 向指定 chatID 发送消息；若离线则存入 Redis
func (h *Hub) Send(chatID string, msg []byte) {
	h.mu.RLock()
	c, online := h.clients[chatID]
	h.mu.RUnlock()

	if online {
		select {
		case c.send <- msg:
		default:
			// 发送缓冲满，存离线
			h.storeOffline(chatID, msg)
		}
	} else {
		h.storeOffline(chatID, msg)
	}
}

// IsOnline 检查用户是否在线
func (h *Hub) IsOnline(chatID string) bool {
	ctx := context.Background()
	exists, _ := h.redis.Exists(ctx, pkgredis.OnlineKey(chatID)).Result()
	return exists > 0
}

// FlushOffline 将离线消息推送给刚上线的客户端
func (h *Hub) FlushOffline(c *Client) {
	ctx := context.Background()
	key := pkgredis.OfflineKey(c.ChatID)
	msgs, err := h.redis.LRange(ctx, key, 0, -1).Result()
	if err != nil || len(msgs) == 0 {
		return
	}
	h.redis.Del(ctx, key)
	for _, m := range msgs {
		c.send <- []byte(m)
	}
}

func (h *Hub) storeOffline(chatID string, msg []byte) {
	ctx := context.Background()
	key := pkgredis.OfflineKey(chatID)
	h.redis.RPush(ctx, key, string(msg))
	h.redis.Expire(ctx, key, pkgredis.OfflineMsgTTL)
}

// ServeClient 启动读/写 goroutine
func (h *Hub) ServeClient(c *Client) {
	h.Register(c)
	h.FlushOffline(c)

	go c.writePump()
	c.readPump(h) // 阻塞直到断开
	h.Unregister(c)
}

// readPump 读取客户端消息
func (c *Client) readPump(h *Hub) {
	defer c.conn.Close()
	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		// 刷新在线状态
		h.redis.Expire(context.Background(), pkgredis.OnlineKey(c.ChatID), pkgredis.OnlineTTL)
		return nil
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("[ws] unexpected close for %s: %v", c.ChatID, err)
			}
			break
		}
		// 总闸限流：单连接每秒消息数封顶，挡刷消息打 CPU/Redis/DB。超限静默丢弃。
		if !c.msgLimiter.allow(time.Now(), msgMaxPerSec) {
			continue
		}
		var msg Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			log.Printf("[ws] bad message from %s: %v", c.ChatID, err)
			continue
		}
		h.dispatch(c, &msg, raw)
	}
}

// writePump 向客户端发送消息
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// dispatch 路由消息
func (h *Hub) dispatch(c *Client, msg *Message, raw []byte) {
	switch msg.Type {
	case "message":
		h.handleChatMessage(c, msg.Payload)
	case "recall":
		h.handleRecall(c, msg.Payload)
	case "read":
		h.handleRead(c, msg.Payload)
	case "file_offer":
		h.handleFileOffer(c, msg.Payload)
	case "file_chunk":
		h.handleFileChunk(c, msg.Payload)
	case "file_accept", "file_reject", "file_complete", "file_error", "file_done":
		h.handleFileSimpleRelay(c, msg.Type, msg.Payload)
	case "call_offer":
		h.handleCallOffer(c, msg.Payload)
	case "call_answer", "call_ice", "call_hangup", "call_reject":
		h.handleCallRelay(c, msg.Type, msg.Payload)
	case "game_invite", "game_accept", "game_reject", "game_ready",
		"game_move", "game_bomb", "game_powerup", "game_death", "game_resign":
		h.handleGameRelay(c, msg.Type, msg.Payload)
	case "ironfist_action":
		// 暂存到 Redis（断线重连用）+ 中继给对方
		h.handleIronFistAction(c, msg.Payload)
	case "ironfist_reconnect":
		// 返回该房间完整 action 历史（ironfist_replay）
		h.handleIronFistReconnect(c, msg.Payload)
	case "ironfist_lobby_join":
		// 加入 PVP 大厅在线列表，广播更新
		h.handleIronFistLobbyJoin(c)
	case "ironfist_lobby_leave":
		// 主动离开 PVP 大厅
		h.handleIronFistLobbyLeave(c)
	default:
		log.Printf("[ws] unknown message type %q from %s", msg.Type, c.ChatID)
	}
}

// ChatMessagePayload 聊天消息负载
type ChatMessagePayload struct {
	To              string `json:"to"`
	MsgID           string `json:"msg_id"`
	EphemeralPubKey string `json:"ephemeral_pub_key"`
	IV              string `json:"iv"`
	Ciphertext      string `json:"ciphertext"`
	BurnAfterRead   bool   `json:"burn_after_read"`
}

func (h *Hub) handleChatMessage(from *Client, payload json.RawMessage) {
	var p ChatMessagePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		log.Printf("[ws] invalid message payload from %s: %v", from.ChatID, err)
		return
	}

	// Validate target chat_id format
	if !chatIDRe.MatchString(p.To) {
		log.Printf("[ws] invalid to chat_id from %s: %q", from.ChatID, p.To)
		return
	}
	// Validate msg_id format if present
	if p.MsgID != "" && !msgIDRe.MatchString(p.MsgID) {
		log.Printf("[ws] invalid msg_id from %s: %q", from.ChatID, p.MsgID)
		return
	}
	// Require all encryption fields
	if p.Ciphertext == "" || p.IV == "" || p.EphemeralPubKey == "" {
		log.Printf("[ws] missing encryption fields from %s", from.ChatID)
		return
	}

	// Verify friendship — sender must be friends with recipient
	ctx := context.Background()
	isFriend, err := h.friendSvc.AreFriends(ctx, from.UserID, p.To)
	if err != nil || !isFriend {
		log.Printf("[ws] %s tried to message non-friend %s", from.ChatID, p.To)
		return
	}

	type ForwardPayload struct {
		From            string `json:"from"`
		MsgID           string `json:"msg_id"`
		EphemeralPubKey string `json:"ephemeral_pub_key"`
		IV              string `json:"iv"`
		Ciphertext      string `json:"ciphertext"`
		Timestamp       int64  `json:"ts"`
		BurnAfterRead   bool   `json:"burn_after_read"`
	}
	fwd, _ := json.Marshal(Message{
		Type: "message",
		Payload: mustMarshal(ForwardPayload{
			From:            from.ChatID,
			MsgID:           p.MsgID,
			EphemeralPubKey: p.EphemeralPubKey,
			IV:              p.IV,
			Ciphertext:      p.Ciphertext,
			Timestamp:       time.Now().UnixMilli(),
			BurnAfterRead:   p.BurnAfterRead,
		}),
	})
	h.Send(p.To, fwd)

	// 若接收方不在线，触发极光推送（异步，不阻塞主流程）
	h.mu.RLock()
	_, recipientOnline := h.clients[p.To]
	h.mu.RUnlock()
	if !recipientOnline && h.pushSvc != nil {
		go h.pushSvc.NotifyOfflineUser(p.To, from.ChatID)
	}

	// ack 回给发送方，携带服务器时间戳
	type AckPayload struct {
		MsgID     string `json:"msg_id"`
		Timestamp int64  `json:"ts"`
	}
	ack, _ := json.Marshal(Message{
		Type: "ack",
		Payload: mustMarshal(AckPayload{
			MsgID:     p.MsgID,
			Timestamp: time.Now().UnixMilli(),
		}),
	})
	select {
	case from.send <- ack:
	default:
	}
}

// RecallPayload 撤回消息负载
type RecallPayload struct {
	To    string `json:"to"`
	MsgID string `json:"msg_id"`
}

func (h *Hub) handleRecall(from *Client, payload json.RawMessage) {
	var p RecallPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		log.Printf("[ws] invalid recall payload from %s: %v", from.ChatID, err)
		return
	}
	if !chatIDRe.MatchString(p.To) || !msgIDRe.MatchString(p.MsgID) {
		log.Printf("[ws] invalid recall payload from %s: to=%q msg_id=%q", from.ChatID, p.To, p.MsgID)
		return
	}

	// Only allow recalling to a friend
	ctx := context.Background()
	if ok, err := h.friendSvc.AreFriends(ctx, from.UserID, p.To); err != nil || !ok {
		log.Printf("[ws] %s tried to recall to non-friend %s", from.ChatID, p.To)
		return
	}
	type ForwardRecall struct {
		From  string `json:"from"`
		MsgID string `json:"msg_id"`
	}
	fwd, _ := json.Marshal(Message{
		Type: "recall",
		Payload: mustMarshal(ForwardRecall{
			From:  from.ChatID,
			MsgID: p.MsgID,
		}),
	})
	// 撤回只转发在线用户，不存离线（对方收不到只是本地没删，无安全问题）
	h.mu.RLock()
	c, ok := h.clients[p.To]
	h.mu.RUnlock()
	if ok {
		select {
		case c.send <- fwd:
		default:
		}
	}
}

// ReadPayload 已读回执负载
type ReadPayload struct {
	To    string   `json:"to"`     // 消息发送者 chat_id
	MsgID []string `json:"msg_id"` // 已读的消息 ID 列表
}

// handleRead 处理已读回执
func (h *Hub) handleRead(from *Client, payload json.RawMessage) {
	var p ReadPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		log.Printf("[ws] invalid read payload from %s: %v", from.ChatID, err)
		return
	}
	if !chatIDRe.MatchString(p.To) || len(p.MsgID) == 0 || len(p.MsgID) > 100 {
		log.Printf("[ws] invalid read payload from %s", from.ChatID)
		return
	}
	// Validate each msg_id format
	for _, id := range p.MsgID {
		if !msgIDRe.MatchString(id) {
			log.Printf("[ws] invalid msg_id in read from %s: %q", from.ChatID, id)
			return
		}
	}

	// 记录到数据库
	if h.messageReadSvc != nil {
		for _, msgID := range p.MsgID {
			// 幂等插入，忽略重复
			_ = h.messageReadSvc.RecordRead(context.Background(), msgID, p.To, from.ChatID, from.ChatID)
		}
	}

	// 转发给发送者（在线则推送，离线则存 Redis 离线队列）
	fwd, _ := json.Marshal(Message{
		Type: "read_receipt",
		Payload: mustMarshal(struct {
			From  string   `json:"from"`
			MsgID []string `json:"msg_id"`
		}{From: from.ChatID, MsgID: p.MsgID}),
	})
	h.Send(p.To, fwd)
}

// NotifyFriendRequest 向目标用户推送好友申请通知
func (h *Hub) NotifyFriendRequest(toChatID, fromChatID string) {
	type FriendRequestPayload struct {
		From string `json:"from"`
	}
	msg, _ := json.Marshal(Message{
		Type:    "friend_request",
		Payload: mustMarshal(FriendRequestPayload{From: fromChatID}),
	})
	h.mu.RLock()
	c, ok := h.clients[toChatID]
	h.mu.RUnlock()
	if ok {
		select {
		case c.send <- msg:
		default:
		}
	}
}

// NotifyFriendAccepted 通知好友申请发起方：对方已接受
func (h *Hub) NotifyFriendAccepted(toChatID string) {
	msg, _ := json.Marshal(Message{
		Type: "friend_accepted",
	})
	h.mu.RLock()
	c, ok := h.clients[toChatID]
	h.mu.RUnlock()
	if ok {
		select {
		case c.send <- msg:
		default:
		}
	}
}

// NotifyFriendRejected 通知好友申请发起方：对方已拒绝
func (h *Hub) NotifyFriendRejected(toChatID string) {
	msg, _ := json.Marshal(Message{
		Type: "friend_rejected",
	})
	h.mu.RLock()
	c, ok := h.clients[toChatID]
	h.mu.RUnlock()
	if ok {
		select {
		case c.send <- msg:
		default:
		}
	}
}

// NotifyPVPMatched 推送 PVP 匹配成功通知给等待方玩家。
// payload 包含 room_id / opponent / tier / stake，前端收到后切换到对战页面。
// 用阻塞发送 + 2 秒超时替代 default 丢弃：匹配通知丢失会导致等待方永远停留在
// 搜索页且房间变孤儿（质押锁死），不能静默丢弃。
func (h *Hub) NotifyPVPMatched(toChatID string, payload any) {
	msg, _ := json.Marshal(Message{
		Type:    "ironfist_pvp_matched",
		Payload: mustMarshal(payload),
	})
	h.mu.RLock()
	c, ok := h.clients[toChatID]
	h.mu.RUnlock()
	if !ok {
		log.Printf("[ws] notify pvp matched: %s offline, room may be swept as draw", toChatID)
		return
	}
	select {
	case c.send <- msg:
	case <-time.After(2 * time.Second):
		log.Printf("[ws] notify pvp matched: %s send buffer full after 2s, room may be swept as draw", toChatID)
	}
}

// ── 文件传输处理 ──────────────────────────────────────────────────

// FileOfferPayload 文件发送请求负载
type FileOfferPayload struct {
	To              string `json:"to"`
	TransferID      string `json:"transfer_id"`
	MsgID           string `json:"msg_id"`
	Filename        string `json:"filename"`
	Filesize        int64  `json:"filesize"`
	Filetype        string `json:"filetype"`
	TotalChunks     int    `json:"total_chunks"`
	EphemeralPubKey string `json:"ephemeral_pub_key"`
	IV              string `json:"iv"`
	BurnAfterRead   bool   `json:"burn_after_read"`
}

func (h *Hub) handleFileOffer(from *Client, payload json.RawMessage) {
	var p FileOfferPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		log.Printf("[ws] invalid file_offer from %s: %v", from.ChatID, err)
		return
	}

	if !chatIDRe.MatchString(p.To) {
		log.Printf("[ws] file_offer invalid to: %q from %s", p.To, from.ChatID)
		return
	}
	if !transferIDRe.MatchString(p.TransferID) {
		log.Printf("[ws] file_offer invalid transfer_id from %s", from.ChatID)
		return
	}
	if len(p.Filename) == 0 || len(p.Filename) > maxFilename {
		log.Printf("[ws] file_offer invalid filename from %s", from.ChatID)
		return
	}
	if p.Filesize <= 0 || p.Filesize > maxFileSize {
		log.Printf("[ws] file_offer invalid filesize %d from %s", p.Filesize, from.ChatID)
		return
	}
	if p.TotalChunks <= 0 || p.TotalChunks > maxTotalChunks {
		log.Printf("[ws] file_offer invalid total_chunks %d from %s", p.TotalChunks, from.ChatID)
		return
	}
	// 交叉校验：total_chunks 必须与声明的 filesize 相符，防止 filesize 很小却用大量分块放大流量
	// 密文 = filesize + GCM tag，按 fileChunkSize 分块；+1 容纳加密开销与边界
	maxChunksForSize := int((p.Filesize+fileChunkSize-1)/fileChunkSize) + 1
	if p.TotalChunks > maxChunksForSize {
		log.Printf("[ws] file_offer total_chunks %d exceeds size-implied max %d (filesize=%d) from %s", p.TotalChunks, maxChunksForSize, p.Filesize, from.ChatID)
		return
	}
	if p.EphemeralPubKey == "" || p.IV == "" {
		log.Printf("[ws] file_offer missing encryption fields from %s", from.ChatID)
		return
	}

	ctx := context.Background()
	isFriend, err := h.friendSvc.AreFriends(ctx, from.UserID, p.To)
	if err != nil || !isFriend {
		log.Printf("[ws] file_offer: %s not friends with %s", from.ChatID, p.To)
		return
	}

	h.mu.RLock()
	recipientClient, online := h.clients[p.To]
	h.mu.RUnlock()

	sendError := func(reason string) {
		errMsg, _ := json.Marshal(Message{
			Type: "file_error",
			Payload: mustMarshal(map[string]string{
				"transfer_id": p.TransferID,
				"reason":      reason,
			}),
		})
		select {
		case from.send <- errMsg:
		default:
		}
	}

	if !online {
		sendError("对方不在线，无法发送文件")
		return
	}

	type ForwardOffer struct {
		From            string `json:"from"`
		TransferID      string `json:"transfer_id"`
		MsgID           string `json:"msg_id"`
		Filename        string `json:"filename"`
		Filesize        int64  `json:"filesize"`
		Filetype        string `json:"filetype"`
		TotalChunks     int    `json:"total_chunks"`
		EphemeralPubKey string `json:"ephemeral_pub_key"`
		IV              string `json:"iv"`
		BurnAfterRead   bool   `json:"burn_after_read"`
		Timestamp       int64  `json:"ts"` // 服务器时间戳，两端据此统一文件消息时间
	}
	fwd, _ := json.Marshal(Message{
		Type: "file_offer",
		Payload: mustMarshal(ForwardOffer{
			From:            from.ChatID,
			TransferID:      p.TransferID,
			MsgID:           p.MsgID,
			Filename:        p.Filename,
			Filesize:        p.Filesize,
			Filetype:        p.Filetype,
			TotalChunks:     p.TotalChunks,
			EphemeralPubKey: p.EphemeralPubKey,
			IV:              p.IV,
			BurnAfterRead:   p.BurnAfterRead,
			Timestamp:       time.Now().UnixMilli(),
		}),
	})
	select {
	case recipientClient.send <- fwd:
	default:
		sendError("对方连接繁忙，请稍后重试")
	}
}

// handleFileChunk 中继文件数据块
func (h *Hub) handleFileChunk(from *Client, payload json.RawMessage) {
	var p struct {
		To         string `json:"to"`
		TransferID string `json:"transfer_id"`
		ChunkIndex int    `json:"chunk_index"`
		Data       string `json:"data"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		log.Printf("[ws] invalid file_chunk from %s: %v", from.ChatID, err)
		return
	}
	if !chatIDRe.MatchString(p.To) || !transferIDRe.MatchString(p.TransferID) {
		log.Printf("[ws] file_chunk invalid fields from %s", from.ChatID)
		return
	}
	if p.ChunkIndex < 0 || p.ChunkIndex >= maxTotalChunks {
		log.Printf("[ws] file_chunk invalid index %d from %s", p.ChunkIndex, from.ChatID)
		return
	}
	if len(p.Data) == 0 || len(p.Data) > maxChunkData {
		log.Printf("[ws] file_chunk invalid data length %d from %s", len(p.Data), from.ChatID)
		return
	}

	type ForwardChunk struct {
		From       string `json:"from"`
		TransferID string `json:"transfer_id"`
		ChunkIndex int    `json:"chunk_index"`
		Data       string `json:"data"`
	}
	fwd, _ := json.Marshal(Message{
		Type: "file_chunk",
		Payload: mustMarshal(ForwardChunk{
			From:       from.ChatID,
			TransferID: p.TransferID,
			ChunkIndex: p.ChunkIndex,
			Data:       p.Data,
		}),
	})

	h.mu.RLock()
	c, ok := h.clients[p.To]
	h.mu.RUnlock()
	if ok {
		select {
		case c.send <- fwd:
		default:
			log.Printf("[ws] file_chunk dropped for %s (buffer full)", p.To)
		}
	}
}

// handleFileSimpleRelay 中继 file_accept/file_reject/file_complete/file_error
func (h *Hub) handleFileSimpleRelay(from *Client, msgType string, payload json.RawMessage) {
	var p struct {
		To         string `json:"to"`
		TransferID string `json:"transfer_id"`
		Reason     string `json:"reason,omitempty"`
		Timestamp  int64  `json:"ts,omitempty"` // file_done 回带 file_offer 的服务器时间戳
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		log.Printf("[ws] invalid %s from %s: %v", msgType, from.ChatID, err)
		return
	}
	if !chatIDRe.MatchString(p.To) || !transferIDRe.MatchString(p.TransferID) {
		log.Printf("[ws] invalid %s fields from %s", msgType, from.ChatID)
		return
	}

	type Forward struct {
		From       string `json:"from"`
		TransferID string `json:"transfer_id"`
		Reason     string `json:"reason,omitempty"`
		Timestamp  int64  `json:"ts,omitempty"`
	}
	fwd, _ := json.Marshal(Message{
		Type: msgType,
		Payload: mustMarshal(Forward{
			From:       from.ChatID,
			TransferID: p.TransferID,
			Reason:     p.Reason,
			Timestamp:  p.Timestamp,
		}),
	})

	h.mu.RLock()
	c, ok := h.clients[p.To]
	h.mu.RUnlock()
	if ok {
		select {
		case c.send <- fwd:
		default:
		}
	}
}

// ── 语音通话信令处理 ──────────────────────────────────────────────────

// handleCallOffer 转发通话邀请（含好友校验）
func (h *Hub) handleCallOffer(from *Client, payload json.RawMessage) {
	var p struct {
		To    string          `json:"to"`
		SDP   json.RawMessage `json:"sdp"`
		Media string          `json:"media"` // audio | video（缺省按 audio 处理）
	}
	if err := json.Unmarshal(payload, &p); err != nil || !chatIDRe.MatchString(p.To) {
		log.Printf("[ws] invalid call_offer from %s", from.ChatID)
		return
	}

	ctx := context.Background()
	if ok, err := h.friendSvc.AreFriends(ctx, from.UserID, p.To); err != nil || !ok {
		log.Printf("[ws] call_offer: %s not friends with %s", from.ChatID, p.To)
		return
	}

	media := "audio"
	if p.Media == "video" {
		media = "video"
	}

	fwd, _ := json.Marshal(Message{
		Type: "call_offer",
		Payload: mustMarshal(map[string]any{
			"from":  from.ChatID,
			"sdp":   p.SDP,
			"media": media,
		}),
	})

	h.mu.RLock()
	c, ok := h.clients[p.To]
	h.mu.RUnlock()
	if ok {
		select {
		case c.send <- fwd:
		default:
		}
	}
}

// handleCallRelay 转发 call_answer / call_ice / call_hangup / call_reject
func (h *Hub) handleCallRelay(from *Client, msgType string, payload json.RawMessage) {
	var p struct {
		To  string          `json:"to"`
		SDP json.RawMessage `json:"sdp,omitempty"`
		ICE json.RawMessage `json:"ice,omitempty"`
	}
	if err := json.Unmarshal(payload, &p); err != nil || !chatIDRe.MatchString(p.To) {
		log.Printf("[ws] invalid %s from %s", msgType, from.ChatID)
		return
	}

	inner := map[string]any{"from": from.ChatID}
	if len(p.SDP) > 0 {
		inner["sdp"] = p.SDP
	}
	if len(p.ICE) > 0 {
		inner["ice"] = p.ICE
	}

	fwd, _ := json.Marshal(Message{
		Type:    msgType,
		Payload: mustMarshal(inner),
	})

	h.mu.RLock()
	c, ok := h.clients[p.To]
	h.mu.RUnlock()
	if ok {
		select {
		case c.send <- fwd:
		default:
		}
	}
}

// handleGameRelay relays game messages between two players.
// Only game_invite validates friendship; subsequent in-game messages are relayed directly.
func (h *Hub) handleGameRelay(from *Client, msgType string, payload json.RawMessage) {
	var header struct {
		To string `json:"to"`
	}
	if err := json.Unmarshal(payload, &header); err != nil || !chatIDRe.MatchString(header.To) {
		log.Printf("[ws] invalid %s from %s", msgType, from.ChatID)
		return
	}

	if msgType == "game_invite" {
		ctx := context.Background()
		ok, err := h.friendSvc.AreFriends(ctx, from.UserID, header.To)
		if err != nil || !ok {
			log.Printf("[ws] game_invite: %s not friends with %s", from.ChatID, header.To)
			return
		}
	}

	// Inject "from" field so the recipient knows who sent it
	var m map[string]interface{}
	if err := json.Unmarshal(payload, &m); err != nil {
		return
	}
	m["from"] = from.ChatID

	fwd, _ := json.Marshal(Message{Type: msgType, Payload: mustMarshal(m)})

	h.mu.RLock()
	c, ok := h.clients[header.To]
	h.mu.RUnlock()
	if ok {
		select {
		case c.send <- fwd:
		default:
		}
	}

	// game_resign 时清理铁拳房间的 action 日志（若 payload 含 room_id）。
	// 非铁拳对局 payload 不会有 room_id，跳过即可。
	if msgType == "game_resign" {
		var room struct {
			RoomID string `json:"room_id"`
		}
		if json.Unmarshal(payload, &room) == nil && room.RoomID != "" {
			ctx := context.Background()
			h.redis.Del(ctx, pkgredis.IronFistActionsKey(room.RoomID))
		}
	}
}

func mustMarshal(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

// handleIronFistAction 暂存铁拳 action 到 Redis（断线重连用）并中继给对方。
// 服务端不做任何游戏逻辑，仅追加存储 + 转发。详见 docs/ironfist.md 第十四节方案 B。
func (h *Hub) handleIronFistAction(from *Client, payload json.RawMessage) {
	var p struct {
		To     string `json:"to"`
		RoomID string `json:"room_id"`
		Round  int    `json:"round"`
		Action string `json:"action"`
		TS     int64  `json:"ts"`
	}
	if err := json.Unmarshal(payload, &p); err != nil || !chatIDRe.MatchString(p.To) || p.RoomID == "" {
		log.Printf("[ws] invalid ironfist_action from %s", from.ChatID)
		return
	}

	// 限流：单连接固定窗口（1s）内最多 ifActionMaxPerSec 个 action，挡住合法
	// 参与方刷消息（叠加下游 Redis RPUSH + 中继的放大效应）。超限静默丢弃。
	if !from.ifActionLimiter.allow(time.Now(), ifActionMaxPerSec) {
		log.Printf("[ws] ironfist_action rate limited from %s", from.ChatID)
		return
	}

	// 房间类型区分：
	//  - 质押 PVP 房间：room_id 是数字 DB 主键且存在于 ironfist_pvp_rooms。涉及资金，
	//    需严格越权校验（from 必须是参与方、房间 matched、p.To 必须是对手）。
	//  - 好友娱乐局：room_id 是 randomId 字符串（非数字 / 不在 PVP 表）。无资金风险，
	//    仅中继不做游戏逻辑校验——randomId（36^8 空间，不可枚举）本身即访问凭据。
	// 仅当肯定识别为 PVP 房间时才走严格校验，避免误伤好友局（其 action 不应被丢弃）。
	if roomID, perr := strconv.ParseUint(p.RoomID, 10, 64); perr == nil && h.ironFistSvc != nil {
		if part, gerr := h.getRoomParticipants(roomID); gerr == nil && part != nil {
			if part.Status != "matched" {
				log.Printf("[ws] ironfist_action: room %d status=%s, expected matched", roomID, part.Status)
				return
			}
			var opponentChatID string
			switch from.ChatID {
			case part.AChatID:
				opponentChatID = part.BChatID
			case part.BChatID:
				opponentChatID = part.AChatID
			default:
				log.Printf("[ws] ironfist_action: %s not a participant of room %d", from.ChatID, roomID)
				return
			}
			if opponentChatID == "" || p.To != opponentChatID {
				log.Printf("[ws] ironfist_action: %s relay to %s rejected (opponent %s) room %d",
					from.ChatID, p.To, opponentChatID, roomID)
				return
			}
		}
	}

	// 存储项含 from，便于客户端重放时区分双方动作
	entry := map[string]interface{}{
		"round":  p.Round,
		"action": p.Action,
		"from":   from.ChatID,
		"ts":     p.TS,
	}
	entryJSON, _ := json.Marshal(entry)

	ctx := context.Background()
	key := pkgredis.IronFistActionsKey(p.RoomID)
	// RPUSH + 刷新 TTL：30 分钟从最后一次活动起算
	pipe := h.redis.Pipeline()
	pipe.RPush(ctx, key, entryJSON)
	pipe.Expire(ctx, key, pkgredis.IronFistActionsTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		// 存储失败仅记录日志，不阻塞中继（本回合仍可进行，重连时该动作会缺失）
		log.Printf("[ws] ironfist_action store failed: %v", err)
	}

	// 中继给对方（注入 from 字段）
	m := map[string]interface{}{
		"to":      p.To,
		"room_id": p.RoomID,
		"round":   p.Round,
		"action":  p.Action,
		"ts":      p.TS,
		"from":    from.ChatID,
	}
	fwd, _ := json.Marshal(Message{Type: "ironfist_action", Payload: mustMarshal(m)})

	h.mu.RLock()
	c, ok := h.clients[p.To]
	h.mu.RUnlock()
	if ok {
		select {
		case c.send <- fwd:
		default:
		}
	}
}

// handleIronFistReconnect 返回该房间的完整 action 历史（ironfist_replay）。
// 客户端收到后用 replayGame() 重放出当前状态，无状态分叉风险。
func (h *Hub) handleIronFistReconnect(from *Client, payload json.RawMessage) {
	var p struct {
		RoomID string `json:"room_id"`
	}
	if err := json.Unmarshal(payload, &p); err != nil || p.RoomID == "" {
		log.Printf("[ws] invalid ironfist_reconnect from %s", from.ChatID)
		return
	}

	// 限流：reconnect 每次都做一次全量 LRANGE，限制单连接刷取频率。超限静默丢弃。
	if !from.ifReconnectLimiter.allow(time.Now(), ifReconnectMaxPerSec) {
		log.Printf("[ws] ironfist_reconnect rate limited from %s", from.ChatID)
		return
	}

	// 越权校验：仅对质押 PVP 房间（数字 DB 主键且存在于 ironfist_pvp_rooms）生效——
	// 否则任意用户可枚举自增 room_id 拉取他人对局完整动作历史。要求 from 是参与方、
	// 房间 matched/settled。好友娱乐局 room_id 为不可枚举的 randomId 字符串，不在 PVP 表，
	// randomId 本身即访问凭据，直接放行重放（否则好友局刷新无法重连）。
	if roomID, perr := strconv.ParseUint(p.RoomID, 10, 64); perr == nil && h.ironFistSvc != nil {
		if part, gerr := h.getRoomParticipants(roomID); gerr == nil && part != nil {
			if part.Status != "matched" && part.Status != "settled" {
				log.Printf("[ws] ironfist_reconnect: room %d status=%s, expected matched/settled",
					roomID, part.Status)
				return
			}
			if from.ChatID != part.AChatID && from.ChatID != part.BChatID {
				log.Printf("[ws] ironfist_reconnect: %s not a participant of room %d", from.ChatID, roomID)
				return
			}
		}
	}

	ctx := context.Background()
	key := pkgredis.IronFistActionsKey(p.RoomID)
	actions, err := h.redis.LRange(ctx, key, 0, -1).Result()
	if err != nil {
		log.Printf("[ws] ironfist_reconnect LRange failed: %v", err)
		actions = []string{}
	}

	parsed := make([]interface{}, 0, len(actions))
	for _, raw := range actions {
		var obj interface{}
		if json.Unmarshal([]byte(raw), &obj) == nil {
			parsed = append(parsed, obj)
		}
	}

	m := map[string]interface{}{
		"room_id": p.RoomID,
		"actions": parsed,
	}
	fwd, _ := json.Marshal(Message{Type: "ironfist_replay", Payload: mustMarshal(m)})

	// 直接回送给请求方（不走对方）
	select {
	case from.send <- fwd:
	default:
	}
}

// handleIronFistLobbyJoin 加入 PVP 大厅在线列表。
// 客户端进入 PVP 大厅页面时发送；服务端查询用户档案后存入 pvpLobby，
// 并向所有在场用户广播最新列表（含本人在内）。
func (h *Hub) handleIronFistLobbyJoin(c *Client) {
	if h.ironFistSvc == nil {
		return
	}
	// 限流：加入会触发 DB 查询 + 全大厅 O(N) 广播，严格限频防广播风暴。
	if !c.lobbyLimiter.allow(time.Now(), lobbyMaxPerSec) {
		return
	}
	// 查询档案（不在持锁期间做 DB 查询，避免阻塞其他 dispatch）
	ctx := context.Background()
	p, err := h.ironFistSvc.GetLobbyUserProfile(ctx, c.ChatID)
	if err != nil {
		log.Printf("[ws] ironfist_lobby_join get profile for %s: %v", c.ChatID, err)
		return
	}

	h.mu.Lock()
	// 已存在则覆盖（profile 可能变化：余额/场次更新）
	h.pvpLobby[c.ChatID] = p
	// 拷贝当前列表用于广播
	list := make([]*service.LobbyUserProfile, 0, len(h.pvpLobby))
	for _, v := range h.pvpLobby {
		list = append(list, v)
	}
	recipients := make([]*Client, 0, len(list))
	for _, v := range list {
		if rc, ok := h.clients[v.ChatID]; ok {
			recipients = append(recipients, rc)
		}
	}
	h.mu.Unlock()

	h.sendLobbyUpdate(recipients, list)
}

// handleIronFistLobbyLeave 主动离开 PVP 大厅
func (h *Hub) handleIronFistLobbyLeave(c *Client) {
	// 共用大厅限流器：挡 join/leave 快速来回切换触发的广播风暴。
	if !c.lobbyLimiter.allow(time.Now(), lobbyMaxPerSec) {
		return
	}
	h.mu.Lock()
	_, inLobby := h.pvpLobby[c.ChatID]
	if !inLobby {
		h.mu.Unlock()
		return
	}
	delete(h.pvpLobby, c.ChatID)
	list := make([]*service.LobbyUserProfile, 0, len(h.pvpLobby))
	recipients := make([]*Client, 0, len(list)+1)
	for _, v := range h.pvpLobby {
		list = append(list, v)
		if rc, ok := h.clients[v.ChatID]; ok {
			recipients = append(recipients, rc)
		}
	}
	// 离开者也要收到更新（清空自己的列表显示）
	if rc, ok := h.clients[c.ChatID]; ok {
		recipients = append(recipients, rc)
	}
	h.mu.Unlock()

	h.sendLobbyUpdate(recipients, list)
}

// broadcastLobbyUpdate 向当前大厅所有在线用户广播最新列表。
// 用于断线/异常下线场景（Unregister 路径），此时离开者已不可达，无需发回。
func (h *Hub) broadcastLobbyUpdate() {
	h.mu.RLock()
	list := make([]*service.LobbyUserProfile, 0, len(h.pvpLobby))
	recipients := make([]*Client, 0, len(list))
	for _, v := range h.pvpLobby {
		list = append(list, v)
		if rc, ok := h.clients[v.ChatID]; ok {
			recipients = append(recipients, rc)
		}
	}
	h.mu.RUnlock()

	h.sendLobbyUpdate(recipients, list)
}

// sendLobbyUpdate 组装并广播大厅列表消息
func (h *Hub) sendLobbyUpdate(recipients []*Client, list []*service.LobbyUserProfile) {
	type UpdatePayload struct {
		Count int                         `json:"count"`
		Users []*service.LobbyUserProfile `json:"users"`
	}
	msg, _ := json.Marshal(Message{
		Type: "ironfist_lobby_update",
		Payload: mustMarshal(UpdatePayload{
			Count: len(list),
			Users: list,
		}),
	})
	for _, rc := range recipients {
		select {
		case rc.send <- msg:
		default:
		}
	}
}
