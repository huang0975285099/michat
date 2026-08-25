package ws

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"testing"

	pkgredis "e2eechat/pkg/redis"
	"github.com/alicebob/miniredis/v2"
	redisclient "github.com/redis/go-redis/v9"
)

func TestValidFileMetadata(t *testing.T) {
	tests := []struct {
		name     string
		filename string
		filetype string
		want     bool
	}{
		{name: "zip", filename: "archive.zip", filetype: "application/zip", want: true},
		{name: "zip alias", filename: "archive.ZIP", filetype: "application/x-zip-compressed", want: true},
		{name: "rar modern mime", filename: "archive.rar", filetype: "application/vnd.rar", want: true},
		{name: "rar x-rar alias", filename: "archive.rar", filetype: "application/x-rar", want: true},
		{name: "rar x-compressed alias", filename: "archive.rar", filetype: "application/x-compressed", want: true},
		{name: "rar vendor mime", filename: "archive.rar", filetype: "application/x-winrar", want: true},
		{name: "rar nonstandard mime", filename: "archive.rar", filetype: "application/rar", want: true},
		{name: "7z", filename: "archive.7z", filetype: "application/x-7z-compressed", want: true},
		{name: "generic mime requires allowed extension", filename: "archive.rar", filetype: "application/octet-stream", want: true},
		{name: "empty mime requires allowed extension", filename: "archive.gz", filetype: "", want: true},
		{name: "office reported as zip", filename: "report.docx", filetype: "application/zip", want: true},
		{name: "disallowed extension", filename: "malware.exe", filetype: "application/octet-stream", want: false},
		{name: "missing extension", filename: "archive", filetype: "application/zip", want: false},
		{name: "allowed extension ignores mime", filename: "archive.zip", filetype: "image/png", want: true},
		{name: "double extension uses final extension", filename: "archive.zip.exe", filetype: "application/zip", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := validFileMetadata(tt.filename, tt.filetype); got != tt.want {
				t.Fatalf("validFileMetadata(%q, %q) = %v, want %v", tt.filename, tt.filetype, got, tt.want)
			}
		})
	}
}

func TestValidateEncryptedFileOffer(t *testing.T) {
	offer := validEncryptedFileOffer()
	mode, err := validateFileOffer(offer)
	if err != nil {
		t.Fatalf("validate encrypted file offer: %v", err)
	}
	if mode != fileMetadataEncrypted {
		t.Fatalf("metadata mode = %v, want encrypted", mode)
	}
}

func TestValidateFileOfferAccepts100MBFile(t *testing.T) {
	offer := validEncryptedFileOffer()
	offer.Filesize = maxFileSize
	offer.TotalChunks = expectedFileChunks(maxFileSize)

	if _, err := validateFileOffer(offer); err != nil {
		t.Fatalf("validate 100MB file offer: %v", err)
	}
}

func TestValidateFileOfferRejectsMalformedEncryptedMetadata(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*FileOfferPayload)
	}{
		{name: "partial envelope", mutate: func(p *FileOfferPayload) { p.MetadataIV = "" }},
		{name: "invalid base64", mutate: func(p *FileOfferPayload) { p.MetadataCiphertext = "%%%" }},
		{name: "wrong iv length", mutate: func(p *FileOfferPayload) {
			p.MetadataIV = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{4}, 11))
		}},
		{name: "oversized ciphertext", mutate: func(p *FileOfferPayload) {
			p.MetadataCiphertext = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{5}, 1025))
		}},
		{name: "wrong chunk count", mutate: func(p *FileOfferPayload) { p.TotalChunks = 2 }},
		{name: "oversized file", mutate: func(p *FileOfferPayload) { p.Filesize = maxFileSize + 1 }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			offer := validEncryptedFileOffer()
			tt.mutate(&offer)
			if _, err := validateFileOffer(offer); err == nil {
				t.Fatal("malformed encrypted offer was accepted")
			}
		})
	}
}

func TestValidateFileOfferAcceptsLegacyMetadata(t *testing.T) {
	offer := validEncryptedFileOffer()
	offer.MetadataEphemeralPubKey = ""
	offer.MetadataIV = ""
	offer.MetadataCiphertext = ""
	offer.Filename = "report.pdf"
	offer.Filetype = "application/pdf"

	mode, err := validateFileOffer(offer)
	if err != nil {
		t.Fatalf("validate legacy file offer: %v", err)
	}
	if mode != fileMetadataLegacy {
		t.Fatalf("metadata mode = %v, want legacy", mode)
	}
}

