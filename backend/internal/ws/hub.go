package ws

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	rdb "github.com/redis/go-redis/v9"

	"e2eechat/internal/service"
	pkgredis "e2eechat/pkg/redis"
)

var (
	chatIDRe              = regexp.MustCompile(`^\d{4}-[A-Z]{4}$`)
	msgIDRe               = regexp.MustCompile(`^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$`)
	transferIDRe          = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	allowedFileExtensions = map[string]struct{}{
		"jpg": {}, "jpeg": {}, "png": {}, "gif": {}, "webp": {}, "bmp": {}, "svg": {},
		"mp4": {}, "webm": {}, "mov": {},
		"doc": {}, "docx": {}, "xls": {}, "xlsx": {}, "ppt": {}, "pptx": {}, "pdf": {},
		"zip": {}, "rar": {}, "7z": {}, "tar": {}, "gz": {}, "apk": {},
	}
)

func validFileMetadata(filename, _ string) bool {
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(filename)), ".")
	_, ok := allowedFileExtensions[ext]
	return ok
}

const (
	writeWait       = 10 * time.Second
	pongWait        = 60 * time.Second
	pingPeriod      = 30 * time.Second
	maxMessageSize  = 256 * 1024 //256KB (supports file block transfer)
	fileChunkSize   = 128 * 1024 //Frontend chunk size (original ciphertext bytes)
	maxChunkData    = ((fileChunkSize + 2) / 3) * 4
	aesGCMTagSize   = 16               //WebCrypto AES-GCM default 128-bit tag
	maxFileSize     = 10 * 1024 * 1024 //10MB plain text limit
	maxFilename     = 255
	maxTotalChunks  = 100
	fileTransferTTL = 3 * time.Minute
)

func expectedFileChunks(filesize int64) int {
	ciphertextSize := filesize + aesGCMTagSize
	return int((ciphertextSize + fileChunkSize - 1) / fileChunkSize)
}

func expectedFileChunkSize(filesize int64, chunkIndex int) int {
	ciphertextSize := filesize + aesGCMTagSize
	offset := int64(chunkIndex * fileChunkSize)
	remaining := ciphertextSize - offset
	if remaining > fileChunkSize {
		return fileChunkSize
	}
	return int(remaining)
}

// Message is the general structure of WebSocket messages
type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// Client represents a WebSocket connection
type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	send   chan []byte
	ChatID string
	UserID uint64 //Used to query the friend list

	// closed is closed when the connection is preempted by a new connection, telling writePump to stop sending data to the old connection that may be half dead.
	// Write and exit (recycle unsent messages in the send buffer into the offline queue when exiting). Use closeOnce
	// Guaranteed idempotence. Do not close(send) directly: that will cause the concurrent producer c.send<- to trigger a panic and buffer
	// Unsent messages will be permanently lost when the connection is destroyed.
	closed    chan struct{}
	closeOnce sync.Once

	// Message current limiting status: fixed window count. Only accessed within the connection's own readPump goroutine
	// (dispatch is executed synchronously), so no locking is required.
	msgLimiter   fixedWindow //Gatekeeper for all inbound messages
	lobbyLimiter fixedWindow //Lobby joining/leaving (will trigger O(N) broadcast, strictly limited individually)
}

// fixedWindow is a non-concurrency-safe fixed window current limiter for single goroutine use only.
type fixedWindow struct {
	windowStart time.Time
	count       int
}

// allow does not release more than max times in the current 1 second window, and returns false if the limit is exceeded.
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

// InitClient is called by the handler layer to set up the connection and sending channel
func InitClient(c *Client, conn *websocket.Conn, send chan []byte) {
	c.conn = conn
	c.send = send
	c.closed = make(chan struct{})
}

// signalClose notifies the writePump of the connection to exit (used when it is preempted by a new connection). Idempotent and can be called repeatedly.
func (c *Client) signalClose() {
	c.closeOnce.Do(func() { close(c.closed) })
}

// The upper limit of messages allowed per second for a single connection (fixed window).
const (
	msgMaxPerSec   = 100 //Main gate for all inbound messages: block single connection and flush messages to CPU/Redis/DB
	lobbyMaxPerSec = 5   //Lobby joining/leaving: triggering a full lobby broadcast every time, strictly limited
)

// Hub manages all online connections
type Hub struct {
	mu             sync.RWMutex
	clients        map[string]*Client // chatID → client
	redis          *rdb.Client
	friendSvc      friendChecker
	identitySvc    *service.IdentityService
	messageReadSvc *service.MessageReadService
	pushSvc        *service.PushService                 //Can be nil (disables pushing when not configured)
	ironFistSvc    *service.IronFistService             //Can be nil (disabled for PVP lobbies)
	pvpLobby       map[string]*service.LobbyUserProfile //chatID → Lobby User Profile (PVP Lobby Online List)

	// File chunking is only allowed to be relayed in sessions that are registered and accepted by the recipient, preventing any user from bypassing
	// file_offer's friend check floods online users with chunks of data.
	fileTransferMu sync.Mutex
	fileTransfers  map[string]*fileTransferSession
}

type friendChecker interface {
	GetFriendChatIDs(context.Context, uint64) ([]string, error)
	AreFriends(context.Context, uint64, string) (bool, error)
}

type fileTransferSession struct {
	sender         string
	recipient      string
	msgID          string
	filesize       int64
	totalChunks    int
	receivedChunks []bool
	receivedCount  int
	accepted       bool
	done           bool
	timestamp      int64
}

func NewHub(redis *rdb.Client, friendSvc *service.FriendService, identitySvc *service.IdentityService, messageReadSvc *service.MessageReadService) *Hub {
	return &Hub{
		clients:        make(map[string]*Client),
		redis:          redis,
		friendSvc:      friendSvc,
		identitySvc:    identitySvc,
		messageReadSvc: messageReadSvc,
		pvpLobby:       make(map[string]*service.LobbyUserProfile),
		fileTransfers:  make(map[string]*fileTransferSession),
	}
}

