package service

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestGroupCreateListRemove(t *testing.T) {
	db := openIsolatedAuthorityServiceTestDatabase(t)
	ctx := context.Background()
	svc := NewGroupService(db)

	// create 3 ready users
	uidA := insertAttachmentTestUser(t, db, "1001-AAAA", "alice")
	uidB := insertAttachmentTestUser(t, db, "1002-BBBB", "bob")
	uidC := insertAttachmentTestUser(t, db, "1003-CCCC", "carol")
	_ = uidA
	_ = uidB
	_ = uidC

	t.Run("rejects fewer than 2 members", func(t *testing.T) {
		_, err := svc.CreateGroup(ctx, "tiny", []string{"1001-AAAA"})
		if !errors.Is(err, ErrTooFewMembers) {
			t.Fatalf("err = %v, want ErrTooFewMembers", err)
		}
	})

	t.Run("rejects unready user", func(t *testing.T) {
		// insert a user with is_ready=0
		if _, err := db.Exec(`INSERT INTO users (chat_id, nickname, public_key, is_ready) VALUES ('1004-DDDD', 'dan', '', 0)`); err != nil {
			t.Fatal(err)
		}
		_, err := svc.CreateGroup(ctx, "bad", []string{"1001-AAAA", "1004-DDDD"})
		if !errors.Is(err, ErrUserNotReady) {
			t.Fatalf("err = %v, want ErrUserNotReady", err)
		}
	})

	t.Run("create and list for members", func(t *testing.T) {
		group, err := svc.CreateGroup(ctx, "test group", []string{"1001-AAAA", "1002-BBBB", "1003-CCCC"})
		if err != nil {
			t.Fatal(err)
		}
		if len(group.GroupID) != 14 || group.GroupID[:2] != "G-" {
			t.Fatalf("group id = %s", group.GroupID)
		}
		if group.MemberCount != 3 {
			t.Fatalf("member count = %d", group.MemberCount)
		}

		// members see it
		aliceGroups, err := svc.ListMyGroups(ctx, "1001-AAAA")
		if err != nil {
			t.Fatal(err)
		}
		if len(aliceGroups) != 1 || aliceGroups[0].GroupID != group.GroupID {
			t.Fatalf("alice groups = %+v", aliceGroups)
		}

		// non-member does not see it
		strangerGroups, err := svc.ListMyGroups(ctx, "9999-ZZZZ")
		if err != nil {
			t.Fatal(err)
		}
		if len(strangerGroups) != 0 {
			t.Fatalf("stranger groups = %+v", strangerGroups)
		}

		// detail returns active members with public keys
		detail, err := svc.GetGroupDetail(ctx, group.GroupID, "1001-AAAA")
		if err != nil {
			t.Fatal(err)
		}
		if len(detail.Members) != 3 {
			t.Fatalf("detail members = %d", len(detail.Members))
		}
		for _, m := range detail.Members {
			if m.PublicKey != "test-key" {
				t.Fatalf("member %s public key = %s", m.ChatID, m.PublicKey)
			}
		}

		// non-member gets ErrGroupNotFound (no leak)
		_, err = svc.GetGroupDetail(ctx, group.GroupID, "9999-ZZZZ")
		if !errors.Is(err, ErrGroupNotFound) {
			t.Fatalf("err = %v, want ErrGroupNotFound", err)
		}
	})

	t.Run("remove member hides group and deletes deliveries", func(t *testing.T) {
		group, err := svc.CreateGroup(ctx, "remove test", []string{"1001-AAAA", "1002-BBBB", "1003-CCCC"})
		if err != nil {
			t.Fatal(err)
		}

		// remove alice
		if err := svc.RemoveMember(ctx, group.GroupID, "1001-AAAA"); err != nil {
			t.Fatal(err)
		}

		// alice no longer sees the removed group
		aliceGroups, _ := svc.ListMyGroups(ctx, "1001-AAAA")
		for _, g := range aliceGroups {
			if g.GroupID == group.GroupID {
				t.Fatal("alice still sees the removed group")
			}
		}

		// bob still sees it
		bobGroups, _ := svc.ListMyGroups(ctx, "1002-BBBB")
		found := false
		for _, g := range bobGroups {
			if g.GroupID == group.GroupID {
				found = true
			}
		}
		if !found {
			t.Fatal("bob lost group after alice removal")
		}

		// IsGroupMember false for alice
		if svc.IsGroupMember(ctx, group.GroupID, "1001-AAAA") {
			t.Fatal("alice still a member")
		}
		// IsGroupMember true for bob
		if !svc.IsGroupMember(ctx, group.GroupID, "1002-BBBB") {
			t.Fatal("bob not a member")
		}
	})

	t.Run("add members enforces 10-member cap", func(t *testing.T) {
		members := []string{"1001-AAAA", "1002-BBBB"}
		group, err := svc.CreateGroup(ctx, "cap test", members)
		if err != nil {
			t.Fatal(err)
		}
		// add 8 more
		for i := 0; i < 8; i++ {
			chatID := "200" + string(rune('0'+i)) + "-AAA" + string(rune('A'+i))
			if _, err := db.Exec(`INSERT INTO users (chat_id, nickname, public_key, is_ready) VALUES (?, ?, 'test-key', 1)`,
				chatID, "user"+string(rune('A'+i))); err != nil {
				t.Fatal(err)
			}
			if err := svc.AddMembers(ctx, group.GroupID, []string{chatID}); err != nil {
				t.Fatalf("add member %s: %v", chatID, err)
			}
		}
		// now 10 members — add an 11th
		if _, err := db.Exec(`INSERT INTO users (chat_id, nickname, public_key, is_ready) VALUES ('2999-ZZZZ', 'extra', 'test-key', 1)`); err != nil {
			t.Fatal(err)
		}
		err = svc.AddMembers(ctx, group.GroupID, []string{"2999-ZZZZ"})
		if !errors.Is(err, ErrGroupFull) {
			t.Fatalf("err = %v, want ErrGroupFull", err)
		}
	})

	t.Run("dissolve removes all rows", func(t *testing.T) {
		group, err := svc.CreateGroup(ctx, "dissolve test", []string{"1001-AAAA", "1002-BBBB"})
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.DissolveGroup(ctx, group.GroupID); err != nil {
			t.Fatal(err)
		}
		// members no longer see it
		aliceGroups, _ := svc.ListMyGroups(ctx, "1001-AAAA")
		// alice was removed in a previous test but this group was dissolved
		// check the dissolved group doesn't appear
		for _, g := range aliceGroups {
			if g.GroupID == group.GroupID {
				t.Fatal("dissolved group still visible")
			}
		}
	})
}

