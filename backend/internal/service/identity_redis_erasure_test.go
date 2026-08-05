package service

import (
	"context"
	"testing"

	pkgredis "e2eechat/pkg/redis"
)

func TestEraseAccountRedisDataRemovesIdentityTracesOnly(t *testing.T) {
	client, err := pkgredis.NewInMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	ctx := context.Background()
	chatID := "1234-ABCD"
	other := "9876-WXYZ"
	client.Set(ctx, pkgredis.OnlineKey(chatID), "1", 0)
	client.Set(ctx, pkgredis.SessionKey("mine"), chatID+":4", 0)
	client.Set(ctx, pkgredis.SessionKey("other"), other+":2", 0)
	client.Set(ctx, pkgredis.IronFistInviteKey("room"), `{"inviter_chat_id":"`+chatID+`"}`, 0)
	client.RPush(ctx, pkgredis.OfflineKey(other), `{"from":"`+chatID+`"}`, `{"from":"someone-else"}`)

	svc := NewIdentityService(nil, client)
	if err := svc.eraseAccountRedisData(ctx, chatID); err != nil {
		t.Fatal(err)
	}
	if client.Exists(ctx, pkgredis.OnlineKey(chatID), pkgredis.SessionKey("mine"), pkgredis.IronFistInviteKey("room")).Val() != 0 {
		t.Fatal("deleted identity traces remain")
	}
	if got := client.Get(ctx, pkgredis.SessionKey("other")).Val(); got != other+":2" {
		t.Fatalf("unrelated session changed: %q", got)
	}
	remaining := client.LRange(ctx, pkgredis.OfflineKey(other), 0, -1).Val()
	if len(remaining) != 1 || remaining[0] != `{"from":"someone-else"}` {
		t.Fatalf("offline queue not filtered safely: %#v", remaining)
	}
}