// SetPushService injects the push service (called after hub is created in main.go)
func (h *Hub) SetPushService(svc *service.PushService) {
	h.pushSvc = svc
}

// SetIronFistService injects the Iron Fist service and enables the PVP lobby online list function
func (h *Hub) SetIronFistService(svc *service.IronFistService) {
	h.ironFistSvc = svc
}

// Register Register the client, mark online, notify friends
func (h *Hub) Register(c *Client) {
	h.mu.Lock()
	_, wasOnline := h.clients[c.ChatID]
	// If there is already a connection with the same chatID, notify the old connection to exit (do not close(send) directly to avoid producer panic
	// And let the writePump of the old connection recycle the unsent messages in the buffer into the offline queue when exiting)
	if old, ok := h.clients[c.ChatID]; ok {
		old.signalClose()
	}
	h.clients[c.ChatID] = c
	h.mu.Unlock()
	if !wasOnline && h.ironFistSvc != nil {
		if err := h.ironFistSvc.SetIronFistPresence(context.Background(), c.UserID, true); err != nil {
			log.Printf("[ws] set IronFist presence online for %s: %v", c.ChatID, err)
		}
	}

	ctx := context.Background()
	h.redis.Set(ctx, pkgredis.OnlineKey(c.ChatID), "1", pkgredis.OnlineTTL)

	// Notify friends: online
	h.notifyFriendsStatus(c.UserID, c.ChatID, true)
}

// Unregister logs out of the client, marks offline, and notifies friends
func (h *Hub) Unregister(c *Client) {
	h.mu.Lock()
	isCurrent := h.clients[c.ChatID] == c
	if isCurrent {
		delete(h.clients, c.ChatID)
	}
	// If the user is in the PVP lobby, remove him as well (leave the lobby when disconnected)
	_, inLobby := h.pvpLobby[c.ChatID]
	if inLobby {
		delete(h.pvpLobby, c.ChatID)
	}
	h.mu.Unlock()

	// Only clear online status if the client is still currently actively connected
	// If the new connection has preempted the chatID (such as reconnection), skip the cleanup to avoid accidentally deleting the Redis key of the new connection and accidentally sending status:false
	if !isCurrent {
		return
	}
	if h.ironFistSvc != nil {
		if err := h.ironFistSvc.SetIronFistPresence(context.Background(), c.UserID, false); err != nil {
			log.Printf("[ws] set IronFist presence offline for %s: %v", c.ChatID, err)
		}
	}

	ctx := context.Background()
	h.redis.Del(ctx, pkgredis.OnlineKey(c.ChatID))

	// Notify friends: offline
	h.notifyFriendsStatus(c.UserID, c.ChatID, false)

	// Leaving the PVP lobby: Broadcast updates to lobby users still present
	if inLobby {
		h.broadcastLobbyUpdate()
	}

	// Cancel the user's waiting in the PVP matching queue (to avoid being matched to others and then no one starts the game).
	// Add a 5-second grace period: ws.js will automatically reconnect, and a brief disconnection within the reconnection window should not trigger cancellation.
	// Otherwise, the user's front-end still displays "Searching" but the back-end has refunded, and will no longer be able to wait for a match.
	// Asynchronous execution, does not block Unregister; failure only logs, does not affect the disconnection process.
	if h.ironFistSvc != nil {
		go func(chatID string) {
			time.Sleep(5 * time.Second)
			h.mu.RLock()
			_, online := h.clients[chatID]
			h.mu.RUnlock()
			if online {
				return //Reconnected, skip cancellation
			}
			if _, err := h.ironFistSvc.CancelPVPQueue(context.Background(), chatID); err != nil {
				log.Printf("[ws] auto cancel pvp queue for %s: %v", chatID, err)
			}
		}(c.ChatID)
	}
}

// DeliverIronFistEvent fans a committed event out to recipients connected to
// this server. A state fetch is the recovery path for missed notifications.
func (h *Hub) DeliverIronFistEvent(raw string) {
	var event service.IronFistOutboxEvent
	if err := json.Unmarshal([]byte(raw), &event); err != nil {
		log.Printf("[ws] decode IronFist outbox event: %v", err)
		return
	}
	message, err := json.Marshal(Message{Type: event.Type, Payload: event.Payload})
	if err != nil {
		return
	}
	for _, chatID := range event.RecipientChatIDs {
		h.mu.RLock()
		client := h.clients[chatID]
		h.mu.RUnlock()
		if client == nil {
			continue
		}
		select {
		case client.send <- message:
		default:
		}
	}
}

// notifyFriendsStatus broadcasts online status changes to friends
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

// Send sends a message to the specified chatID; if offline, it will be stored in Redis
func (h *Hub) Send(chatID string, msg []byte) {
	h.mu.RLock()
	c, online := h.clients[chatID]
	h.mu.RUnlock()

	if online {
		select {
		case c.send <- msg:
		default:
			// The sending buffer is full and the storage is offline.
			h.storeOffline(chatID, msg)
		}
	} else {
		h.storeOffline(chatID, msg)
	}
}

// IsOnline checks if the user is online
func (h *Hub) IsOnline(chatID string) bool {
	ctx := context.Background()
	exists, _ := h.redis.Exists(ctx, pkgredis.OnlineKey(chatID)).Result()
	return exists > 0
}

// FlushOffline pushes offline messages to clients that have just gone online
func (h *Hub) FlushOffline(c *Client) {
	ctx := context.Background()
	key := pkgredis.OfflineKey(c.ChatID)
	msgs, err := h.redis.LRange(ctx, key, 0, -1).Result()
	if err != nil || len(msgs) == 0 {
		return
	}
	h.redis.Del(ctx, key)
	for i, m := range msgs {
		select {
		case c.send <- []byte(m):
		case <-c.closed:
			// This connection was preempted by an updated connection during the flush: the remaining offline messages that have not yet been queued (including the current
			// This) is returned to the offline queue as it is and handed over to the next connection for re-investment to avoid being blocked here and waiting for a full buffer.
			// LPUSH key a b c will get [c b a], so pass it in in reverse order so that the remaining messages are in the original order.
			// Be at the front of the queue and get priority for the next connection.
			rest := msgs[i:]
			remaining := make([]interface{}, 0, len(rest))
			for j := len(rest) - 1; j >= 0; j-- {
				remaining = append(remaining, rest[j])
			}
			pipe := h.redis.Pipeline()
			pipe.LPush(ctx, key, remaining...)
			pipe.Expire(ctx, key, pkgredis.OfflineMsgTTL)
			pipe.Exec(ctx)
			return
		}
	}
}