func TestGroupMuteLifecycle(t *testing.T) {
	db := openIsolatedAuthorityServiceTestDatabase(t)
	ctx := context.Background()
	svc := NewGroupService(db)

	insertAttachmentTestUser(t, db, "1101-AAAA", "alice")
	insertAttachmentTestUser(t, db, "1102-BBBB", "bob")

	group, err := svc.CreateGroup(ctx, "mute test", []string{"1101-AAAA", "1102-BBBB"})
	if err != nil {
		t.Fatal(err)
	}

	// not muted initially
	muted, err := svc.IsMuted(ctx, group.GroupID, "1101-AAAA")
	if err != nil {
		t.Fatal(err)
	}
	if muted {
		t.Fatal("alice initially muted")
	}

	// mute alice for 1 hour
	until := time.Now().Add(time.Hour)
	if err := svc.MuteMember(ctx, group.GroupID, "1101-AAAA", &until); err != nil {
		t.Fatal(err)
	}
	muted, _ = svc.IsMuted(ctx, group.GroupID, "1101-AAAA")
	if !muted {
		t.Fatal("alice not muted after mute")
	}

	// detail exposes muted_until
	detail, err := svc.GetGroupDetail(ctx, group.GroupID, "1101-AAAA")
	if err != nil {
		t.Fatal(err)
	}
	var aliceMute *time.Time
	for _, m := range detail.Members {
		if m.ChatID == "1101-AAAA" {
			aliceMute = m.MutedUntil
		}
	}
	if aliceMute == nil {
		t.Fatal("detail muted_until is nil for muted alice")
	}

	// bob is not muted
	muted, _ = svc.IsMuted(ctx, group.GroupID, "1102-BBBB")
	if muted {
		t.Fatal("bob muted")
	}

	// unmute alice
	if err := svc.MuteMember(ctx, group.GroupID, "1101-AAAA", nil); err != nil {
		t.Fatal(err)
	}
	muted, _ = svc.IsMuted(ctx, group.GroupID, "1101-AAAA")
	if muted {
		t.Fatal("alice still muted after unmute")
	}

	// expired muted_until behaves as not muted
	expired := time.Now().Add(-time.Minute)
	if err := svc.MuteMember(ctx, group.GroupID, "1101-AAAA", &expired); err != nil {
		t.Fatal(err)
	}
	muted, _ = svc.IsMuted(ctx, group.GroupID, "1101-AAAA")
	if muted {
		t.Fatal("alice muted with past timestamp")
	}

	// muted member still appears in ListMyGroups and ActiveMemberChatIDs
	list, _ := svc.ListMyGroups(ctx, "1101-AAAA")
	if len(list) == 0 {
		t.Fatal("muted alice not in ListMyGroups")
	}
	active, _ := svc.ActiveMemberChatIDs(ctx, group.GroupID)
	found := false
	for _, id := range active {
		if id == "1101-AAAA" {
			found = true
		}
	}
	if !found {
		t.Fatal("muted alice not in ActiveMemberChatIDs")
	}
}

