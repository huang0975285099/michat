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

// RateLimiter 固定窗口限流。默认按 IP，可通过 NewRateLimiterFunc 自定义键
// （如按已认证用户 chatID，避免共享 NAT 下多用户互相挤占额度）。
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

// NewRateLimiterFunc 与 NewRateLimiter 相同，但用 keyFn 提取限流键。
func NewRateLimiterFunc(limit int, window time.Duration, keyFn func(*gin.Context) string) *RateLimiter {
	return &RateLimiter{limit: limit, window: window, keyFn: keyFn}
}

func (rl *RateLimiter) Limit() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 惰性触发清理，避免长期运行时 clients 持续膨胀。
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

// cleanupStale 删除长期不活跃的 IP 计数器：
// 若一个条目的窗口结束后又超过 1 个 window 都没有新请求，则回收。
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