// FlushStoredReadReceipts flushes all read tombstones that the sender has not yet consumed from the database. Redis offline
// The queue has a limited TTL, and the burn after reading must be able to be cleared immediately according to the first read time even after the user is offline for a long time.
func (h *Hub) FlushStoredReadReceipts(c *Client) {
	if h.messageReadSvc == nil {
		return
	}
	grouped, err := h.messageReadSvc.GetReadReceiptsForSender(context.Background(), c.ChatID)
	if err != nil {
		log.Printf("[ws] load stored read receipts for %s: %v", c.ChatID, err)
		return
	}
	const receiptBatchSize = 100
	for reader, receipts := range grouped {
		for i := 0; i < len(receipts); i += receiptBatchSize {
			end := i + receiptBatchSize
			if end > len(receipts) {
				end = len(receipts)
			}
			batch := receipts[i:end]
			ids := make([]string, 0, len(batch))
			for _, receipt := range batch {
				ids = append(ids, receipt.MsgID)
			}
			msg, _ := json.Marshal(Message{
				Type: "read_receipt",
				Payload: mustMarshal(struct {
					From     string                `json:"from"`
					MsgID    []string              `json:"msg_id"`
					Receipts []service.ReadReceipt `json:"receipts"`
					Replay   bool                  `json:"replay"`
				}{From: reader, MsgID: ids, Receipts: batch, Replay: true}),
			})
			select {
			case c.send <- msg:
			case <-c.closed:
				return
			}
		}
	}
}

func (h *Hub) storeOffline(chatID string, msg []byte) {
	ctx := context.Background()
	key := pkgredis.OfflineKey(chatID)
	h.redis.RPush(ctx, key, string(msg))
	h.redis.Expire(ctx, key, pkgredis.OfflineMsgTTL)
}

// ServeClient starts the read/write goroutine
func (h *Hub) ServeClient(c *Client) {
	h.Register(c)

	// First start writePump and then flush offline messages: FlushOffline directly writes c.send. If the number of offline messages
	// The send channel buffer (256) is exceeded, and writePump has not yet been started to consume, c.send<- will be permanently blocked resulting in
	// The connection is deadlocked and no messages can be received at all. When writePump is run first, it can be consumed while writing, and it will only degrade to back pressure.
	go c.writePump(h)
	h.FlushOffline(c)
	h.FlushStoredReadReceipts(c)

	c.readPump(h) //block until disconnected
	h.Unregister(c)
}

// readPump reads client messages
func (c *Client) readPump(h *Hub) {
	defer c.conn.Close()
	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		// Refresh online status
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
		// General gate current limit: the number of messages per second for a single connection is capped, and blocking messages will hit CPU/Redis/DB. Silently discarded if exceeded.
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

// writePump sends a message to the client
func (c *Client) writePump(h *Hub) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
		// When exiting, messages that have not yet been written in the send buffer are recycled into the offline queue to avoid half-dead connections/preemption.
		// Messages in the buffer are permanently lost when the connection is destroyed.
		h.requeueUndelivered(c)
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
		case <-c.closed:
			// Preempted by a new connection: Stop writing to this (possibly half-dead) connection, politely send a close frame and exit.
			// Undelivered messages in the buffer are recycled by defer's requeueUndelivered.
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			c.conn.WriteMessage(websocket.CloseMessage, []byte{})
			return
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// requeueUndelivered non-blockingly drains the send buffer and sorts the "offline storable" messages that have not yet been written out.
// Recycle into offline queue. There is only one writePump per connection, so this function can be executed at most once per connection and will not be recycled repeatedly.
// Recycle message/read_receipt/ack: Messages, read receipts and delivery confirmations all need to be added after reconnection;
// Transient messages such as status/signaling/game/file blocks are directly discarded to avoid phantom calls or residual game status after reconnection.
// Non-storable types are still pulled out of the channel (discarded) and do not remain in the buffer.
// Note: With a very small probability, the producer may still write to send after this function is drained (inherent race condition of preemption), and the message will
// Stalled buffer; this window is much smaller than the original gap of "half-dead connection and entire buffer lost", and will not panic.
func (h *Hub) requeueUndelivered(c *Client) {
	var pending []interface{}
	for draining := true; draining; {
		select {
		case msg, ok := <-c.send:
			if !ok {
				draining = false
			} else if offlineStorable(msg) {
				pending = append(pending, msg)
			}
		default:
			draining = false
		}
	}
	if len(pending) == 0 {
		return
	}
	ctx := context.Background()
	key := pkgredis.OfflineKey(c.ChatID)
	h.redis.RPush(ctx, key, pending...)
	h.redis.Expire(ctx, key, pkgredis.OfflineMsgTTL)
}

// offlineStorable determines whether a serialized outbound message belongs to the "offline storable" type. chat messages,
// Read receipts and two types of ACKs need to be resubmitted after reconnection. If the parsing fails, it will be treated as unstorable.
func offlineStorable(msg []byte) bool {
	var m struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &m); err != nil {
		return false
	}
	return m.Type == "message" || m.Type == "read_receipt" || m.Type == "ack" ||
		m.Type == "read_ack" || m.Type == "file_done"
}

