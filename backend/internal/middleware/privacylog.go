package middleware

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

const CtxRequestID = "request_id"

func newRequestID() string {
	var id [8]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "unavailable"
	}
	return hex.EncodeToString(id[:])
}

func PrivacyLogger(out io.Writer) gin.HandlerFunc {
	logger := log.New(out, "", 0)
	return func(c *gin.Context) {
		requestID := newRequestID()
		c.Set(CtxRequestID, requestID)
		started := time.Now()

		c.Next()

		route := c.FullPath()
		if route == "" {
			route = "unmatched-route"
		}
		logger.Printf(
			"request_id=%s method=%s route=%s status=%d latency_ms=%d",
			requestID,
			c.Request.Method,
			route,
			c.Writer.Status(),
			time.Since(started).Milliseconds(),
		)
	}
}

func PrivacyRecovery(out io.Writer) gin.HandlerFunc {
	logger := log.New(out, "", 0)
	return func(c *gin.Context) {
		defer func() {
			if recover() == nil {
				return
			}
			logger.Printf("request_id=%s event=request-panic", c.GetString(CtxRequestID))
			c.AbortWithStatus(http.StatusInternalServerError)
		}()
		c.Next()
	}
}