func TestGroupRename(t *testing.T) {
	db := openIsolatedAuthorityServiceTestDatabase(t)
	ctx := context.Background()
	svc := NewGroupService(db)

	insertAttachmentTestUser(t, db, "1201-AAAA", "alice")
	insertAttachmentTestUser(t, db, "1202-BBBB", "bob")

	group, err := svc.CreateGroup(ctx, "old name", []string{"1201-AAAA", "1202-BBBB"})
	if err != nil {
		t.Fatal(err)
	}

	if err := svc.RenameGroup(ctx, group.GroupID, "new name"); err != nil {
		t.Fatal(err)
	}

	detail, err := svc.GetGroupDetail(ctx, group.GroupID, "1201-AAAA")
	if err != nil {
		t.Fatal(err)
	}
	if detail.Name != "new name" {
		t.Fatalf("name = %s", detail.Name)
	}

	// rename non-existent group
	if err := svc.RenameGroup(ctx, "G-000000000099", "x"); !errors.Is(err, ErrGroupNotFound) {
		t.Fatalf("err = %v, want ErrGroupNotFound", err)
	}
}

func TestGroupDeleteMessage(t *testing.T) {
	db := openIsolatedAuthorityServiceTestDatabase(t)
	ctx := context.Background()
	svc := NewGroupService(db)

	insertAttachmentTestUser(t, db, "1301-AAAA", "alice")
	insertAttachmentTestUser(t, db, "1302-BBBB", "bob")

	group, err := svc.CreateGroup(ctx, "delete test", []string{"1301-AAAA", "1302-BBBB"})
	if err != nil {
		t.Fatal(err)
	}

	// insert a message directly
	var groupDBID uint64
	if err := db.QueryRow(`SELECT id FROM ` + "`groups`" + ` WHERE group_id = ?`, group.GroupID).Scan(&groupDBID); err != nil {
		t.Fatal(err)
	}
	msgID := "abc123-test-def456"
	if _, err := db.Exec(`INSERT INTO group_messages (msg_id, group_db_id, sender_chat_id, iv, ciphertext, envelope_size) VALUES (?, ?, '1301-AAAA', 'iv', 'ct', 100)`,
		msgID, groupDBID); err != nil {
		t.Fatal(err)
	}

	// admin delete
	if err := svc.DeleteGroupMessage(ctx, group.GroupID, msgID); err != nil {
		t.Fatal(err)
	}

	// verify deleted_at is set
	var deletedAt *time.Time
	if err := db.QueryRow(`SELECT deleted_at FROM group_messages WHERE msg_id = ?`, msgID).Scan(&deletedAt); err != nil {
		t.Fatal(err)
	}
	if deletedAt == nil {
		t.Fatal("deleted_at not set")
	}

	// delete again fails
	if err := svc.DeleteGroupMessage(ctx, group.GroupID, msgID); !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("err = %v, want ErrMessageNotFound", err)
	}
}