// dispatch routing messages
func (h *Hub) dispatch(c *Client, msg *Message, raw []byte) {
	switch msg.Type {
	case "message":
		h.handleChatMessage(c, msg.Payload)
	case "recall":
		h.handleRecall(c, msg.Payload)
	case "read":
		h.handleRead(c, msg.Payload)
	case "read_receipt_applied":
		h.handleReadReceiptApplied(c, msg.Payload)
	case "file_offer":
		h.handleFileOffer(c, msg.Payload)
	case "file_chunk":
		h.handleFileChunk(c, msg.Payload)
	case "file_accept", "file_reject", "file_complete", "file_error", "file_done":
		h.handleFileSimpleRelay(c, msg.Type, msg.Payload)
	case "call_offer":
		h.handleCallOffer(c, msg.Payload)
	case "call_answer", "call_ice", "call_hangup", "call_reject",
		"call_restart_request", "call_restart_offer", "call_restart_answer", "call_media_state":
		h.handleCallRelay(c, msg.Type, msg.Payload)
	case "game_invite", "game_accept", "game_reject", "game_ready",
		"game_move", "game_bomb", "game_powerup", "game_death", "game_resign":
		h.handleGameRelay(c, msg.Type, msg.Payload)
	case "ironfist_lobby_join":
		// Join the PVP lobby online list and broadcast updates
		h.handleIronFistLobbyJoin(c)
	case "ironfist_lobby_leave":
		// Take the initiative to leave the PVP lobby
		h.handleIronFistLobbyLeave(c)
	default:
		log.Printf("[ws] unknown message type %q from %s", msg.Type, c.ChatID)
	}
}

// ChatMessagePayload chat message payload
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
	// msg_id is a necessary field for deduplication at the receiving end and ACK association at the sending end, and is prohibited from being empty.
	if !msgIDRe.MatchString(p.MsgID) {
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
	// Persist message ownership before forwarding, and subsequent read receipts can only be created by the actual recipient of this delivery.
	// Failed to close when the database is abnormal, to avoid the occurrence of disappearing messages that have been delivered but can never be safely confirmed for reading.
	if h.messageReadSvc == nil {
		log.Printf("[ws] message read service unavailable; rejected message from %s", from.ChatID)
		return
	}
	if err = h.messageReadSvc.RecordMessage(ctx, p.MsgID, from.ChatID, p.To); err != nil {
		log.Printf("[ws] failed to record delivery %q from %s: %v", p.MsgID, from.ChatID, err)
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
	timestamp := time.Now().UnixMilli()
	fwd, _ := json.Marshal(Message{
		Type: "message",
		Payload: mustMarshal(ForwardPayload{
			From:            from.ChatID,
			MsgID:           p.MsgID,
			EphemeralPubKey: p.EphemeralPubKey,
			IV:              p.IV,
			Ciphertext:      p.Ciphertext,
			Timestamp:       timestamp,
			BurnAfterRead:   p.BurnAfterRead,
		}),
	})
	h.Send(p.To, fwd)

	// If the receiver is not online, Aurora push is triggered (asynchronous, does not block the main process)
	h.mu.RLock()
	_, recipientOnline := h.clients[p.To]
	h.mu.RUnlock()
	if !recipientOnline && h.pushSvc != nil {
		go h.pushSvc.NotifyOfflineUser(p.To, from.ChatID)
	}

	// ack is sent back to the sender, carrying the server timestamp
	type AckPayload struct {
		MsgID     string `json:"msg_id"`
		Timestamp int64  `json:"ts"`
	}
	ack, _ := json.Marshal(Message{
		Type: "ack",
		Payload: mustMarshal(AckPayload{
			MsgID:     p.MsgID,
			Timestamp: timestamp,
		}),
	})
	// ACK cannot be silently discarded: it determines whether the sender mistakenly marked a message as failed when it was actually delivered.
	// When the queue is temporarily congested, it waits for writePump to make room; when the connection is abnormal, it falls into the offline queue and is re-invested after reconnection.
	select {
	case from.send <- ack:
	case <-time.After(2 * time.Second):
		h.storeOffline(from.ChatID, ack)
	}
}

// RecallPayload recall message payload
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
	// The withdrawal is only forwarded to online users and does not save offline users (the other party cannot receive it but it is not deleted locally, so there is no security issue)
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

// ReadPayload read receipt payload
type ReadPayload struct {
	To    string   `json:"to"`     //Message sender chat_id
	MsgID []string `json:"msg_id"` //List of read message IDs
}

// handleRead handles read receipts
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
	ctx := context.Background()
	if ok, err := h.friendSvc.AreFriends(ctx, from.UserID, p.To); err != nil || !ok {
		log.Printf("[ws] %s tried to send read receipt to non-friend %s", from.ChatID, p.To)
		return
	}
	if h.messageReadSvc == nil {
		log.Printf("[ws] read service unavailable for %s", from.ChatID)
		return
	}

	// The server verifies each item according to the delivery attribution and returns the first reading time in the database. Deduplication can avoid the same batch
	// Duplicate IDs generate redundant queries; IDs that do not belong to the sender/recipient will not be forwarded.
	uniqueIDs := make([]string, 0, len(p.MsgID))
	seen := make(map[string]struct{}, len(p.MsgID))
	for _, msgID := range p.MsgID {
		if _, exists := seen[msgID]; exists {
			continue
		}
		seen[msgID] = struct{}{}
		uniqueIDs = append(uniqueIDs, msgID)
	}
	receipts, err := h.messageReadSvc.RecordReads(ctx, uniqueIDs, p.To, from.ChatID)
	if err != nil {
		// No ACK for transient database errors, the front end retains the entire batch and retries when reconnecting/opening the session again.
		log.Printf("[ws] failed to record read batch from %s: %v", from.ChatID, err)
		return
	}
	acceptedSet := make(map[string]struct{}, len(receipts))
	for _, receipt := range receipts {
		acceptedSet[receipt.MsgID] = struct{}{}
	}
	for _, msgID := range uniqueIDs {
		if _, accepted := acceptedSet[msgID]; !accepted {
			log.Printf("[ws] rejected unowned read receipt %q from %s", msgID, from.ChatID)
		}
	}

	// Forward to the sender (push if online, save in Redis offline queue if offline)
	if len(receipts) > 0 {
		acceptedIDs := make([]string, 0, len(receipts))
		for _, receipt := range receipts {
			acceptedIDs = append(acceptedIDs, receipt.MsgID)
		}
		fwd, _ := json.Marshal(Message{
			Type: "read_receipt",
			Payload: mustMarshal(struct {
				From     string                `json:"from"`
				MsgID    []string              `json:"msg_id"`
				Receipts []service.ReadReceipt `json:"receipts"`
			}{From: from.ChatID, MsgID: acceptedIDs, Receipts: receipts}),
		})
		h.Send(p.To, fwd)
	}

	// The server completes persistence or confirms the rejection before confirming; it will not reach here when the database has a transient error.
	// Therefore, it will still stay in the front-end queue waiting for retry. receipts also returns the authoritative first reading time to the reading party.
	ack, _ := json.Marshal(Message{
		Type: "read_ack",
		Payload: mustMarshal(struct {
			To       string                `json:"to"`
			MsgID    []string              `json:"msg_id"`
			Receipts []service.ReadReceipt `json:"receipts,omitempty"`
		}{To: p.To, MsgID: uniqueIDs, Receipts: receipts}),
	})
	h.Send(from.ChatID, ack)
}

