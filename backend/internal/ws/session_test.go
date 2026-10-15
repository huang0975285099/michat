package ws

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gorilla/websocket"
	rdb "github.com/redis/go-redis/v9"

	"e2eechat/internal/service"
	pkgredis "e2eechat/pkg/redis"
)

func sessionTestClient(t *testing.T) (*Client, *service.IdentityService, *miniredis.Miniredis) {
	t.Helper()
	server := miniredis.RunT(t)
	redis := rdb.NewClient(&rdb.Options{Addr: server.Addr(), MaxRetries: -1})
	t.Cleanup(func() { redis.Close() })
	server.Set(pkgredis.SessionKey("token"), "1234-ABCD:0")
	server.SetTTL(pkgredis.SessionKey("token"), time.Hour)
	client := &Client{ChatID: "1234-ABCD"}
	InitClient(client, nil, make(chan []byte, 1))
	t.Cleanup(client.closeSession)
	return client, service.NewIdentityService(nil, redis), server
}

func requireSessionClosed(t *testing.T, client *Client) {
	t.Helper()
	select {
	case <-client.closed:
	case <-time.After(time.Second):
		t.Fatal("session was not closed")
	}
}

func TestSessionRevocationImmediateAndTokenScoped(t *testing.T) {
	client, identity, _ := sessionTestClient(t)
	if err := client.BindSession("token", identity); err != nil {
		t.Fatal("valid session rejected")
	}
	if err := identity.RevokeSession(context.Background(), "other-token"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-client.closed:
		t.Fatal("unrelated logout closed session")
	default:
	}
	if err := identity.RevokeSession(context.Background(), "token"); err != nil {
		t.Fatal(err)
	}
	requireSessionClosed(t, client)
	if client.validateSession() {
		t.Fatal("revoked session accepted inbound work")
	}
}

func TestSessionRevalidation(t *testing.T) {
	for _, scenario := range []string{"expiry", "reauth", "legacy-reauth", "identity-mismatch", "redis-failure", "malformed-generation"} {
		t.Run(scenario, func(t *testing.T) {
			client, identity, server := sessionTestClient(t)
			if scenario == "legacy-reauth" {
				server.Set(pkgredis.SessionKey("token"), client.ChatID)
			}
			if err := client.BindSession("token", identity); err != nil {
				t.Fatal("valid session rejected")
			}
			switch scenario {
			case "expiry":
				server.FastForward(2 * time.Hour)
			case "reauth", "legacy-reauth":
				server.Set(pkgredis.SessionGenKey(client.ChatID), "1")
			case "identity-mismatch":
				server.Set(pkgredis.SessionKey("token"), "5678-EFGH:0")
			case "redis-failure":
				server.SetError("ERR unavailable")
			case "malformed-generation":
				server.Set(pkgredis.SessionGenKey(client.ChatID), "invalid")
			}
			if scenario == "redis-failure" {
				if !client.validateSession() {
					t.Fatal("temporary Redis failure closed a recently validated session")
				}
				client.session.lastSuccess.Store(time.Now().Add(-sessionFailureGrace - time.Second).UnixNano())
			}
			if client.validateSession() {
				t.Fatal("invalid session accepted")
			}
			requireSessionClosed(t, client)
		})
	}
}

func TestIdleSessionPeriodicClosure(t *testing.T) {
	client, identity, server := sessionTestClient(t)
	client.session = &clientSession{token: "token", validator: identity}
	finished := make(chan struct{})
	go client.monitorSession(func() { close(finished) }, 5*time.Millisecond)
	server.Del(pkgredis.SessionKey("token"))
	requireSessionClosed(t, client)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("monitor did not unsubscribe")
	}
}

type racingSessionValidator struct {
	mu           sync.Mutex
	revoked      bool
	unsubscribed bool
}

func (validator *racingSessionValidator) SubscribeSessionRevocation(_, _ string, closeSession func()) func() {
	validator.mu.Lock()
	validator.revoked = true
	validator.mu.Unlock()
	closeSession()
	return func() {
		validator.mu.Lock()
		validator.unsubscribed = true
		validator.mu.Unlock()
	}
}

func (validator *racingSessionValidator) ValidateSession(context.Context, string) (string, error) {
	return "", errors.New("revoked")
}

