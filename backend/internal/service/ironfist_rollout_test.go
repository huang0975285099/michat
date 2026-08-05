package service

import (
	"context"
	"testing"

	pkgredis "e2eechat/pkg/redis"
)

func TestClearLegacyIronFistRedisUsesExactLegacyPrefixes(t *testing.T) {
	client, err := pkgredis.NewInMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	ctx := context.Background()
	client.Set(ctx, "ironfist:actions:r1", "legacy", 0)
	client.Set(ctx, "ironfist:action-once:r1:u:1", "legacy", 0)
	client.Set(ctx, "ironfist:invite:r1", "keep", 0)
	client.Set(ctx, pkgredis.IronFistEventsChannel, "keep", 0)
	if err := ClearLegacyIronFistRedis(ctx, client); err != nil {
		t.Fatal(err)
	}
	if client.Exists(ctx, "ironfist:actions:r1", "ironfist:action-once:r1:u:1").Val() != 0 {
		t.Fatal("legacy action keys remain")
	}
	if client.Get(ctx, "ironfist:invite:r1").Val() != "keep" || client.Get(ctx, pkgredis.IronFistEventsChannel).Val() != "keep" {
		t.Fatal("non-legacy IronFist keys were removed")
	}
}
