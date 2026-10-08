package service

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var (
	ErrGroupNotFound     = errors.New("group not found")
	ErrNotGroupMember    = errors.New("not a group member")
	ErrGroupFull         = errors.New("group is full")
	ErrTooFewMembers     = errors.New("at least 2 members required")
	ErrDuplicateMember   = errors.New("member already in group")
	ErrMessageNotFound   = errors.New("message not found")
	ErrNotMessageSender  = errors.New("not the message sender")
	ErrMemberMuted       = errors.New("member is muted")
	ErrMembershipChanged = errors.New("membership changed since encryption")
	ErrUserNotReady      = errors.New("user has not uploaded a public key")
)

const (
	GroupMaxMembers            = 10
	GroupRecallLimitHours      = 144
	GroupMessageMaxCiphertextB = 8192
)

var (
	groupIDPattern = regexp.MustCompile(`^G-[0-9A-F]{12}$`)
	chatIDPattern  = regexp.MustCompile(`^\d{4}-[A-Z]{4}$`)
)

// GroupService manages admin-managed groups, membership, muting, message
// persistence, self-recall, and admin deletion.
type GroupService struct {
	db *sql.DB
}

func NewGroupService(db *sql.DB) *GroupService {
	return &GroupService{db: db}
}

// GroupSummary is the list item returned by ListMyGroups / ListGroupsWithCounts.
type GroupSummary struct {
	GroupID       string     `json:"group_id"`
	Name          string     `json:"name"`
	MemberCount   int        `json:"member_count"`
	LastMessageAt *time.Time `json:"last_message_at"`
}

// GroupMemberView is a member entry in GetGroupDetail.
type GroupMemberView struct {
	ChatID     string     `json:"chat_id"`
	Nickname   string     `json:"nickname"`
	PublicKey  string     `json:"public_key"`
	MutedUntil *time.Time `json:"muted_until"`
	State      string     `json:"state"`
}

// GroupDetail is the full group view returned to members.
type GroupDetailView struct {
	GroupID   string             `json:"group_id"`
	Name      string             `json:"name"`
	CreatedAt time.Time          `json:"created_at"`
	Members   []*GroupMemberView `json:"members"`
}

// AdminGroupDetail includes member states for the admin panel.
type AdminGroupDetailView struct {
	GroupID   string             `json:"group_id"`
	Name      string             `json:"name"`
	CreatedAt time.Time          `json:"created_at"`
	Members   []*GroupMemberView `json:"members"`
}

// GroupMessageMetadata is the admin-panel ciphertext-only listing.
type GroupMessageMetadata struct {
	MsgID        string     `json:"msg_id"`
	SenderChatID string     `json:"sender_chat_id"`
	SentAt       time.Time  `json:"sent_at"`
	EnvelopeSize int        `json:"envelope_size"`
	RecalledAt   *time.Time `json:"recalled_at"`
	DeletedAt    *time.Time `json:"deleted_at"`
}

// KeyEnvelope is one member's encrypted content key.
type KeyEnvelope struct {
	To              string `json:"to"`
	EphemeralPubKey string `json:"ephemeral_pub_key"`
	IV              string `json:"iv"`
	KeyCiphertext   string `json:"key_ciphertext"`
}

// generateGroupID creates a new G- + 12 uppercase hex group ID.
func generateGroupID() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "G-" + strings.ToUpper(hex.EncodeToString(b)), nil
}

// validateGroupName checks non-empty and <= 64 UTF-8 bytes.
func validateGroupName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return errors.New("group name is required")
	}
	if len([]byte(name)) > 64 {
		return errors.New("group name too long")
	}
	return nil
}

// resolveUserIDsByChatIDs validates chat IDs exist and have is_ready=1.
// Returns a map chatID->userID.
func (s *GroupService) resolveUserIDsByChatIDs(ctx context.Context, chatIDs []string) (map[string]uint64, error) {
	result := make(map[string]uint64, len(chatIDs))
	for _, chatID := range chatIDs {
		if !chatIDPattern.MatchString(chatID) {
			return nil, fmt.Errorf("invalid chat id: %s", chatID)
		}
		var id uint64
		var isReady bool
		err := s.db.QueryRowContext(ctx,
			`SELECT id, is_ready FROM users WHERE chat_id = ?`, chatID,
		).Scan(&id, &isReady)
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("user not found: %s", chatID)
		}
		if err != nil {
			return nil, err
		}
		if !isReady {
			return nil, ErrUserNotReady
		}
		result[chatID] = id
	}
	return result, nil
}