func TestRevocationDuringBinding(t *testing.T) {
	client := &Client{ChatID: "1234-ABCD"}
	InitClient(client, nil, make(chan []byte, 1))
	validator := &racingSessionValidator{}
	if err := client.BindSession("token", validator); err == nil {
		t.Fatal("revocation during binding accepted")
	}
	requireSessionClosed(t, client)
	if !validator.unsubscribed {
		t.Fatal("failed binding leaked listener")
	}
}

func TestRevocationClosesSocketAndStopsReadPump(t *testing.T) {
	for _, immediate := range []bool{true, false} {
		t.Run(map[bool]string{true: "logout-hook", false: "inbound-revalidation"}[immediate], func(t *testing.T) {
			client, identity, redisServer := sessionTestClient(t)
			ready := make(chan struct{})
			finished := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				upgrader := websocket.Upgrader{}
				conn, err := upgrader.Upgrade(writer, request, nil)
				if err != nil {
					t.Error(err)
					return
				}
				InitClient(client, conn, make(chan []byte, 1))
				if err := client.BindSession("token", identity); err != nil {
					t.Error("binding failed")
					return
				}
				close(ready)
				client.readPump(&Hub{})
				client.signalClose()
				close(finished)
			}))
			defer server.Close()
			peer, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer peer.Close()
			<-ready
			if immediate {
				if err := identity.RevokeSession(context.Background(), "token"); err != nil {
					t.Fatal(err)
				}
			} else {
				redisServer.Set(pkgredis.SessionGenKey(client.ChatID), "1")
				go client.monitorSession(func() {}, 5*time.Millisecond)
				if err := peer.WriteMessage(websocket.TextMessage, []byte(`{"type":"pvp_lobby_join"}`)); err != nil {
					t.Fatal(err)
				}
			}
			peer.SetReadDeadline(time.Now().Add(time.Second))
			if _, _, err := peer.ReadMessage(); err == nil {
				t.Fatal("revoked connection remained readable")
			}
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("read pump did not exit")
			}
		})
	}
}

type countingSessionValidator struct{ calls atomic.Int64 }

func (validator *countingSessionValidator) ValidateSession(context.Context, string) (string, error) {
	validator.calls.Add(1)
	return "1234-ABCD", nil
}
func (*countingSessionValidator) SubscribeSessionRevocation(string, string, func()) func() {
	return func() {}
}

func TestReadPumpDoesNotQuerySessionStoreForEachMessage(t *testing.T) {
	validator := &countingSessionValidator{}
	ready := make(chan *Client, 1)
	finished := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		upgrader := websocket.Upgrader{}
		connection, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		client := &Client{ChatID: "1234-ABCD"}
		InitClient(client, connection, make(chan []byte, 32))
		if err := client.BindSession("token", validator); err != nil {
			t.Error(err)
			return
		}
		ready <- client
		client.readPump(&Hub{})
		client.signalClose()
		close(finished)
	}))
	defer server.Close()
	peer, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	client := <-ready
	for index := 0; index < 10; index++ {
		if err := peer.WriteMessage(websocket.TextMessage, []byte(`{"type":"health_ping","payload":{"nonce":"abcdefghijklmnop"}}`)); err != nil {
			t.Fatal(err)
		}
		select {
		case <-client.send:
		case <-time.After(time.Second):
			t.Fatal("message dispatch stalled")
		}
	}
	if calls := validator.calls.Load(); calls != 1 {
		t.Fatalf("10 messages caused %d validation calls, expected initial binding only", calls)
	}
	peer.Close()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("read pump did not stop")
	}
}

func TestRedisRecoveryResetsSessionGraceWithoutDeferringRevocation(t *testing.T) {
	client, identity, server := sessionTestClient(t)
	if err := client.BindSession("token", identity); err != nil {
		t.Fatal(err)
	}
	server.SetError("ERR unavailable")
	if !client.validateSession() {
		t.Fatal("transient error closed session")
	}
	server.SetError("")
	client.session.lastSuccess.Store(time.Now().Add(-sessionFailureGrace - time.Second).UnixNano())
	if !client.validateSession() {
		t.Fatal("recovered session was rejected")
	}
	if time.Since(time.Unix(0, client.session.lastSuccess.Load())) > time.Second {
		t.Fatal("recovery did not reset grace")
	}
	server.SetError("ERR unavailable")
	if err := identity.RevokeSession(context.Background(), "token"); err == nil {
		t.Fatal("expected Redis failure")
	}
	requireSessionClosed(t, client)
}
