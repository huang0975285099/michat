package service

import (
	"context"
	"testing"

	pkgredis "e2eechat/pkg/redis"
)

func TestDeleteAccountWithGroupMembership(t *testing.T) {
	db := openIsolatedAuthorityServiceTestDatabase(t)
	ctx := context.Background()
	for _, chatID := range []string{"1911-AAAA", "1912-BBBB", "1913-CCCC"} {
		insertAttachmentTestUser(t, db, chatID, chatID)
	}
	groups := NewGroupService(db)
	group, err := groups.CreateGroup(ctx, "account deletion", []string{"1911-AAAA", "1912-BBBB", "1913-CCCC"})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = groups.AcceptGroupMessage(ctx, "1911-AAAA", group.GroupID, "account-delete-message", "iv", "ciphertext", []KeyEnvelope{
		{To: "1912-BBBB", EphemeralPubKey: "key", IV: "iv", KeyCiphertext: "envelope"},
		{To: "1913-CCCC", EphemeralPubKey: "key", IV: "iv", KeyCiphertext: "envelope"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = groups.RemoveMember(ctx, group.GroupID, "1913-CCCC"); err != nil {
		t.Fatal(err)
	}
	client, err := pkgredis.NewInMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	identity := NewIdentityService(db, client)
	for _, chatID := range []string{"1912-BBBB", "1913-CCCC"} {
		if err = identity.DeleteAccount(ctx, chatID); err != nil {
			t.Fatalf("delete group member %s: %v", chatID, err)
		}
		var remaining int
		if err = db.QueryRow(`SELECT COUNT(*) FROM users WHERE chat_id = ?`, chatID).Scan(&remaining); err != nil || remaining != 0 {
			t.Fatalf("user still exists: %d, %v", remaining, err)
		}
		if err = db.QueryRow(`SELECT COUNT(*) FROM group_message_deliveries WHERE member_chat_id = ?`, chatID).Scan(&remaining); err != nil || remaining != 0 {
			t.Fatalf("delivery still exists: %d, %v", remaining, err)
		}
	}
	var members, messages int
	if err = db.QueryRow(`SELECT COUNT(*) FROM group_members`).Scan(&members); err != nil || members != 1 {
		t.Fatalf("remaining group members: %d, %v", members, err)
	}
	if err = db.QueryRow(`SELECT COUNT(*) FROM group_messages`).Scan(&messages); err != nil || messages != 1 {
		t.Fatalf("other members' group history changed: %d, %v", messages, err)
	}
}