// CreateGroup creates a group with the given name and initial members.
// The admin-managed model has no owner column.
func (s *GroupService) CreateGroup(ctx context.Context, name string, memberChatIDs []string) (*GroupSummary, error) {
	if err := validateGroupName(name); err != nil {
		return nil, err
	}
	// deduplicate
	seen := make(map[string]bool)
	unique := make([]string, 0, len(memberChatIDs))
	for _, id := range memberChatIDs {
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	if len(unique) < 2 {
		return nil, ErrTooFewMembers
	}
	if len(unique) > GroupMaxMembers {
		return nil, ErrGroupFull
	}
	userIDs, err := s.resolveUserIDsByChatIDs(ctx, unique)
	if err != nil {
		return nil, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// retry group_id generation on collision (rare)
	var groupID string
	for attempt := 0; attempt < 3; attempt++ {
		groupID, err = generateGroupID()
		if err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx,
			`INSERT INTO ` + "`groups`" + ` (group_id, name) VALUES (?, ?)`, groupID, strings.TrimSpace(name))
		if err == nil {
			break
		}
		// check for duplicate key — retry
		if strings.Contains(err.Error(), "1062") {
			err = nil
			continue
		}
		return nil, fmt.Errorf("insert group: %w", err)
	}
	if err != nil {
		return nil, err
	}

	var groupDBID uint64
	if err = tx.QueryRowContext(ctx, `SELECT id FROM ` + "`groups`" + ` WHERE group_id = ?`, groupID).Scan(&groupDBID); err != nil {
		return nil, err
	}

	for _, chatID := range unique {
		uid := userIDs[chatID]
		if _, err = tx.ExecContext(ctx,
			`INSERT INTO group_members (group_db_id, user_id, state) VALUES (?, ?, 'active')`,
			groupDBID, uid); err != nil {
			return nil, fmt.Errorf("insert member: %w", err)
		}
	}

	if err = tx.Commit(); err != nil {
		return nil, err
	}

	return &GroupSummary{GroupID: groupID, Name: strings.TrimSpace(name), MemberCount: len(unique)}, nil
}

// DissolveGroup removes all rows for the group.
func (s *GroupService) DissolveGroup(ctx context.Context, groupID string) error {
	if !groupIDPattern.MatchString(groupID) {
		return ErrGroupNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var groupDBID uint64
	err = tx.QueryRowContext(ctx, `SELECT id FROM ` + "`groups`" + ` WHERE group_id = ? FOR UPDATE`, groupID).Scan(&groupDBID)
	if err == sql.ErrNoRows {
		return ErrGroupNotFound
	}
	if err != nil {
		return err
	}

	// CASCADE deletes group_members, group_messages, group_message_deliveries
	if _, err = tx.ExecContext(ctx, `DELETE FROM ` + "`groups`" + ` WHERE id = ?`, groupDBID); err != nil {
		return err
	}
	return tx.Commit()
}

// PendingGroupMessage is a pending group message delivery with its key envelope.
type PendingGroupMessage struct {
	MsgID        string    `json:"msg_id"`
	GroupID      string    `json:"group_id"`
	SenderChatID string    `json:"sender_chat_id"`
	IV           string    `json:"iv"`
	Ciphertext   string    `json:"ciphertext"`
	KeyEnvelope  string    `json:"key_envelope"`
	SentAt       time.Time `json:"sent_at"`
	RecalledAt   *time.Time `json:"recalled_at"`
	DeletedAt    *time.Time `json:"deleted_at"`
}

// PendingGroupTombstone is a pending recall/delete tombstone for replay.
type PendingGroupTombstone struct {
	MsgID     string     `json:"msg_id"`
	GroupID   string     `json:"group_id"`
	Kind      string     `json:"kind"` // "recall" or "delete"
	Timestamp time.Time  `json:"timestamp"`
}

// AcceptGroupMessage persists one ciphertext + N per-member delivery rows.
// Validates envelopes cover exactly the active members excluding the sender.
// Returns (sentAt, created, error). created=false means duplicate msg_id.
func (s *GroupService) AcceptGroupMessage(ctx context.Context, senderChatID, groupID, msgID, iv, ciphertext string, envelopes []KeyEnvelope) (time.Time, bool, error) {
	if !groupIDPattern.MatchString(groupID) {
		return time.Time{}, false, ErrGroupNotFound
	}
	if !chatIDPattern.MatchString(senderChatID) {
		return time.Time{}, false, ErrNotMessageSender
	}
	if !msgIDRe.MatchString(msgID) {
		return time.Time{}, false, errors.New("invalid msg_id")
	}
	if iv == "" || ciphertext == "" {
		return time.Time{}, false, errors.New("invalid payload")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return time.Time{}, false, err
	}
	defer tx.Rollback()

	var groupDBID uint64
	err = tx.QueryRowContext(ctx, `SELECT id FROM ` + "`groups`" + ` WHERE group_id = ? FOR UPDATE`, groupID).Scan(&groupDBID)
	if err == sql.ErrNoRows {
		return time.Time{}, false, ErrGroupNotFound
	}
	if err != nil {
		return time.Time{}, false, err
	}

	// check mute
	muted, err := s.isMutedTx(ctx, tx, groupDBID, senderChatID)
	if err != nil {
		return time.Time{}, false, err
	}
	if muted {
		return time.Time{}, false, ErrMemberMuted
	}

	// verify sender is an active member
	if !s.isMemberTx(ctx, tx, groupDBID, senderChatID) {
		return time.Time{}, false, ErrNotGroupMember
	}

	// get active members excluding sender
	activeMembers := make(map[string]bool) // chatID -> true
	rows, err := tx.QueryContext(ctx, `
		SELECT u.chat_id FROM group_members gm
		JOIN users u ON u.id = gm.user_id
		WHERE gm.group_db_id = ? AND gm.state = 'active'`, groupDBID)
	if err != nil {
		return time.Time{}, false, err
	}
	for rows.Next() {
		var chatID string
		if err = rows.Scan(&chatID); err != nil {
			rows.Close()
			return time.Time{}, false, err
		}
		if chatID != senderChatID {
			activeMembers[chatID] = true
		}
	}
	rows.Close()

	// validate envelope count matches active members (excluding sender)
	if len(envelopes) != len(activeMembers) {
		return time.Time{}, false, ErrMembershipChanged
	}
	seen := make(map[string]bool, len(envelopes))
	for _, env := range envelopes {
		if !chatIDPattern.MatchString(env.To) || !activeMembers[env.To] || seen[env.To] {
			return time.Time{}, false, ErrMembershipChanged
		}
		seen[env.To] = true
	}

	// check duplicate msg_id
	var existingSentAt *time.Time
	err = tx.QueryRowContext(ctx, `SELECT sent_at FROM group_messages WHERE msg_id = ?`, msgID).Scan(&existingSentAt)
	if err == nil {
		// duplicate — idempotent
		if existingSentAt != nil {
			return *existingSentAt, false, nil
		}
		return time.Time{}, false, nil
	}
	if err != sql.ErrNoRows {
		return time.Time{}, false, err
	}

	// insert message
	envelopeSize := len(ciphertext)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO group_messages (msg_id, group_db_id, sender_chat_id, iv, ciphertext, envelope_size, sent_at)
		VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
		msgID, groupDBID, senderChatID, iv, ciphertext, envelopeSize)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("insert group message: %w", err)
	}

	// insert per-member delivery rows
	for _, env := range envelopes {
		envJSON, _ := json.Marshal(env)
		_, err = tx.ExecContext(ctx, `
			INSERT INTO group_message_deliveries (msg_id, member_chat_id, key_envelope)
			VALUES (?, ?, ?)`,
			msgID, env.To, string(envJSON))
		if err != nil {
			return time.Time{}, false, fmt.Errorf("insert delivery: %w", err)
		}
	}

	if err = tx.Commit(); err != nil {
		return time.Time{}, false, err
	}

	// fetch the actual sent_at
	var sentAt time.Time
	_ = s.db.QueryRowContext(ctx, `SELECT sent_at FROM group_messages WHERE msg_id = ?`, msgID).Scan(&sentAt)
	return sentAt, true, nil
}

