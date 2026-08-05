package service

import (
	"context"
	"strings"

	rdb "github.com/redis/go-redis/v9"

	pkgredis "e2eechat/pkg/redis"
)

func (s *IdentityService) eraseAccountRedisData(ctx context.Context, chatID string) error {
	if s.redis == nil {
		return nil
	}
	if err := s.redis.Del(ctx,
		pkgredis.OnlineKey(chatID), pkgredis.OfflineKey(chatID),
	).Err(); err != nil {
		return err
	}
	for _, pattern := range []string{"session:*", "offline:*", "ironfist:*"} {
		var cursor uint64
		for {
			keys, next, err := s.redis.Scan(ctx, cursor, pattern, 100).Result()
			if err != nil {
				return err
			}
			for _, key := range keys {
				if strings.Contains(key, chatID) {
					if err := s.redis.Del(ctx, key).Err(); err != nil {
						return err
					}
					continue
				}
				typ, err := s.redis.Type(ctx, key).Result()
				if err != nil {
					return err
				}
				switch typ {
				case "string":
					value, err := s.redis.Get(ctx, key).Result()
					if err != nil && err != rdb.Nil {
						return err
					}
					if strings.Contains(value, chatID) {
						if err := s.redis.Del(ctx, key).Err(); err != nil {
							return err
						}
					}
				case "list":
					values, err := s.redis.LRange(ctx, key, 0, -1).Result()
					if err != nil {
						return err
					}
					kept := values[:0]
					for _, value := range values {
						if !strings.Contains(value, chatID) {
							kept = append(kept, value)
						}
					}
					if len(kept) != len(values) {
						pipe := s.redis.TxPipeline()
						pipe.Del(ctx, key)
						if len(kept) > 0 {
							items := make([]any, len(kept))
							for i := range kept {
								items[i] = kept[i]
							}
							pipe.RPush(ctx, key, items...)
							pipe.Expire(ctx, key, pkgredis.OfflineMsgTTL)
						}
						if _, err := pipe.Exec(ctx); err != nil {
							return err
						}
					}
				}
			}
			cursor = next
			if cursor == 0 {
				break
			}
		}
	}
	return s.redis.Del(ctx, pkgredis.SessionGenKey(chatID)).Err()
}