// handleReadReceiptApplied Stops database login playback after the sender has persisted the authoritative read time.
// It is not required to still be a friend: the receipt may be received by the sender who has been offline for a long time after the friend is unfriended or the reader logs out.
func (h *Hub) handleReadReceiptApplied(from *Client, payload json.RawMessage) {
	var p ReadPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		log.Printf("[ws] invalid read_receipt_applied payload from %s: %v", from.ChatID, err)
		return
	}
	if !chatIDRe.MatchString(p.To) || len(p.MsgID) == 0 || len(p.MsgID) > 100 {
		log.Printf("[ws] invalid read_receipt_applied payload from %s", from.ChatID)
		return
	}
	uniqueIDs := make([]string, 0, len(p.MsgID))
	seen := make(map[string]struct{}, len(p.MsgID))
	for _, msgID := range p.MsgID {
		if !msgIDRe.MatchString(msgID) {
			log.Printf("[ws] invalid msg_id in read_receipt_applied from %s: %q", from.ChatID, msgID)
			return
		}
		if _, exists := seen[msgID]; exists {
			continue
		}
		seen[msgID] = struct{}{}
		uniqueIDs = append(uniqueIDs, msgID)
	}
	if h.messageReadSvc == nil {
		return
	}
	if err := h.messageReadSvc.MarkReadReceiptsApplied(context.Background(), uniqueIDs, from.ChatID, p.To); err != nil {
		log.Printf("[ws] failed to mark read receipts applied for %s: %v", from.ChatID, err)
	}
}

// NotifyFriendRequest Push friend application notification to target users
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

// NotifyFriendAccepted Notifies the initiator of friend application: the other party has accepted it
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

// NotifyFriendRejected Notifies the initiator of friend application: The other party has rejected it
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

// NotifyPVPMatched Pushes PVP matching success notification to waiting players.
// The payload contains room_id / opponent / tier / stake. After receiving it, the front end switches to the battle page.
// Use blocking send + 2 seconds timeout instead of default drop: loss of matching notification will cause the waiting party to stay in
// Search page and the room becomes orphaned (pledge locked) and cannot be discarded silently.
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

// ── File transfer processing ──────────────────────────────────────────────

func (h *Hub) sendFileError(to *Client, transferID, reason string) {
	errMsg, _ := json.Marshal(Message{
		Type: "file_error",
		Payload: mustMarshal(map[string]string{
			"transfer_id": transferID,
			"reason":      reason,
		}),
	})
	select {
	case to.send <- errMsg:
	default:
	}
}

func (h *Hub) registerFileTransfer(transferID string, session *fileTransferSession) bool {
	h.fileTransferMu.Lock()
	if _, exists := h.fileTransfers[transferID]; exists {
		h.fileTransferMu.Unlock()
		return false
	}
	h.fileTransfers[transferID] = session
	h.fileTransferMu.Unlock()

	// The total time the front end waits for acceptance and completion of receipt is less than 3 minutes; regular cleaning ensures that even if both parties are disconnected,
	// Session records are not retained permanently. transfer_id is a UUID and is not allowed to be reused within the TTL.
	time.AfterFunc(fileTransferTTL, func() {
		h.fileTransferMu.Lock()
		if current := h.fileTransfers[transferID]; current == session {
			delete(h.fileTransfers, transferID)
		}
		failed := !session.done
		h.fileTransferMu.Unlock()
		// Files that are rejected, error reported, disconnected or timed out will not form chat messages and their delivery will be revoked.
		// A record of a successful file_done must be retained so that the recipient can still verify the read receipt when it is opened for the first time later.
		if failed && h.messageReadSvc != nil {
			_ = h.messageReadSvc.DeleteMessage(context.Background(), session.msgID, session.sender, session.recipient)
		}
	})
	return true
}