// GetPendingGroupMessages returns un-applied group messages for a member.
func (s *GroupService) GetPendingGroupMessages(ctx context.Context, memberChatID string, limit int) ([]*PendingGroupMessage, error) {
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT gmd.msg_id, g.group_id, gm.sender_chat_id, gm.iv, gm.ciphertext, gmd.key_envelope, gm.sent_at, gm.recalled_at, gm.deleted_at
		FROM group_message_deliveries gmd
		JOIN group_messages gm ON gm.msg_id = gmd.msg_id
		JOIN ` + "`groups`" + ` g ON g.id = gm.group_db_id
		WHERE gmd.member_chat_id = ? AND gmd.applied_at IS NULL
			AND gm.deleted_at IS NULL AND gm.recalled_at IS NULL
		ORDER BY gm.sent_at ASC
		LIMIT ?`, memberChatID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []*PendingGroupMessage
	for rows.Next() {
		m := &PendingGroupMessage{}
		if err = rows.Scan(&m.MsgID, &m.GroupID, &m.SenderChatID, &m.IV, &m.Ciphertext, &m.KeyEnvelope, &m.SentAt, &m.RecalledAt, &m.DeletedAt); err != nil {
			return nil, err
		}
		result = append(result, m)
	}
	return result, nil
}

// MarkGroupMessagesApplied marks delivery rows as applied (recipient confirmed).
func (s *GroupService) MarkGroupMessagesApplied(ctx context.Context, msgIDs []string, memberChatID string) error {
	if len(msgIDs) == 0 {
		return nil
	}
	placeholders := strings.Repeat("?,", len(msgIDs))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]interface{}, 0, len(msgIDs)+1)
	for _, id := range msgIDs {
		args = append(args, id)
	}
	args = append(args, memberChatID)
	_, err := s.db.ExecContext(ctx,
		`UPDATE group_message_deliveries SET applied_at = CURRENT_TIMESTAMP(3)
		 WHERE msg_id IN (`+placeholders+`) AND member_chat_id = ?`,
		args...)
	return err
}

// GetPendingGroupTombstones returns un-applied recall/delete tombstones for a member.
func (s *GroupService) GetPendingGroupTombstones(ctx context.Context, memberChatID string, limit int) ([]*PendingGroupTombstone, error) {
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT gmd.msg_id, g.group_id,
			CASE WHEN gm.recalled_at IS NOT NULL THEN 'recall' ELSE 'delete' END AS kind,
			COALESCE(gm.recalled_at, gm.deleted_at) AS ts
		FROM group_message_deliveries gmd
		JOIN group_messages gm ON gm.msg_id = gmd.msg_id
		JOIN ` + "`groups`" + ` g ON g.id = gm.group_db_id
		WHERE gmd.member_chat_id = ? AND gmd.removed_applied_at IS NULL
			AND (gm.recalled_at IS NOT NULL OR gm.deleted_at IS NOT NULL)
		ORDER BY ts ASC
		LIMIT ?`, memberChatID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []*PendingGroupTombstone
	for rows.Next() {
		t := &PendingGroupTombstone{}
		if err = rows.Scan(&t.MsgID, &t.GroupID, &t.Kind, &t.Timestamp); err != nil {
			return nil, err
		}
		result = append(result, t)
	}
	return result, nil
}

