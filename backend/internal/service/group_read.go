package service

import (
	"context"
	"errors"
	"strings"
	"time"
)

type GroupReadProof struct {
	MsgID string `json:"msg_id"`
	Proof string `json:"proof"`
}

type GroupReadReceipt struct {
	MsgID     string     `json:"msg_id"`
	ChatID    string     `json:"chat_id"`
	Nickname  string     `json:"nickname"`
	ReadAt    *time.Time `json:"read_at"`
	Proof     string     `json:"proof"`
	PublicKey string     `json:"public_key"`
}

func validateGroupReadIDs(groupID string, ids []string) error {
	if !groupIDPattern.MatchString(groupID) || len(ids) == 0 || len(ids) > 100 {
		return errors.New("invalid group read request")
	}
	for _, id := range ids {
		if !msgIDRe.MatchString(id) {
			return errors.New("invalid message id")
		}
	}
	return nil
}

func (s *GroupService) RecordGroupReads(ctx context.Context, groupID, reader string, proofs []GroupReadProof) ([]string, error) {
	ids := make([]string, 0, len(proofs))
	for _, proof := range proofs {
		if len(proof.Proof) == 0 || len(proof.Proof) > 8192 {
			return nil, errors.New("invalid read proof")
		}
		ids = append(ids, proof.MsgID)
	}
	if err := validateGroupReadIDs(groupID, ids); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	accepted := make([]string, 0, len(proofs))
	for _, proof := range proofs {
		_, err = tx.ExecContext(ctx, `UPDATE group_message_reads gr
		JOIN group_messages gm ON gm.msg_id = gr.msg_id
		JOIN `+"`groups`"+` g ON g.id = gm.group_db_id
		JOIN users u ON u.chat_id = gr.member_chat_id
		JOIN group_members member ON member.group_db_id = g.id AND member.user_id = u.id AND member.state = 'active'
		SET gr.read_at = CURRENT_TIMESTAMP(3), gr.proof = ?, gr.public_key = u.public_key
		WHERE gr.msg_id = ? AND gr.member_chat_id = ? AND g.group_id = ? AND gr.read_at IS NULL`, proof.Proof, proof.MsgID, reader, groupID)
		if err != nil {
			return nil, err
		}
		var found int
		if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM group_message_reads gr
		JOIN group_messages gm ON gm.msg_id = gr.msg_id JOIN `+"`groups`"+` g ON g.id = gm.group_db_id
		WHERE gr.msg_id = ? AND gr.member_chat_id = ? AND g.group_id = ? AND gr.read_at IS NOT NULL`, proof.MsgID, reader, groupID).Scan(&found); err != nil {
			return nil, err
		}
		if found > 0 {
			accepted = append(accepted, proof.MsgID)
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return accepted, nil
}

func (s *GroupService) GetGroupReads(ctx context.Context, groupID, sender string, ids []string) ([]GroupReadReceipt, error) {
	if err := validateGroupReadIDs(groupID, ids); err != nil {
		return nil, err
	}
	args := []interface{}{groupID, sender}
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT gr.msg_id, gr.member_chat_id, COALESCE(u.nickname, gr.member_chat_id), gr.read_at, COALESCE(gr.proof, ''), COALESCE(gr.public_key, u.public_key, '')
	FROM group_message_reads gr JOIN group_messages gm ON gm.msg_id = gr.msg_id
	JOIN `+"`groups`"+` g ON g.id = gm.group_db_id LEFT JOIN users u ON u.chat_id = gr.member_chat_id
	WHERE g.group_id = ? AND gm.sender_chat_id = ? AND gm.msg_id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")+`)
	ORDER BY gm.sent_at, gr.member_chat_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]GroupReadReceipt, 0)
	for rows.Next() {
		var receipt GroupReadReceipt
		if err = rows.Scan(&receipt.MsgID, &receipt.ChatID, &receipt.Nickname, &receipt.ReadAt, &receipt.Proof, &receipt.PublicKey); err != nil {
			return nil, err
		}
		result = append(result, receipt)
	}
	return result, rows.Err()
}
