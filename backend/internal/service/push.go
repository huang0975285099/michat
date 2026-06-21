package service

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// PushService 通过极光推送 REST API 向离线用户发送通知。
// 通知内容不含任何消息正文，仅携带发送者 chat_id，确保 E2EE 不被破坏。
type PushService struct {
	appKey       string
	masterSecret string
	enabled      bool
	db           *sql.DB
	client       *http.Client
}

func NewPushService(db *sql.DB, appKey, masterSecret string, enabled bool) *PushService {
	return &PushService{
		appKey:       appKey,
		masterSecret: masterSecret,
		enabled:      enabled,
		db:           db,
		client:       &http.Client{Timeout: 5 * time.Second},
	}
}

// NotifyOfflineUser 查找接收方的所有设备 token 并推送通知。
// 在 goroutine 中调用，不阻塞消息处理主流程。
func (s *PushService) NotifyOfflineUser(recipientChatID, senderChatID string) {
	if !s.enabled {
		return
	}
	regIDs, err := s.getRegIDs(recipientChatID)
	if err != nil || len(regIDs) == 0 {
		return
	}
	if err := s.send(regIDs, senderChatID); err != nil {
		log.Printf("[push] send to %s failed: %v", recipientChatID, err)
	}
}

func (s *PushService) getRegIDs(chatID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT reg_id FROM device_tokens WHERE chat_id = ?`, chatID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	return ids, rows.Err()
}

// ---- JPush REST API v3 ----

type jpushRequest struct {
	Platform     string            `json:"platform"`
	Audience     jpushAudience     `json:"audience"`
	Notification jpushNotification `json:"notification"`
	Options      jpushOptions      `json:"options"`
}

type jpushAudience struct {
	RegistrationID []string `json:"registration_id"`
}

type jpushNotification struct {
	Android jpushAndroid `json:"android"`
}

type jpushAndroid struct {
	Title  string            `json:"title"`
	Alert  string            `json:"alert"`
	Extras map[string]string `json:"extras,omitempty"`
}

type jpushOptions struct {
	TimeToLive int `json:"time_to_live"`
}

func (s *PushService) send(regIDs []string, senderChatID string) error {
	payload := jpushRequest{
		Platform: "android",
		Audience: jpushAudience{RegistrationID: regIDs},
		Notification: jpushNotification{
			Android: jpushAndroid{
				Title: "云密",
				Alert: "您收到一条新消息",
				Extras: map[string]string{
					"sender_chat_id": senderChatID,
				},
			},
		},
		Options: jpushOptions{TimeToLive: 86400},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, "https://api.jpush.cn/v3/push", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("new request: %w", err)
	}

	cred := base64.StdEncoding.EncodeToString([]byte(s.appKey + ":" + s.masterSecret))
	req.Header.Set("Authorization", "Basic "+cred)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("jpush status %d", resp.StatusCode)
	}
	return nil
}
