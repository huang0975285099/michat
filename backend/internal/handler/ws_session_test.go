package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"e2eechat/internal/service"
	"e2eechat/internal/ws"
	"github.com/gorilla/websocket"
)

type bindingFailureValidator struct {
	failure error
	revoke  bool
}

func (validator bindingFailureValidator) ValidateSession(context.Context, string) (string, error) {
	return "1234-ABCD", validator.failure
}
func (validator bindingFailureValidator) SubscribeSessionRevocation(_, _ string, revoke func()) func() {
	if validator.revoke {
		revoke()
	}
	return func() {}
}

func TestBindingFailureReportsAuthenticationResultBeforeClosing(t *testing.T) {
	for _, scenario := range []struct {
		name              string
		failure           error
		revoke, retryable bool
	}{
		{"expired", service.ErrInvalidSession, false, false},
		{"revoked-during-binding", nil, true, false},
		{"redis-unavailable", errors.New("Redis temporarily unavailable"), false, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				upgrader := websocket.Upgrader{}
				connection, err := upgrader.Upgrade(writer, request, nil)
				if err != nil {
					t.Error(err)
					return
				}
				defer connection.Close()
				client := &ws.Client{ChatID: "1234-ABCD"}
				ws.InitClient(client, connection, make(chan []byte, 1))
				if completeWSAuthentication(connection, client, "token", bindingFailureValidator{scenario.failure, scenario.revoke}) {
					t.Error("failed session was authenticated")
				}
			}))
			defer server.Close()
			peer, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer peer.Close()
			peer.SetReadDeadline(time.Now().Add(time.Second))
			var result struct {
				Type    string `json:"type"`
				Payload struct {
					Success   bool   `json:"success"`
					Reason    string `json:"reason"`
					Retryable bool   `json:"retryable"`
				} `json:"payload"`
			}
			if err := peer.ReadJSON(&result); err != nil {
				t.Fatalf("missing authentication failure frame: %v", err)
			}
			if result.Type != "auth_result" || result.Payload.Success || result.Payload.Reason == "" || result.Payload.Retryable != scenario.retryable {
				t.Fatalf("unexpected authentication result: %+v", result)
			}
			if _, _, err := peer.ReadMessage(); err == nil {
				t.Fatal("failed connection remained open")
			}
		})
	}
}