// FileOfferPayload file send request payload
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
	reject := func(reason string) {
		log.Printf("[ws] rejected file_offer %q from %s: %s", p.TransferID, from.ChatID, reason)
		if transferIDRe.MatchString(p.TransferID) {
			h.sendFileError(from, p.TransferID, reason)
		}
	}

	if !chatIDRe.MatchString(p.To) {
		reject("无效的接收方")
		return
	}
	if !transferIDRe.MatchString(p.TransferID) {
		log.Printf("[ws] file_offer invalid transfer_id from %s", from.ChatID)
		return
	}
	if !msgIDRe.MatchString(p.MsgID) {
		reject("无效的消息编号")
		return
	}
	if len(p.Filename) == 0 || len(p.Filename) > maxFilename {
		reject("文件名无效或过长")
		return
	}
	if !validFileMetadata(p.Filename, p.Filetype) {
		reject("不支持的文件格式或文件类型不匹配")
		return
	}
	if p.Filesize <= 0 || p.Filesize > maxFileSize {
		reject("文件大小必须大于 0 且不能超过 10MB")
		return
	}
	expectedChunks := expectedFileChunks(p.Filesize)
	if p.TotalChunks != expectedChunks || p.TotalChunks > maxTotalChunks {
		reject("文件分块数量与声明大小不匹配")
		return
	}
	if p.EphemeralPubKey == "" || p.IV == "" {
		reject("缺少文件加密参数")
		return
	}

	ctx := context.Background()
	isFriend, err := h.friendSvc.AreFriends(ctx, from.UserID, p.To)
	if err != nil || !isFriend {
		reject("只能向好友发送文件")
		return
	}
	h.mu.RLock()
	recipientClient, online := h.clients[p.To]
	h.mu.RUnlock()

	if !online {
		h.sendFileError(from, p.TransferID, "对方不在线，无法发送文件")
		return
	}
	if h.messageReadSvc == nil {
		reject("消息服务暂不可用")
		return
	}

	timestamp := time.Now().UnixMilli()
	session := &fileTransferSession{
		sender:         from.ChatID,
		recipient:      p.To,
		msgID:          p.MsgID,
		filesize:       p.Filesize,
		totalChunks:    p.TotalChunks,
		receivedChunks: make([]bool, p.TotalChunks),
		timestamp:      timestamp,
	}
	if !h.registerFileTransfer(p.TransferID, session) {
		h.sendFileError(from, p.TransferID, "传输编号重复，请重新发送")
		return
	}
	if err = h.messageReadSvc.RecordMessage(ctx, p.MsgID, from.ChatID, p.To); err != nil {
		h.fileTransferMu.Lock()
		delete(h.fileTransfers, p.TransferID)
		h.fileTransferMu.Unlock()
		log.Printf("[ws] failed to record file delivery %q from %s: %v", p.MsgID, from.ChatID, err)
		reject("无法建立安全文件传输")
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
		Timestamp       int64  `json:"ts"` //Server timestamp, based on which both ends unify the file message time
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
			Timestamp:       timestamp,
		}),
	})
	select {
	case recipientClient.send <- fwd:
	default:
		h.fileTransferMu.Lock()
		delete(h.fileTransfers, p.TransferID)
		h.fileTransferMu.Unlock()
		_ = h.messageReadSvc.DeleteMessage(ctx, p.MsgID, from.ChatID, p.To)
		h.sendFileError(from, p.TransferID, "对方连接繁忙，请稍后重试")
	}
}