func TestForwardEncryptedFileOfferOmitsPlaintextMetadata(t *testing.T) {
	offer := validEncryptedFileOffer()
	offer.Filename = "diagnosis-report.pdf"
	offer.Filetype = "application/pdf"

	forwarded := newForwardFileOffer("1111-AAAA", offer, 123456789, fileMetadataEncrypted)
	raw, err := json.Marshal(forwarded)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("diagnosis-report.pdf")) || bytes.Contains(raw, []byte("application/pdf")) {
		t.Fatalf("encrypted forward leaked plaintext metadata: %s", raw)
	}
	if !bytes.Contains(raw, []byte(offer.MetadataCiphertext)) {
		t.Fatal("encrypted metadata was not forwarded")
	}
}

func TestForwardLegacyFileOfferPreservesPlaintextMetadata(t *testing.T) {
	offer := validEncryptedFileOffer()
	offer.Filename = "report.pdf"
	offer.Filetype = "application/pdf"

	forwarded := newForwardFileOffer("1111-AAAA", offer, 123456789, fileMetadataLegacy)
	raw, err := json.Marshal(forwarded)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("report.pdf")) || !bytes.Contains(raw, []byte("application/pdf")) {
		t.Fatalf("legacy forward dropped plaintext metadata: %s", raw)
	}
}

func validEncryptedFileOffer() FileOfferPayload {
	return FileOfferPayload{
		To:                      "2222-BBBB",
		TransferID:              "11111111-1111-1111-1111-111111111111",
		MsgID:                   "loyw3v28-1-abc123",
		Filesize:                128,
		TotalChunks:             1,
		EphemeralPubKey:         base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 91)),
		IV:                      base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 12)),
		MetadataEphemeralPubKey: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 91)),
		MetadataIV:              base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{4}, 12)),
		MetadataCiphertext:      base64.StdEncoding.EncodeToString([]byte("authenticated metadata")),
	}
}

func TestExpectedFileChunksAndSizes(t *testing.T) {
	tests := []struct {
		filesize int64
		chunks   int
		lastSize int
	}{
		{filesize: 1, chunks: 1, lastSize: 1 + aesGCMTagSize},
		{filesize: fileChunkSize - aesGCMTagSize, chunks: 1, lastSize: fileChunkSize},
		{filesize: fileChunkSize - aesGCMTagSize + 1, chunks: 2, lastSize: 1},
		{filesize: maxFileSize, chunks: 801, lastSize: aesGCMTagSize},
	}
	for _, tt := range tests {
		if got := expectedFileChunks(tt.filesize); got != tt.chunks {
			t.Fatalf("expectedFileChunks(%d) = %d, want %d", tt.filesize, got, tt.chunks)
		}
		if got := expectedFileChunkSize(tt.filesize, tt.chunks-1); got != tt.lastSize {
			t.Fatalf("last chunk size for %d = %d, want %d", tt.filesize, got, tt.lastSize)
		}
	}
}

func TestHandleFileChunkRequiresAcceptedBoundSession(t *testing.T) {
	const transferID = "11111111-1111-1111-1111-111111111111"
	sender := &Client{ChatID: "1111-AAAA", send: make(chan []byte, 2)}
	recipient := &Client{ChatID: "2222-BBBB", send: make(chan []byte, 2)}
	attacker := &Client{ChatID: "3333-CCCC", send: make(chan []byte, 2)}
	session := &fileTransferSession{
		sender:         sender.ChatID,
		recipient:      recipient.ChatID,
		filesize:       10,
		totalChunks:    1,
		receivedChunks: make([]bool, 1),
		accepted:       true,
	}
	hub := &Hub{
		clients:       map[string]*Client{recipient.ChatID: recipient},
		fileTransfers: map[string]*fileTransferSession{transferID: session},
	}
	data := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 10+aesGCMTagSize))
	payload, _ := json.Marshal(map[string]any{
		"to": recipient.ChatID, "transfer_id": transferID, "chunk_index": 0, "data": data,
	})

	hub.handleFileChunk(attacker, payload)
	if len(recipient.send) != 0 || session.receivedCount != 0 {
		t.Fatal("unauthorized chunk was forwarded or counted")
	}
	if len(attacker.send) != 1 {
		t.Fatal("unauthorized sender did not receive file_error")
	}

	hub.handleFileChunk(sender, payload)
	if len(recipient.send) != 1 || session.receivedCount != 1 || !session.receivedChunks[0] {
		t.Fatal("authorized chunk was not forwarded and recorded")
	}
}

func TestHandleFileAcceptRequiresRecipient(t *testing.T) {
	const transferID = "22222222-2222-2222-2222-222222222222"
	sender := &Client{ChatID: "1111-AAAA", send: make(chan []byte, 2)}
	recipient := &Client{ChatID: "2222-BBBB", send: make(chan []byte, 2)}
	attacker := &Client{ChatID: "3333-CCCC", send: make(chan []byte, 2)}
	session := &fileTransferSession{sender: sender.ChatID, recipient: recipient.ChatID}
	hub := &Hub{
		clients:       map[string]*Client{sender.ChatID: sender},
		fileTransfers: map[string]*fileTransferSession{transferID: session},
	}
	payload, _ := json.Marshal(map[string]any{"to": sender.ChatID, "transfer_id": transferID})

	hub.handleFileSimpleRelay(attacker, "file_accept", payload)
	if session.accepted || len(sender.send) != 0 || len(attacker.send) != 1 {
		t.Fatal("unauthorized file_accept was not rejected")
	}

	hub.handleFileSimpleRelay(recipient, "file_accept", payload)
	if !session.accepted || len(sender.send) != 1 {
		t.Fatal("recipient file_accept was not relayed")
	}
}