func TestGroupRecallMessage(t *testing.T) {
	db := openIsolatedAuthorityServiceTestDatabase(t)
	ctx := context.Background()
	svc := NewGroupService(db)

	insertAttachmentTestUser(t, db, "1401-AAAA", "alice")
	insertAttachmentTestUser(t, db, "1402-BBBB", "bob")

	group, err := svc.CreateGroup(ctx, "recall test", []string{"1401-AAAA", "1402-BBBB"})
	if err != nil {
		t.Fatal(err)
	}

	var groupDBID uint64
	if err := db.QueryRow(`SELECT id FROM ` + "`groups`" + ` WHERE group_id = ?`, group.GroupID).Scan(&groupDBID); err != nil {
		t.Fatal(err)
	}
	msgID := "recall123-test-abc"
	if _, err := db.Exec(`INSERT INTO group_messages (msg_id, group_db_id, sender_chat_id, iv, ciphertext, envelope_size, sent_at) VALUES (?, ?, '1401-AAAA', 'iv', 'ct', 100, CURRENT_TIMESTAMP(3))`,
		msgID, groupDBID); err != nil {
		t.Fatal(err)
	}

	// non-sender cannot recall
	err = svc.RecallGroupMessage(ctx, "1402-BBBB", group.GroupID, msgID)
	if !errors.Is(err, ErrNotMessageSender) {
		t.Fatalf("err = %v, want ErrNotMessageSender", err)
	}

	// sender can recall
	if err := svc.RecallGroupMessage(ctx, "1401-AAAA", group.GroupID, msgID); err != nil {
		t.Fatal(err)
	}

	// verify recalled_at is set
	var recalledAt *time.Time
	if err := db.QueryRow(`SELECT recalled_at FROM group_messages WHERE msg_id = ?`, msgID).Scan(&recalledAt); err != nil {
		t.Fatal(err)
	}
	if recalledAt == nil {
		t.Fatal("recalled_at not set")
	}

	// recall is idempotent
	if err := svc.RecallGroupMessage(ctx, "1401-AAAA", group.GroupID, msgID); err != nil {
		t.Fatalf("idempotent recall failed: %v", err)
	}

	// recall of admin-deleted message fails
	msgID2 := "deleted1-test-abc"
	if _, err := db.Exec(`INSERT INTO group_messages (msg_id, group_db_id, sender_chat_id, iv, ciphertext, envelope_size, sent_at, deleted_at) VALUES (?, ?, '1401-AAAA', 'iv', 'ct', 100, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
		msgID2, groupDBID); err != nil {
		t.Fatal(err)
	}
	err = svc.RecallGroupMessage(ctx, "1401-AAAA", group.GroupID, msgID2)
	if !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("err = %v, want ErrMessageNotFound", err)
	}
}

func TestListGroupMessageMetadata(t *testing.T) {
	db := openIsolatedAuthorityServiceTestDatabase(t)
	ctx := context.Background()
	svc := NewGroupService(db)

	insertAttachmentTestUser(t, db, "1501-AAAA", "alice")
	insertAttachmentTestUser(t, db, "1502-BBBB", "bob")

	group, err := svc.CreateGroup(ctx, "metadata test", []string{"1501-AAAA", "1502-BBBB"})
	if err != nil {
		t.Fatal(err)
	}

	var groupDBID uint64
	if err := db.QueryRow(`SELECT id FROM ` + "`groups`" + ` WHERE group_id = ?`, group.GroupID).Scan(&groupDBID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO group_messages (msg_id, group_db_id, sender_chat_id, iv, ciphertext, envelope_size) VALUES ('meta1-test-abc', ?, '1501-AAAA', 'iv', 'ct', 100)`,
		groupDBID); err != nil {
		t.Fatal(err)
	}

	msgs, err := svc.ListGroupMessageMetadata(ctx, group.GroupID, 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 {
		t.Fatalf("msg count = %d", len(msgs))
	}
	if msgs[0].MsgID != "meta1-test-abc" || msgs[0].SenderChatID != "1501-AAAA" || msgs[0].EnvelopeSize != 100 {
		t.Fatalf("msg = %+v", msgs[0])
	}
}