// MarkGroupTombstonesApplied marks tombstone delivery rows as applied.
func (s *GroupService) MarkGroupTombstonesApplied(ctx context.Context, msgIDs []string, memberChatID string) error {
	if len(msgIDs) == 0 {
		return nil
	}
	placeholders := strings.Repeat("?,", len(msgIDs))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]interface{}, 0, len(msgIDs)+1)
	for _, id := range msgIDs {
		args = append(args, id)
	}
	args = append(args, memberChatID)
	_, err := s.db.ExecContext(ctx,
		`UPDATE group_message_deliveries SET removed_applied_at = CURRENT_TIMESTAMP(3)
		 WHERE msg_id IN (`+placeholders+`) AND member_chat_id = ?`,
		args...)
	return err
}

// isMutedTx checks mute status within a transaction.
func (s *GroupService) isMutedTx(ctx context.Context, tx *sql.Tx, groupDBID uint64, chatID string) (bool, error) {
	var mutedUntil *time.Time
	err := tx.QueryRowContext(ctx, `
		SELECT gm.muted_until FROM group_members gm
		JOIN users u ON u.id = gm.user_id
		WHERE gm.group_db_id = ? AND u.chat_id = ? AND gm.state = 'active'`,
		groupDBID, chatID).Scan(&mutedUntil)
	if err == sql.ErrNoRows {
		return false, ErrNotGroupMember
	}
	if err != nil {
		return false, err
	}
	if mutedUntil == nil {
		return false, nil
	}
	return mutedUntil.After(time.Now()), nil
}

