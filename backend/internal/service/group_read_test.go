package service

import (
	"context"
	"testing"
)

func TestGroupReadSenderPrivacyAndRecipientSnapshot(t *testing.T) {
	db := openIsolatedAuthorityServiceTestDatabase(t)
	ctx := context.Background()
	svc := NewGroupService(db)
	for _, chatID := range []string{"1901-AAAA", "1902-BBBB", "1903-CCCC", "1904-DDDD"} {
		insertAttachmentTestUser(t, db, chatID, chatID)
	}
	group, err := svc.CreateGroup(ctx, "read test", []string{"1901-AAAA", "1902-BBBB", "1903-CCCC"})
	if err != nil {
		t.Fatal(err)
	}
	msgID := "group-read-test"
	_, _, err = svc.AcceptGroupMessage(ctx, "1901-AAAA", group.GroupID, msgID, "iv", "ciphertext", []KeyEnvelope{
		{To: "1902-BBBB", EphemeralPubKey: "key", IV: "iv", KeyCiphertext: "envelope"},
		{To: "1903-CCCC", EphemeralPubKey: "key", IV: "iv", KeyCiphertext: "envelope"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.AddMembers(ctx, group.GroupID, []string{"1904-DDDD"}); err != nil {
		t.Fatal(err)
	}
	accepted, err := svc.RecordGroupReads(ctx, group.GroupID, "1904-DDDD", []GroupReadProof{{MsgID: msgID, Proof: "outsider-proof"}})
	if err != nil || len(accepted) != 0 {
		t.Fatalf("new member read = %v, %v", accepted, err)
	}
	accepted, err = svc.RecordGroupReads(ctx, group.GroupID, "1902-BBBB", []GroupReadProof{{MsgID: msgID, Proof: "first-proof"}})
	if err != nil || len(accepted) != 1 {
		t.Fatalf("reader result = %v, %v", accepted, err)
	}
	before, err := svc.GetGroupReads(ctx, group.GroupID, "1901-AAAA", []string{msgID})
	if err != nil || len(before) != 2 {
		t.Fatalf("sender receipts = %v, %v", before, err)
	}
	_, err = svc.RecordGroupReads(ctx, group.GroupID, "1902-BBBB", []GroupReadProof{{MsgID: msgID, Proof: "replacement-proof"}})
	if err != nil {
		t.Fatal(err)
	}
	after, err := svc.GetGroupReads(ctx, group.GroupID, "1901-AAAA", []string{msgID})
	if err != nil || after[0].Proof != "first-proof" || before[0].ReadAt == nil || after[0].ReadAt == nil || !before[0].ReadAt.Equal(*after[0].ReadAt) {
		t.Fatalf("first receipt was replaced: %v, %v", after, err)
	}
	if after[1].ReadAt != nil {
		t.Fatal("unread recipient incorrectly marked read")
	}
	for _, requester := range []string{"1902-BBBB", "1903-CCCC", "1904-DDDD"} {
		receipts, err := svc.GetGroupReads(ctx, group.GroupID, requester, []string{msgID})
		if err != nil || len(receipts) != 0 {
			t.Fatalf("receipt list leaked to %s: %v, %v", requester, receipts, err)
		}
	}
	if err = svc.RemoveMember(ctx, group.GroupID, "1902-BBBB"); err != nil {
		t.Fatal(err)
	}
	receipts, err := svc.GetGroupReads(ctx, group.GroupID, "1901-AAAA", []string{msgID})
	if err != nil || len(receipts) != 2 || receipts[0].Proof != "first-proof" {
		t.Fatalf("removed member receipt lost: %v, %v", receipts, err)
	}
	accepted, err = svc.RecordGroupReads(ctx, group.GroupID, "1901-AAAA", []GroupReadProof{{MsgID: msgID, Proof: "self-proof"}})
	if err != nil || len(accepted) != 0 {
		t.Fatalf("sender counted as recipient: %v, %v", accepted, err)
	}
}
