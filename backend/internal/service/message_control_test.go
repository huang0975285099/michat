package service

import (
	"context"
	"os"
	"strings"
	"testing"
)

func TestControlProofLimits(t *testing.T) {
	for _, proofs := range []map[string]string{
		{"other": "proof"}, {"id": ""}, {"id": strings.Repeat("x", MaxControlProofBytes+1)}, {},
	} {
		if ValidateReadProofs([]string{"id"}, proofs) == nil {
			t.Fatalf("accepted invalid proofs: %v", proofs)
		}
	}
	if ValidateReadProofs([]string{"id", "id"}, map[string]string{"id": "opaque"}) != nil {
		t.Fatal("duplicate IDs rejected")
	}
	if ValidateReadProofs([]string{"id"}, nil) != nil {
		t.Fatal("legacy proofs rejected")
	}
	if _, err := controlProof([]string{strings.Repeat("x", MaxControlProofBytes+1)}); err == nil {
		t.Fatal("oversized recall accepted")
	}
}

func TestControlProofMigrationAndPersistence(t *testing.T) {
	db := openIsolatedAuthorityServiceTestDatabase(t)
	migration, err := os.ReadFile("../../migrations/034_authenticated_control_proofs.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range strings.Split(string(migration), ";") {
		if strings.TrimSpace(statement) == "" {
			continue
		}
		if _, err = db.Exec(statement); err != nil && !strings.Contains(err.Error(), "Duplicate column") {
			t.Fatal(err)
		}
	}
	insertAttachmentTestUser(t, db, "1801-AAAA", "sender")
	insertAttachmentTestUser(t, db, "1802-BBBB", "reader")
	ctx := context.Background()
	svc := NewMessageReadService(db)
	const id = "abc123-1-abcdef"
	if _, _, err = svc.AcceptMessage(ctx, id, "1801-AAAA", "1802-BBBB"); err != nil {
		t.Fatal(err)
	}
	for _, proof := range []string{"first-read", "retry-read"} {
		receipts, readErr := svc.RecordReads(ctx, []string{id}, "1801-AAAA", "1802-BBBB", map[string]string{id: proof})
		if readErr != nil || len(receipts) != 1 || receipts[0].Proof != "first-read" {
			t.Fatalf("receipts=%v err=%v", receipts, readErr)
		}
	}
	receipts, err := svc.GetReadReceiptsByPeer(ctx, "1801-AAAA", "1802-BBBB")
	if err != nil || len(receipts) != 1 || receipts[0].Proof != "first-read" {
		t.Fatalf("GET=%v err=%v", receipts, err)
	}
	grouped, err := svc.GetReadReceiptsForSender(ctx, "1801-AAAA")
	if err != nil || len(grouped["1802-BBBB"]) != 1 || grouped["1802-BBBB"][0].Proof != "first-read" {
		t.Fatalf("offline=%v err=%v", grouped, err)
	}
	for _, proof := range []string{"first-recall", "retry-recall"} {
		delivery, found, recallErr := svc.RecallMessage(ctx, id, "1801-AAAA", "1802-BBBB", proof)
		if recallErr != nil || !found || delivery.RecallProof != "first-recall" {
			t.Fatalf("recall=%v err=%v", delivery, recallErr)
		}
	}
	recalls, err := svc.GetPendingRecalls(ctx, "1802-BBBB", 100)
	if err != nil || len(recalls) != 1 || recalls[0].Proof != "first-recall" {
		t.Fatalf("recalls=%v err=%v", recalls, err)
	}
	group, err := NewGroupService(db).CreateGroup(ctx, "proofs", []string{"1801-AAAA", "1802-BBBB"})
	if err != nil {
		t.Fatal(err)
	}
	groupSvc := NewGroupService(db)
	const groupMsgID = "abc123-2-abcdef"
	_, _, err = groupSvc.AcceptGroupMessage(ctx, "1801-AAAA", group.GroupID, groupMsgID, "iv", "ciphertext", []KeyEnvelope{{To: "1802-BBBB", EphemeralPubKey: "key", IV: "iv", KeyCiphertext: "envelope"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, proof := range []string{"first-group", "retry-group"} {
		stored, recallErr := groupSvc.RecallGroupMessageWithProof(ctx, "1801-AAAA", group.GroupID, groupMsgID, proof)
		if recallErr != nil || stored != "first-group" {
			t.Fatalf("group proof=%q err=%v", stored, recallErr)
		}
	}
	tombstones, err := groupSvc.GetPendingGroupTombstones(ctx, "1802-BBBB", 100)
	if err != nil || len(tombstones) != 1 || tombstones[0].Proof != "first-group" || tombstones[0].From != "1801-AAAA" {
		t.Fatalf("group offline=%v err=%v", tombstones, err)
	}
}
