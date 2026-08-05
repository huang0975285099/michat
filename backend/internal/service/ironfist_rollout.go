package service

import (
	"context"
	"database/sql"
	"fmt"
	"log"

	"e2eechat/internal/ironfistengine"
	rdb "github.com/redis/go-redis/v9"
)

const ironFistRolloutMarker = "ironfist-authority-rollout-v1"

type legacyRolloutRoom struct {
	id, userA, userB uint64
	status, tier     string
	stake            int64
}

// MigrateLegacyIronFist closes every pre-authority economic claim exactly
// once. A connection-scoped advisory lock and durable marker make it safe for
// concurrent server starts and restarts.
func (s *IronFistService) MigrateLegacyIronFist(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var acquired int
	if err := conn.QueryRowContext(ctx, `SELECT GET_LOCK(?, 30)`, ironFistRolloutMarker).Scan(&acquired); err != nil {
		return err
	}
	if acquired != 1 {
		return fmt.Errorf("could not acquire %s", ironFistRolloutMarker)
	}
	defer conn.ExecContext(context.Background(), `SELECT RELEASE_LOCK(?)`, ironFistRolloutMarker) //nolint:errcheck

	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM system_migration_markers WHERE name = ?`, ironFistRolloutMarker).Scan(&exists)
	if err == nil {
		return tx.Commit()
	}
	if err != sql.ErrNoRows {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ironfist_matches SET pve_reward_eligible = 0 WHERE pve_reward_eligible = 1`); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT id, status, tier, stake_amount, player_a_user_id, COALESCE(player_b_user_id, 0)
		FROM ironfist_pvp_rooms WHERE status IN ('matching','matched') ORDER BY id FOR UPDATE`)
	if err != nil {
		return err
	}
	var rooms []legacyRolloutRoom
	for rows.Next() {
		var room legacyRolloutRoom
		if err := rows.Scan(&room.id, &room.status, &room.tier, &room.stake, &room.userA, &room.userB); err != nil {
			rows.Close()
			return err
		}
		rooms = append(rooms, room)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, room := range rooms {
		refID := pvpRoomRef(room.id)
		if room.status == "matching" {
			if err := creditAuthorityWagerTx(ctx, tx, room.userA, room.stake, false, "pvp_refund", refID,
				fmt.Sprintf("rollout:room:%d:matching-refund", room.id), "Legacy matchmaking full refund ("+room.tier+")"); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE ironfist_pvp_rooms SET status='cancelled', result='draw', refund_a=?, settled_at=? WHERE id=? AND status='matching'`, room.stake, s.authorityNow(), room.id); err != nil {
				return err
			}
			continue
		}
		settlement, err := calculateWagerSettlement(room.stake, ironfistengine.Draw)
		if err != nil {
			return err
		}
		if err := creditAuthorityWagerTx(ctx, tx, room.userA, settlement.RefundA, false, "pvp_refund", refID,
			fmt.Sprintf("rollout:room:%d:refund-a", room.id), "Legacy matched draw refund ("+room.tier+")"); err != nil {
			return err
		}
		if err := creditAuthorityWagerTx(ctx, tx, room.userB, settlement.RefundB, false, "pvp_refund", refID,
			fmt.Sprintf("rollout:room:%d:refund-b", room.id), "Legacy matched draw refund ("+room.tier+")"); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE ironfist_pvp_rooms SET status='settled', result='draw', refund_a=?, refund_b=?,
			fee_burn=?, fee_treasury=?, settled_at=? WHERE id=? AND status='matched'`,
			settlement.RefundA, settlement.RefundB, settlement.FeeBurn, settlement.FeeTreasury, s.authorityNow(), room.id); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO system_migration_markers (name, completed_at) VALUES (?, ?)`, ironFistRolloutMarker, s.authorityNow()); err != nil {
		return err
	}
	return tx.Commit()
}

func ClearLegacyIronFistRedis(ctx context.Context, client *rdb.Client) error {
	for _, pattern := range []string{"ironfist:actions:*", "ironfist:action-once:*"} {
		var cursor uint64
		for {
			keys, next, err := client.Scan(ctx, cursor, pattern, 100).Result()
			if err != nil {
				return err
			}
			if len(keys) > 0 {
				if err := client.Del(ctx, keys...).Err(); err != nil {
					return err
				}
			}
			cursor = next
			if cursor == 0 {
				break
			}
		}
	}
	log.Printf("[ironfist] legacy Redis action streams cleared")
	return nil
}