// isMemberTx checks membership within a transaction.
func (s *GroupService) isMemberTx(ctx context.Context, tx *sql.Tx, groupDBID uint64, chatID string) bool {
	var count int
	err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM group_members gm
		JOIN users u ON u.id = gm.user_id
		WHERE gm.group_db_id = ? AND u.chat_id = ? AND gm.state = 'active'`,
		groupDBID, chatID).Scan(&count)
	if err != nil {
		return false
	}
	return count > 0
}

// msgIDRe matches the client-generated message ID format.
var msgIDRe = regexp.MustCompile(`^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$`)

// AddMembers adds members to a group.
func (s *GroupService) AddMembers(ctx context.Context, groupID string, chatIDs []string) error {
	if !groupIDPattern.MatchString(groupID) {
		return ErrGroupNotFound
	}
	// deduplicate
	seen := make(map[string]bool)
	unique := make([]string, 0, len(chatIDs))
	for _, id := range chatIDs {
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	if len(unique) == 0 {
		return errors.New("no members to add")
	}
	userIDs, err := s.resolveUserIDsByChatIDs(ctx, unique)
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var groupDBID uint64
	err = tx.QueryRowContext(ctx, `SELECT id FROM ` + "`groups`" + ` WHERE group_id = ? FOR UPDATE`, groupID).Scan(&groupDBID)
	if err == sql.ErrNoRows {
		return ErrGroupNotFound
	}
	if err != nil {
		return err
	}

	// count active members
	var activeCount int
	if err = tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM group_members WHERE group_db_id = ? AND state = 'active'`, groupDBID,
	).Scan(&activeCount); err != nil {
		return err
	}

	// check which are already active members
	existingActive := make(map[uint64]bool)
	for _, chatID := range unique {
		uid := userIDs[chatID]
		var state string
		err := tx.QueryRowContext(ctx,
			`SELECT state FROM group_members WHERE group_db_id = ? AND user_id = ?`, groupDBID, uid,
		).Scan(&state)
		if err == nil && state == "active" {
			existingActive[uid] = true
		}
	}

	toAdd := len(unique) - len(existingActive)
	if activeCount+toAdd > GroupMaxMembers {
		return ErrGroupFull
	}

	for _, chatID := range unique {
		uid := userIDs[chatID]
		if existingActive[uid] {
			continue
		}
		// upsert: if a removed row exists, reactivate; otherwise insert
		_, err = tx.ExecContext(ctx,
			`INSERT INTO group_members (group_db_id, user_id, state) VALUES (?, ?, 'active')
			 ON DUPLICATE KEY UPDATE state = 'active', muted_until = NULL`,
			groupDBID, uid)
		if err != nil {
			return fmt.Errorf("add member: %w", err)
		}
	}
	return tx.Commit()
}