// handleFileChunk relay file data chunk
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
		h.sendFileError(from, p.TransferID, "文件分块序号无效")
		return
	}
	if len(p.Data) == 0 || len(p.Data) > maxChunkData {
		log.Printf("[ws] file_chunk invalid data length %d from %s", len(p.Data), from.ChatID)
		h.sendFileError(from, p.TransferID, "文件分块大小无效")
		return
	}

	h.fileTransferMu.Lock()
	session, ok := h.fileTransfers[p.TransferID]
	if !ok {
		h.fileTransferMu.Unlock()
		h.sendFileError(from, p.TransferID, "文件传输不存在或已过期")
		return
	}
	if from.ChatID != session.sender || p.To != session.recipient {
		h.fileTransferMu.Unlock()
		h.sendFileError(from, p.TransferID, "无权发送该文件分块")
		return
	}
	if !session.accepted {
		h.fileTransferMu.Unlock()
		h.sendFileError(from, p.TransferID, "接收方尚未接受文件传输")
		return
	}
	if p.ChunkIndex >= session.totalChunks {
		h.fileTransferMu.Unlock()
		h.sendFileError(from, p.TransferID, "文件分块序号超出范围")
		return
	}
	if session.receivedChunks[p.ChunkIndex] {
		h.fileTransferMu.Unlock()
		h.sendFileError(from, p.TransferID, "收到重复的文件分块")
		return
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(p.Data)
	if err != nil || len(decoded) != expectedFileChunkSize(session.filesize, p.ChunkIndex) {
		h.fileTransferMu.Unlock()
		h.sendFileError(from, p.TransferID, "文件分块内容或长度无效")
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
	c, online := h.clients[p.To]
	h.mu.RUnlock()
	if !online {
		delete(h.fileTransfers, p.TransferID)
		h.fileTransferMu.Unlock()
		h.sendFileError(from, p.TransferID, "接收方已离线，文件传输中断")
		return
	}
	select {
	case c.send <- fwd:
		session.receivedChunks[p.ChunkIndex] = true
		session.receivedCount++
		h.fileTransferMu.Unlock()
	default:
		delete(h.fileTransfers, p.TransferID)
		h.fileTransferMu.Unlock()
		log.Printf("[ws] file_chunk dropped for %s (buffer full)", p.To)
		h.sendFileError(from, p.TransferID, "接收方连接繁忙，文件传输中断")
	}
}

// handleFileSimpleRelay relay file_accept/file_reject/file_complete/file_error
func (h *Hub) handleFileSimpleRelay(from *Client, msgType string, payload json.RawMessage) {
	var p struct {
		To         string `json:"to"`
		TransferID string `json:"transfer_id"`
		Reason     string `json:"reason,omitempty"`
		Timestamp  int64  `json:"ts,omitempty"` //file_done returns the server timestamp of file_offer
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		log.Printf("[ws] invalid %s from %s: %v", msgType, from.ChatID, err)
		return
	}
	if !chatIDRe.MatchString(p.To) || !transferIDRe.MatchString(p.TransferID) {
		log.Printf("[ws] invalid %s fields from %s", msgType, from.ChatID)
		return
	}
	if len(p.Reason) > 512 {
		h.sendFileError(from, p.TransferID, "文件传输错误信息过长")
		return
	}

	h.fileTransferMu.Lock()
	session, ok := h.fileTransfers[p.TransferID]
	if !ok {
		h.fileTransferMu.Unlock()
		// Silently ignore late file_complete/file_error for completed sessions to avoid showing failure after success.
		if msgType != "file_complete" && msgType != "file_error" {
			h.sendFileError(from, p.TransferID, "文件传输不存在或已过期")
		}
		return
	}

	senderToRecipient := from.ChatID == session.sender && p.To == session.recipient
	recipientToSender := from.ChatID == session.recipient && p.To == session.sender
	deleteAfterRelay := false
	switch msgType {
	case "file_accept":
		if !recipientToSender {
			h.fileTransferMu.Unlock()
			h.sendFileError(from, p.TransferID, "无权接受该文件传输")
			return
		}
	case "file_reject":
		if !recipientToSender {
			h.fileTransferMu.Unlock()
			h.sendFileError(from, p.TransferID, "无权拒绝该文件传输")
			return
		}
		deleteAfterRelay = true
	case "file_complete":
		if !senderToRecipient || !session.accepted {
			h.fileTransferMu.Unlock()
			h.sendFileError(from, p.TransferID, "无权完成该文件传输")
			return
		}
		if session.receivedCount != session.totalChunks {
			delete(h.fileTransfers, p.TransferID)
			h.fileTransferMu.Unlock()
			h.sendFileError(from, p.TransferID, "文件分块未完整送达")
			return
		}
	case "file_done":
		if !recipientToSender || !session.accepted || session.receivedCount != session.totalChunks {
			h.fileTransferMu.Unlock()
			h.sendFileError(from, p.TransferID, "无权确认该文件传输")
			return
		}
		p.Timestamp = session.timestamp
	case "file_error":
		if !senderToRecipient && !recipientToSender {
			h.fileTransferMu.Unlock()
			h.sendFileError(from, p.TransferID, "无权终止该文件传输")
			return
		}
		deleteAfterRelay = true
	}

	type Forward struct {
		From       string `json:"from"`
		TransferID string `json:"transfer_id"`
		MsgID      string `json:"msg_id,omitempty"`
		Reason     string `json:"reason,omitempty"`
		Timestamp  int64  `json:"ts,omitempty"`
	}
	fwd, _ := json.Marshal(Message{
		Type: msgType,
		Payload: mustMarshal(Forward{
			From:       from.ChatID,
			TransferID: p.TransferID,
			MsgID:      session.msgID,
			Reason:     p.Reason,
			Timestamp:  p.Timestamp,
		}),
	})

	// After the receiving end has completed decryption and placed it on disk, file_done is the final result that cannot be lost. Regardless of the sender at the moment
	// Whether it is online, the buffer is full, or just disconnected, the session will be marked as successful and online/offline re-investment will be done through universal Send.
	if msgType == "file_done" {
		session.done = true
		delete(h.fileTransfers, p.TransferID)
		h.fileTransferMu.Unlock()
		h.Send(p.To, fwd)
		return
	}

	h.mu.RLock()
	c, online := h.clients[p.To]
	h.mu.RUnlock()
	if !online {
		delete(h.fileTransfers, p.TransferID)
		h.fileTransferMu.Unlock()
		h.sendFileError(from, p.TransferID, "对方已离线，文件传输中断")
		return
	}
	select {
	case c.send <- fwd:
		if msgType == "file_accept" {
			session.accepted = true
		}
		if deleteAfterRelay {
			delete(h.fileTransfers, p.TransferID)
		}
		h.fileTransferMu.Unlock()
	default:
		delete(h.fileTransfers, p.TransferID)
		h.fileTransferMu.Unlock()
		h.sendFileError(from, p.TransferID, "对方连接繁忙，文件传输中断")
	}
}

// ── Voice call signaling processing ───────────────────────────────────────────────

// handleCallOffer forwards call invitation (including friend verification)
func (h *Hub) handleCallOffer(from *Client, payload json.RawMessage) {
	var p struct {
		To           string          `json:"to"`
		CallID       string          `json:"call_id"`
		SDP          json.RawMessage `json:"sdp"`
		Media        string          `json:"media"` //audio | video (processed by audio by default)
		VideoEnabled *bool           `json:"video_enabled,omitempty"`
	}
	if err := json.Unmarshal(payload, &p); err != nil ||
		!chatIDRe.MatchString(p.To) || !transferIDRe.MatchString(p.CallID) || len(p.SDP) == 0 {
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

	inner := map[string]any{
		"from":    from.ChatID,
		"call_id": p.CallID,
		"sdp":     p.SDP,
		"media":   media,
	}
	if p.VideoEnabled != nil {
		inner["video_enabled"] = *p.VideoEnabled
	}
	fwd, _ := json.Marshal(Message{
		Type:    "call_offer",
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

type callRelayPayload struct {
	To           string          `json:"to"`
	CallID       string          `json:"call_id"`
	SDP          json.RawMessage `json:"sdp,omitempty"`
	ICE          json.RawMessage `json:"ice,omitempty"`
	Reason       string          `json:"reason,omitempty"`
	VideoEnabled *bool           `json:"video_enabled,omitempty"`
}

func parseCallRelayPayload(msgType string, payload json.RawMessage) (callRelayPayload, bool) {
	var p callRelayPayload
	if err := json.Unmarshal(payload, &p); err != nil ||
		!chatIDRe.MatchString(p.To) || !transferIDRe.MatchString(p.CallID) {
		return callRelayPayload{}, false
	}
	if (msgType == "call_answer" || msgType == "call_restart_offer" || msgType == "call_restart_answer") && len(p.SDP) == 0 {
		return callRelayPayload{}, false
	}
	if msgType == "call_ice" && len(p.ICE) == 0 {
		return callRelayPayload{}, false
	}
	if msgType == "call_media_state" && p.VideoEnabled == nil {
		return callRelayPayload{}, false
	}
	return p, true
}

func buildCallRelayPayload(from, msgType string, p callRelayPayload) map[string]any {
	inner := map[string]any{"from": from, "call_id": p.CallID}
	if len(p.SDP) > 0 {
		inner["sdp"] = p.SDP
	}
	if len(p.ICE) > 0 {
		inner["ice"] = p.ICE
	}
	if p.VideoEnabled != nil {
		inner["video_enabled"] = *p.VideoEnabled
	}
	if msgType == "call_reject" {
		switch p.Reason {
		case "busy", "device_error", "rejected", "timeout", "glare":
			inner["reason"] = p.Reason
		default:
			inner["reason"] = "rejected"
		}
	}
	return inner
}

// handleCallRelay forwards call session signaling after validating friendship.
func (h *Hub) handleCallRelay(from *Client, msgType string, payload json.RawMessage) {
	p, ok := parseCallRelayPayload(msgType, payload)
	if !ok {
		log.Printf("[ws] invalid %s from %s", msgType, from.ChatID)
		return
	}

	// Subsequent signaling must also occur between friends and cannot only protect the offer. The client also uses call_id and
	// The current peer performs session-level verification, forming a double line of defense of server authorization + client status binding.
	ctx := context.Background()
	if ok, err := h.friendSvc.AreFriends(ctx, from.UserID, p.To); err != nil || !ok {
		log.Printf("[ws] %s: %s not friends with %s", msgType, from.ChatID, p.To)
		return
	}

	fwd, _ := json.Marshal(Message{
		Type:    msgType,
		Payload: mustMarshal(buildCallRelayPayload(from.ChatID, msgType, p)),
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
		To     string `json:"to"`
		Game   string `json:"game"`
		RoomID string `json:"room_id"`
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
		if header.Game == "ironfist" {
			if header.RoomID == "" || h.ironFistSvc == nil {
				return
			}
			record, _ := json.Marshal(ironFistInviteRecord{
				InviterUserID: from.UserID, InviterChatID: from.ChatID,
				InviteeChatID: header.To, RoomID: header.RoomID,
			})
			if err := h.redis.Set(context.Background(), pkgredis.IronFistInviteKey(header.RoomID), record, pkgredis.IronFistInviteTTL).Err(); err != nil {
				log.Printf("[ws] persist IronFist invite: %v", err)
				return
			}
		}
	}
	if msgType == "game_accept" && header.Game == "ironfist" {
		h.handleIronFistInviteAccept(from, header.To, header.RoomID)
		return
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

	// When game_resign, clear the action log of the Tekken room (if the payload contains room_id).
	// The non-Tekken game payload will not have room_id, so just skip it.
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

type ironFistInviteRecord struct {
	InviterUserID uint64 `json:"inviter_user_id"`
	InviterChatID string `json:"inviter_chat_id"`
	InviteeChatID string `json:"invitee_chat_id"`
	RoomID        string `json:"room_id"`
}

func (h *Hub) handleIronFistInviteAccept(from *Client, toChatID, roomID string) {
	if h.ironFistSvc == nil || h.friendSvc == nil || roomID == "" {
		return
	}
	const consume = `local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v`
	raw, err := h.redis.Eval(context.Background(), consume, []string{pkgredis.IronFistInviteKey(roomID)}).Text()
	if err != nil {
		return
	}
	var invite ironFistInviteRecord
	if json.Unmarshal([]byte(raw), &invite) != nil || invite.RoomID != roomID ||
		invite.InviteeChatID != from.ChatID || invite.InviterChatID != toChatID {
		return
	}
	friends, err := h.friendSvc.AreFriends(context.Background(), from.UserID, invite.InviterChatID)
	if err != nil || !friends {
		return
	}
	view, err := h.ironFistSvc.CreateCasualAuthoritativeGame(context.Background(), invite.InviterUserID, from.UserID)
	if err != nil {
		log.Printf("[ws] create casual authoritative IronFist game: %v", err)
		return
	}
	h.sendGameReady(invite.InviterChatID, map[string]any{
		"game": "ironfist", "room_id": roomID, "game_id": view.GameID,
		"opponent": from.ChatID, "seat": "a",
	})
	h.sendGameReady(from.ChatID, map[string]any{
		"game": "ironfist", "room_id": roomID, "game_id": view.GameID,
		"opponent": invite.InviterChatID, "seat": "b",
	})
}

func (h *Hub) sendGameReady(chatID string, payload map[string]any) {
	message, _ := json.Marshal(Message{Type: "game_ready", Payload: mustMarshal(payload)})
	h.mu.RLock()
	client := h.clients[chatID]
	h.mu.RUnlock()
	if client != nil {
		select {
		case client.send <- message:
		default:
		}
	}
}

func mustMarshal(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

// handleIronFistLobbyJoin Joins the PVP lobby online list.
// Sent when the client enters the PVP lobby page; the server queries the user profile and stores it in pvpLobby.
// And broadcast the latest list to all users present (including myself).
func (h *Hub) handleIronFistLobbyJoin(c *Client) {
	if h.ironFistSvc == nil {
		return
	}
	// Current limiting: Joining will trigger DB query + O(N) broadcast in the whole hall, strict frequency limitation to prevent broadcast storms.
	if !c.lobbyLimiter.allow(time.Now(), lobbyMaxPerSec) {
		return
	}
	// Query files (do not perform DB queries during the lock period to avoid blocking other dispatches)
	ctx := context.Background()
	p, err := h.ironFistSvc.GetLobbyUserProfile(ctx, c.ChatID)
	if err != nil {
		log.Printf("[ws] ironfist_lobby_join get profile for %s: %v", c.ChatID, err)
		return
	}

	h.mu.Lock()
	// If it already exists, it will be overwritten (profile may change: balance/session update)
	h.pvpLobby[c.ChatID] = p
	// Copy the current list for broadcast
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

// handleIronFistLobbyLeave voluntarily leaves the PVP lobby
func (h *Hub) handleIronFistLobbyLeave(c *Client) {
	// Shared lobby flow limiter: Blocks broadcast storms triggered by join/leave fast switching back and forth.
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
	// Those who left will also receive updates (clear their own list display)
	if rc, ok := h.clients[c.ChatID]; ok {
		recipients = append(recipients, rc)
	}
	h.mu.Unlock()

	h.sendLobbyUpdate(recipients, list)
}

// broadcastLobbyUpdate broadcasts the latest list to all online users in the current lobby.
// Used for disconnection/abnormal offline scenarios (Unregister path). At this time, the leaver is no longer reachable and does not need to be sent back.
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

// sendLobbyUpdate assembles and broadcasts lobby list messages
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