func TestFileCompleteAndDoneFollowBoundDirection(t *testing.T) {
	const transferID = "33333333-3333-3333-3333-333333333333"
	const msgID = "loyw3v28-1-abc123"
	sender := &Client{ChatID: "1111-AAAA", send: make(chan []byte, 2)}
	recipient := &Client{ChatID: "2222-BBBB", send: make(chan []byte, 2)}
	session := &fileTransferSession{
		sender:         sender.ChatID,
		recipient:      recipient.ChatID,
		msgID:          msgID,
		totalChunks:    1,
		receivedChunks: []bool{true},
		receivedCount:  1,
		accepted:       true,
		timestamp:      123456789,
	}
	hub := &Hub{
		clients: map[string]*Client{
			sender.ChatID:    sender,
			recipient.ChatID: recipient,
		},
		fileTransfers: map[string]*fileTransferSession{transferID: session},
	}

	complete, _ := json.Marshal(map[string]any{"to": recipient.ChatID, "transfer_id": transferID})
	hub.handleFileSimpleRelay(sender, "file_complete", complete)
	if len(recipient.send) != 1 {
		t.Fatal("valid file_complete was not relayed to recipient")
	}

	done, _ := json.Marshal(map[string]any{
		"to": sender.ChatID, "transfer_id": transferID, "ts": int64(999),
	})
	hub.handleFileSimpleRelay(recipient, "file_done", done)
	if len(sender.send) != 1 || !session.done {
		t.Fatal("valid file_done was not relayed to sender")
	}

	var message Message
	if err := json.Unmarshal(<-sender.send, &message); err != nil {
		t.Fatal(err)
	}
	var forwarded struct {
		Timestamp int64  `json:"ts"`
		MsgID     string `json:"msg_id"`
	}
	if err := json.Unmarshal(message.Payload, &forwarded); err != nil {
		t.Fatal(err)
	}
	if forwarded.Timestamp != session.timestamp {
		t.Fatalf("file_done timestamp = %d, want server timestamp %d", forwarded.Timestamp, session.timestamp)
	}
	if forwarded.MsgID != msgID {
		t.Fatalf("file_done msg_id = %q, want %q", forwarded.MsgID, msgID)
	}
	if _, exists := hub.fileTransfers[transferID]; exists {
		t.Fatal("completed file transfer session was not removed")
	}
}

func TestFileDoneIsStoredWhenSenderDisconnects(t *testing.T) {
	const transferID = "44444444-4444-4444-4444-444444444444"
	const msgID = "loyw3v28-2-def456"
	srv := miniredis.RunT(t)
	rdb := redisclient.NewClient(&redisclient.Options{Addr: srv.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	recipient := &Client{ChatID: "2222-BBBB", send: make(chan []byte, 1)}
	hub := &Hub{
		redis:   rdb,
		clients: map[string]*Client{recipient.ChatID: recipient},
		fileTransfers: map[string]*fileTransferSession{
			transferID: {
				sender:         "1111-AAAA",
				recipient:      recipient.ChatID,
				msgID:          msgID,
				totalChunks:    1,
				receivedChunks: []bool{true},
				receivedCount:  1,
				accepted:       true,
				timestamp:      123456789,
			},
		},
	}

	payload, _ := json.Marshal(map[string]any{
		"to": "1111-AAAA", "transfer_id": transferID,
	})
	hub.handleFileSimpleRelay(recipient, "file_done", payload)

	stored, err := rdb.LRange(context.Background(), pkgredis.OfflineKey("1111-AAAA"), 0, -1).Result()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 {
		t.Fatalf("stored file_done count = %d, want 1", len(stored))
	}
	var message Message
	if err = json.Unmarshal([]byte(stored[0]), &message); err != nil {
		t.Fatal(err)
	}
	if message.Type != "file_done" {
		t.Fatalf("stored message type = %q, want file_done", message.Type)
	}
	var forwarded struct {
		MsgID string `json:"msg_id"`
	}
	if err = json.Unmarshal(message.Payload, &forwarded); err != nil {
		t.Fatal(err)
	}
	if forwarded.MsgID != msgID {
		t.Fatalf("stored file_done msg_id = %q, want %q", forwarded.MsgID, msgID)
	}
}
