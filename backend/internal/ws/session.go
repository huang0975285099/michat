package ws

import (
	"context"
	"errors"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"e2eechat/internal/service"
)

const sessionCheckInterval = 5 * time.Second
const sessionCheckTimeout = 2 * time.Second
const sessionFailureGrace = 30 * time.Second

type SessionValidator interface {
	ValidateSession(context.Context, string) (string, error)
	SubscribeSessionRevocation(string, string, func()) func()
}

type clientSession struct {
	token       string
	validator   SessionValidator
	mu          sync.Mutex
	active      bool
	revoked     bool
	lastSuccess atomic.Int64
}

func (c *Client) closeSession() {
	c.signalClose()
	if c.conn != nil {
		c.conn.Close()
	}
}

func (c *Client) checkSession() error {
	if c.session == nil {
		return nil
	}
	select {
	case <-c.closed:
		return service.ErrInvalidSession
	default:
	}
	ctx, cancel := context.WithTimeout(context.Background(), sessionCheckTimeout)
	defer cancel()
	chatID, err := c.session.validator.ValidateSession(ctx, c.session.token)
	if err != nil {
		return err
	}
	if chatID != c.ChatID || chatID == "" {
		return service.ErrInvalidSession
	}
	select {
	case <-c.closed:
		return service.ErrInvalidSession
	default:
		c.session.lastSuccess.Store(time.Now().UnixNano())
		return nil
	}
}

func (c *Client) validateSession() bool {
	err := c.checkSession()
	if err == nil {
		return true
	}
	if !errors.Is(err, service.ErrInvalidSession) && c.session != nil {
		lastSuccess := c.session.lastSuccess.Load()
		if lastSuccess != 0 && time.Since(time.Unix(0, lastSuccess)) < sessionFailureGrace {
			log.Printf("[ws] session validation temporarily unavailable: %v", err)
			return true
		}
	}
	c.closeSession()
	return false
}

func (c *Client) BindSession(token string, validator SessionValidator) error {
	c.session = &clientSession{token: token, validator: validator}
	session := c.session
	unsubscribe := validator.SubscribeSessionRevocation(token, c.ChatID, func() {
		session.mu.Lock()
		session.revoked = true
		active := session.active
		c.signalClose()
		session.mu.Unlock()
		if active && c.conn != nil {
			c.conn.Close()
		}
	})
	err := c.checkSession()
	session.mu.Lock()
	if session.revoked {
		err = service.ErrInvalidSession
	}
	if err == nil {
		session.active = true
	}
	session.mu.Unlock()
	if err != nil {
		unsubscribe()
		c.signalClose()
		return err
	}
	go c.monitorSession(unsubscribe, sessionCheckInterval)
	return nil
}

func (c *Client) monitorSession(unsubscribe func(), interval time.Duration) {
	defer unsubscribe()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-c.closed:
			return
		case <-ticker.C:
			if !c.validateSession() {
				return
			}
		}
	}
}