// RemoveMember sets state='removed' and deletes pending delivery rows.
func (s *GroupService) RemoveMember(ctx context.Context, groupID, chatID string) error {
	if !groupIDPattern.MatchString(groupID) {
		return ErrGroupNotFound
	}
	if !chatIDPattern.MatchString(chatID) {
		return ErrUserNotFound
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var groupDBID uint64
	err = tx.QueryRowContext(ctx, `SELECT id FROM ` + "`groups`" + ` WHERE group_id = ? FOR UPDATE`, groupID).Scan(&groupDBID)
	if err == sql.ErrNoRows {
		return ErrGroupNotFound
	}
	if err != nil {
		return err
	}

	var userID uint64
	err = tx.QueryRowContext(ctx, `SELECT id FROM users WHERE chat_id = ?`, chatID).Scan(&userID)
	if err == sql.ErrNoRows {
		return ErrUserNotFound
	}
	if err != nil {
		return err
	}

	res, err := tx.ExecContext(ctx,
		`UPDATE group_members SET state = 'removed', muted_until = NULL WHERE group_db_id = ? AND user_id = ? AND state = 'active'`,
		groupDBID, userID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotGroupMember
	}

	// delete pending delivery rows so reconnect replays nothing
	if _, err = tx.ExecContext(ctx,
		`DELETE FROM group_message_deliveries WHERE member_chat_id = ? AND applied_at IS NULL AND msg_id IN (
			SELECT msg_id FROM group_messages WHERE group_db_id = ?)`,
		chatID, groupDBID); err != nil {
		return err
	}
	return tx.Commit()
}

// RenameGroup updates the group name.
func (s *GroupService) RenameGroup(ctx context.Context, groupID, name string) error {
	if err := validateGroupName(name); err != nil {
		return err
	}
	if !groupIDPattern.MatchString(groupID) {
		return ErrGroupNotFound
	}
	res, err := s.db.ExecContext(ctx, `UPDATE ` + "`groups`" + ` SET name = ? WHERE group_id = ?`, strings.TrimSpace(name), groupID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrGroupNotFound
	}
	return nil
}

// MuteMember sets muted_until for a member.
func (s *GroupService) MuteMember(ctx context.Context, groupID, chatID string, until *time.Time) error {
	if !groupIDPattern.MatchString(groupID) {
		return ErrGroupNotFound
	}
	if !chatIDPattern.MatchString(chatID) {
		return ErrUserNotFound
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var groupDBID uint64
	err = tx.QueryRowContext(ctx, `SELECT id FROM ` + "`groups`" + ` WHERE group_id = ? FOR UPDATE`, groupID).Scan(&groupDBID)
	if err == sql.ErrNoRows {
		return ErrGroupNotFound
	}
	if err != nil {
		return err
	}

	var userID uint64
	err = tx.QueryRowContext(ctx, `SELECT id FROM users WHERE chat_id = ?`, chatID).Scan(&userID)
	if err == sql.ErrNoRows {
		return ErrUserNotFound
	}
	if err != nil {
		return err
	}

	// NULL until means unmute
	var sqlUntil interface{}
	if until != nil {
		sqlUntil = *until
	}

	res, err := tx.ExecContext(ctx,
		`UPDATE group_members SET muted_until = ? WHERE group_db_id = ? AND user_id = ? AND state = 'active'`,
		sqlUntil, groupDBID, userID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotGroupMember
	}
	return tx.Commit()
}

// ListGroupsWithCounts returns all groups (admin panel).
func (s *GroupService) ListGroupsWithCounts(ctx context.Context) ([]*GroupSummary, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT g.group_id, g.name,
			(SELECT COUNT(*) FROM group_members gm WHERE gm.group_db_id = g.id AND gm.state = 'active'),
			(SELECT MAX(sent_at) FROM group_messages gm2 WHERE gm2.group_db_id = g.id)
		FROM ` + "`groups`" + ` g
		ORDER BY g.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []*GroupSummary
	for rows.Next() {
		g := &GroupSummary{}
		if err = rows.Scan(&g.GroupID, &g.Name, &g.MemberCount, &g.LastMessageAt); err != nil {
			return nil, err
		}
		result = append(result, g)
	}
	return result, nil
}

// ListMyGroups returns the active groups for a user.
func (s *GroupService) ListMyGroups(ctx context.Context, chatID string) ([]*GroupSummary, error) {
	if !chatIDPattern.MatchString(chatID) {
		return nil, ErrUserNotFound
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT g.group_id, g.name,
			(SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_db_id = g.id AND gm2.state = 'active'),
			(SELECT MAX(sent_at) FROM group_messages gm3 WHERE gm3.group_db_id = g.id)
		FROM ` + "`groups`" + ` g
		JOIN group_members gm ON gm.group_db_id = g.id
		JOIN users u ON u.id = gm.user_id
		WHERE u.chat_id = ? AND gm.state = 'active'
		ORDER BY g.created_at DESC`, chatID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []*GroupSummary
	for rows.Next() {
		g := &GroupSummary{}
		if err = rows.Scan(&g.GroupID, &g.Name, &g.MemberCount, &g.LastMessageAt); err != nil {
			return nil, err
		}
		result = append(result, g)
	}
	return result, nil
}

// GetGroupDetail returns the group detail with active members (user view).
func (s *GroupService) GetGroupDetail(ctx context.Context, groupID, requesterChatID string) (*GroupDetailView, error) {
	return s.getGroupDetail(ctx, groupID, requesterChatID, false)
}

// GetAdminGroupDetail returns the group detail with all member states (admin view).
func (s *GroupService) GetAdminGroupDetail(ctx context.Context, groupID string) (*AdminGroupDetailView, error) {
	d, err := s.getGroupDetail(ctx, groupID, "", true)
	if err != nil {
		return nil, err
	}
	return &AdminGroupDetailView{
		GroupID:   d.GroupID,
		Name:      d.Name,
		CreatedAt: d.CreatedAt,
		Members:   d.Members,
	}, nil
}

func (s *GroupService) getGroupDetail(ctx context.Context, groupID, requesterChatID string, includeRemoved bool) (*GroupDetailView, error) {
	if !groupIDPattern.MatchString(groupID) {
		return nil, ErrGroupNotFound
	}

	var (
		groupDBID uint64
		name      string
		createdAt time.Time
	)
	err := s.db.QueryRowContext(ctx, `SELECT id, name, created_at FROM ` + "`groups`" + ` WHERE group_id = ?`, groupID).
		Scan(&groupDBID, &name, &createdAt)
	if err == sql.ErrNoRows {
		return nil, ErrGroupNotFound
	}
	if err != nil {
		return nil, err
	}

	// For non-admin requests, verify the requester is an active member
	if requesterChatID != "" {
		var count int
		err = s.db.QueryRowContext(ctx, `
			SELECT COUNT(*) FROM group_members gm
			JOIN users u ON u.id = gm.user_id
			WHERE gm.group_db_id = ? AND u.chat_id = ? AND gm.state = 'active'`,
			groupDBID, requesterChatID).Scan(&count)
		if err != nil {
			return nil, err
		}
		if count == 0 {
			return nil, ErrGroupNotFound // don't leak existence
		}
	}

	stateFilter := `gm.state = 'active'`
	if includeRemoved {
		stateFilter = `1=1`
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT u.chat_id, u.nickname, u.public_key, gm.muted_until, gm.state
		FROM group_members gm
		JOIN users u ON u.id = gm.user_id
		WHERE gm.group_db_id = ? AND `+stateFilter+`
		ORDER BY u.nickname`, groupDBID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var members []*GroupMemberView
	for rows.Next() {
		m := &GroupMemberView{}
		if err = rows.Scan(&m.ChatID, &m.Nickname, &m.PublicKey, &m.MutedUntil, &m.State); err != nil {
			return nil, err
		}
		members = append(members, m)
	}

	return &GroupDetailView{
		GroupID:   groupID,
		Name:      name,
		CreatedAt: createdAt,
		Members:   members,
	}, nil
}

// IsGroupMember checks if a chatID is an active member of the group.
func (s *GroupService) IsGroupMember(ctx context.Context, groupID, chatID string) bool {
	if !groupIDPattern.MatchString(groupID) || !chatIDPattern.MatchString(chatID) {
		return false
	}
	var count int
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM group_members gm
		JOIN users u ON u.id = gm.user_id
		JOIN ` + "`groups`" + ` g ON g.id = gm.group_db_id
		WHERE g.group_id = ? AND u.chat_id = ? AND gm.state = 'active'`,
		groupID, chatID).Scan(&count)
	if err != nil {
		return false
	}
	return count > 0
}

// ActiveMemberChatIDs returns active member chat IDs (excluding the sender).
func (s *GroupService) ActiveMemberChatIDs(ctx context.Context, groupID string) ([]string, error) {
	if !groupIDPattern.MatchString(groupID) {
		return nil, ErrGroupNotFound
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.chat_id FROM group_members gm
		JOIN users u ON u.id = gm.user_id
		JOIN ` + "`groups`" + ` g ON g.id = gm.group_db_id
		WHERE g.group_id = ? AND gm.state = 'active'`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []string
	for rows.Next() {
		var chatID string
		if err = rows.Scan(&chatID); err != nil {
			return nil, err
		}
		result = append(result, chatID)
	}
	return result, nil
}

// IsMuted checks if a member is currently muted in a group.
func (s *GroupService) IsMuted(ctx context.Context, groupID, chatID string) (bool, error) {
	if !groupIDPattern.MatchString(groupID) || !chatIDPattern.MatchString(chatID) {
		return false, ErrGroupNotFound
	}
	var mutedUntil *time.Time
	err := s.db.QueryRowContext(ctx, `
		SELECT gm.muted_until FROM group_members gm
		JOIN users u ON u.id = gm.user_id
		JOIN ` + "`groups`" + ` g ON g.id = gm.group_db_id
		WHERE g.group_id = ? AND u.chat_id = ? AND gm.state = 'active'`,
		groupID, chatID).Scan(&mutedUntil)
	if err == sql.ErrNoRows {
		return false, ErrNotGroupMember
	}
	if err != nil {
		return false, err
	}
	if mutedUntil == nil {
		return false, nil
	}
	return mutedUntil.After(time.Now()), nil
}

// ListGroupMessageMetadata returns ciphertext metadata only (admin panel).
func (s *GroupService) ListGroupMessageMetadata(ctx context.Context, groupID string, limit, offset int) ([]*GroupMessageMetadata, error) {
	if !groupIDPattern.MatchString(groupID) {
		return nil, ErrGroupNotFound
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT msg_id, sender_chat_id, sent_at, envelope_size, recalled_at, deleted_at
		FROM group_messages gm
		JOIN ` + "`groups`" + ` g ON g.id = gm.group_db_id
		WHERE g.group_id = ?
		ORDER BY gm.sent_at DESC
		LIMIT ? OFFSET ?`, groupID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []*GroupMessageMetadata
	for rows.Next() {
		m := &GroupMessageMetadata{}
		if err = rows.Scan(&m.MsgID, &m.SenderChatID, &m.SentAt, &m.EnvelopeSize, &m.RecalledAt, &m.DeletedAt); err != nil {
			return nil, err
		}
		result = append(result, m)
	}
	return result, nil
}

// DeleteGroupMessage sets deleted_at (admin deletion tombstone).
func (s *GroupService) DeleteGroupMessage(ctx context.Context, groupID, msgID string) error {
	if !groupIDPattern.MatchString(groupID) {
		return ErrGroupNotFound
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE group_messages gm
		JOIN ` + "`groups`" + ` g ON g.id = gm.group_db_id
		SET gm.deleted_at = CURRENT_TIMESTAMP(3)
		WHERE g.group_id = ? AND gm.msg_id = ? AND gm.deleted_at IS NULL`,
		groupID, msgID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrMessageNotFound
	}
	return nil
}

// RecallGroupMessage sets recalled_at (user self-recall, 144h window).
func (s *GroupService) RecallGroupMessage(ctx context.Context, senderChatID, groupID, msgID string) error {
	if !groupIDPattern.MatchString(groupID) {
		return ErrGroupNotFound
	}
	if !chatIDPattern.MatchString(senderChatID) {
		return ErrNotMessageSender
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var (
		dbSenderChatID string
		sentAt         time.Time
		deletedAt      *time.Time
		recalledAt     *time.Time
	)
	err = tx.QueryRowContext(ctx, `
		SELECT gm.sender_chat_id, gm.sent_at, gm.deleted_at, gm.recalled_at
		FROM group_messages gm
		JOIN ` + "`groups`" + ` g ON g.id = gm.group_db_id
		WHERE g.group_id = ? AND gm.msg_id = ? FOR UPDATE`,
		groupID, msgID).Scan(&dbSenderChatID, &sentAt, &deletedAt, &recalledAt)
	if err == sql.ErrNoRows {
		return ErrMessageNotFound
	}
	if err != nil {
		return err
	}

	if dbSenderChatID != senderChatID {
		return ErrNotMessageSender
	}
	if recalledAt != nil {
		return nil // idempotent
	}
	if deletedAt != nil {
		return ErrMessageNotFound // admin-deleted, cannot recall
	}
	if time.Since(sentAt) > time.Duration(GroupRecallLimitHours)*time.Hour {
		return errors.New("recall window expired")
	}

	if _, err = tx.ExecContext(ctx,
		`UPDATE group_messages SET recalled_at = CURRENT_TIMESTAMP(3) WHERE msg_id = ?`,
		msgID); err != nil {
		return err
	}
	return tx.Commit()
}
