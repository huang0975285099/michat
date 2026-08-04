package middleware

import (
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
)

type windowCounter struct {
	mu    sync.Mutex
	count int
	reset time.Time
}

// RateLimiter fixed window current limit. The default is IP, the key can be customized through NewRateLimiterFunc
// (For example, press the authenticated user chatID to avoid multiple users occupying each other's quota under shared NAT).
type RateLimiter struct {
	clients sync.Map
	limit   int
	window  time.Duration
	keyFn   func(*gin.Context) string
	reqN    atomic.Uint64
}

func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{limit: limit, window: window, keyFn: func(c *gin.Context) string { return c.ClientIP() }}
}

// NewRateLimiterFunc Same as NewRateLimiter, but uses keyFn to extract the rate limiting key.
func NewRateLimiterFunc(limit int, window time.Duration, keyFn func(*gin.Context) string) *RateLimiter {
	return &RateLimiter{limit: limit, window: window, keyFn: keyFn}
}

func (rl *RateLimiter) Limit() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Lazy trigger cleanup to avoid continued expansion of clients during long-running operations.
		if rl.reqN.Add(1)%1024 == 0 {
			rl.cleanupStale()
		}

		key := rl.keyFn(c)
		now := time.Now()

		v, _ := rl.clients.LoadOrStore(key, &windowCounter{reset: now.Add(rl.window)})
		wc := v.(*windowCounter)

		wc.mu.Lock()
		if now.After(wc.reset) {
			wc.count = 0
			wc.reset = now.Add(rl.window)
		}
		wc.count++
		over := wc.count > rl.limit
		wc.mu.Unlock()

		if over {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "rate limit exceeded"})
			return
		}
		c.Next()
	}
}

// cleanupStale deletes long-term inactive IP counters:
// If there are no new requests for more than 1 window after the window of an entry ends, it will be recycled.
func (rl *RateLimiter) cleanupStale() {
	now := time.Now()
	rl.clients.Range(func(key, value any) bool {
		wc, ok := value.(*windowCounter)
		if !ok {
			rl.clients.Delete(key)
			return true
		}

		wc.mu.Lock()
		stale := now.After(wc.reset.Add(rl.window))
		wc.mu.Unlock()
		if stale {
			rl.clients.Delete(key)
		}
		return true
	})
}
