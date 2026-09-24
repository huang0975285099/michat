package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"gopkg.in/yaml.v3"

	"e2eechat/internal/handler"
	"e2eechat/internal/middleware"
	"e2eechat/internal/service"
	"e2eechat/internal/ws"
	"e2eechat/migrations"
	pkgmysql "e2eechat/pkg/mysql"
	pkgredis "e2eechat/pkg/redis"
)

type Config struct {
	Server struct {
		Port      int    `yaml:"port"`
		JWTSecret string `yaml:"jwt_secret"`
	} `yaml:"server"`
	MySQL struct {
		DSN string `yaml:"dsn"`
	} `yaml:"mysql"`
	Redis struct {
		Addr     string `yaml:"addr"`
		Password string `yaml:"password"`
		DB       int    `yaml:"db"`
	} `yaml:"redis"`
	Turn struct {
		Secret string `yaml:"secret"`
		Host   string `yaml:"host"`
		Port   int    `yaml:"port"`
	} `yaml:"turn"`
	JPush struct {
		AppKey       string `yaml:"app_key"`
		MasterSecret string `yaml:"master_secret"`
		Enabled      bool   `yaml:"enabled"`
	} `yaml:"jpush"`
	Version struct {
		Latest       string `yaml:"latest"`
		MinSupported string `yaml:"min_supported"`
		URL          string `yaml:"url"`
		Windows      string `yaml:"windows"`
		APK          string `yaml:"apk"`
		Notes        string `yaml:"notes"`
	} `yaml:"version"`
	Attachments struct {
		StoragePath    string `yaml:"storage_path"`
		MaxFileMB      int64  `yaml:"max_file_mb"`
		MaxAccountMB   int64  `yaml:"max_account_mb"`
		MinChunkKB     int64  `yaml:"min_chunk_kb"`
		MaxChunkMB     int64  `yaml:"max_chunk_mb"`
		UploadTTLHours int64  `yaml:"upload_ttl_hours"`
		RetentionHours int64  `yaml:"retention_hours"`
		TombstoneHours int64  `yaml:"tombstone_hours"`
	} `yaml:"attachments"`
	AllowedOrigins []string `yaml:"allowed_origins"`
}

func envInt64(name string, fallback int64) int64 {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		log.Fatalf("%s must be a positive integer", name)
	}
	return parsed
}

func main() {
	cfgPath := "config.yaml"
	if v := os.Getenv("CONFIG"); v != "" {
		cfgPath = v
	}
	cfgData, err := os.ReadFile(cfgPath)
	if err != nil {
		log.Fatalf("read config: %v", err)
	}
	var cfg Config
	if err = yaml.Unmarshal(cfgData, &cfg); err != nil {
		log.Fatalf("parse config: %v", err)
	}

	// Environment variables overwrite sensitive fields
	if v := os.Getenv("JWT_SECRET"); v != "" {
		cfg.Server.JWTSecret = v
	}
	if v := os.Getenv("MYSQL_DSN"); v != "" {
		cfg.MySQL.DSN = v
	}
	if v := os.Getenv("TURN_SECRET"); v != "" {
		cfg.Turn.Secret = v
	}
	if v := os.Getenv("JPUSH_APP_KEY"); v != "" {
		cfg.JPush.AppKey = v
	}
	if v := os.Getenv("JPUSH_MASTER_SECRET"); v != "" {
		cfg.JPush.MasterSecret = v
	}
	// Version information (maintained in docker-compose environment variables, updated every time a version is released)
	if v := os.Getenv("APP_LATEST_VERSION"); v != "" {
		cfg.Version.Latest = v
	}
	if v := os.Getenv("APP_MIN_VERSION"); v != "" {
		cfg.Version.MinSupported = v
	}
	if v := os.Getenv("APP_UPDATE_URL"); v != "" {
		cfg.Version.URL = v
	}
	if v := os.Getenv("APP_WINDOWS_UPDATE_URL"); v != "" {
		cfg.Version.Windows = v
	}
	if v := os.Getenv("APP_APK_UPDATE_URL"); v != "" {
		cfg.Version.APK = v
	}
	if v := os.Getenv("APP_VERSION_NOTES"); v != "" {
		cfg.Version.Notes = v
	}

	if cfg.Server.JWTSecret == "" || cfg.MySQL.DSN == "" || cfg.Turn.Secret == "" {
		log.Fatal("JWT_SECRET, MYSQL_DSN, TURN_SECRET must be set (env var or config file)")
	}

	db, err := pkgmysql.New(cfg.MySQL.DSN)
	if err != nil {
		log.Fatalf("mysql: %v", err)
	}
	defer db.Close()

	if err = migrations.AutoMigrate(db); err != nil {
		log.Fatalf("auto migrate: %v", err)
	}

	var rdb *redis.Client
	if cfg.Redis.Addr == "" || cfg.Redis.Addr == "memory" {
		// Local development: Use the memory version of Redis, no installation required
		rdb, err = pkgredis.NewInMemory()
	} else {
		rdb, err = pkgredis.New(cfg.Redis.Addr, cfg.Redis.Password, cfg.Redis.DB)
	}
	if err != nil {
		log.Fatalf("redis: %v", err)
	}

	identSvc := service.NewIdentityService(db, rdb)
	friendSvc := service.NewFriendService(db, rdb)
	messageReadSvc := service.NewMessageReadService(db)
	inviteSvc := service.NewInviteService(rdb, friendSvc)
	adminSvc := service.NewAdminService(db, rdb)

	attachmentDefaults := service.DefaultAttachmentConfig()
	attachmentStoragePath := cfg.Attachments.StoragePath
	if attachmentStoragePath == "" {
		attachmentStoragePath = "./data/attachments"
	}
	if value := os.Getenv("ATTACHMENT_STORAGE_PATH"); value != "" {
		attachmentStoragePath = value
	}
	attachmentConfig := service.AttachmentConfig{
		MaxFileBytes:    envInt64("ATTACHMENT_MAX_FILE_MB", cfg.Attachments.MaxFileMB) * 1024 * 1024,
		MaxAccountBytes: envInt64("ATTACHMENT_MAX_ACCOUNT_MB", cfg.Attachments.MaxAccountMB) * 1024 * 1024,
		MinChunkBytes:   envInt64("ATTACHMENT_MIN_CHUNK_KB", cfg.Attachments.MinChunkKB) * 1024,
		MaxChunkBytes:   envInt64("ATTACHMENT_MAX_CHUNK_MB", cfg.Attachments.MaxChunkMB) * 1024 * 1024,
		UploadTTL:       time.Duration(envInt64("ATTACHMENT_UPLOAD_TTL_HOURS", cfg.Attachments.UploadTTLHours)) * time.Hour,
		Retention:       time.Duration(envInt64("ATTACHMENT_RETENTION_HOURS", cfg.Attachments.RetentionHours)) * time.Hour,
		TombstoneTTL:    time.Duration(envInt64("ATTACHMENT_TOMBSTONE_HOURS", cfg.Attachments.TombstoneHours)) * time.Hour,
	}
	if cfg.Attachments.MaxFileMB <= 0 && os.Getenv("ATTACHMENT_MAX_FILE_MB") == "" {
		attachmentConfig.MaxFileBytes = attachmentDefaults.MaxFileBytes
	}
	if cfg.Attachments.MaxAccountMB <= 0 && os.Getenv("ATTACHMENT_MAX_ACCOUNT_MB") == "" {
		attachmentConfig.MaxAccountBytes = attachmentDefaults.MaxAccountBytes
	}
	if cfg.Attachments.MinChunkKB <= 0 && os.Getenv("ATTACHMENT_MIN_CHUNK_KB") == "" {
		attachmentConfig.MinChunkBytes = attachmentDefaults.MinChunkBytes
	}
	if cfg.Attachments.MaxChunkMB <= 0 && os.Getenv("ATTACHMENT_MAX_CHUNK_MB") == "" {
		attachmentConfig.MaxChunkBytes = attachmentDefaults.MaxChunkBytes
	}
	if cfg.Attachments.UploadTTLHours <= 0 && os.Getenv("ATTACHMENT_UPLOAD_TTL_HOURS") == "" {
		attachmentConfig.UploadTTL = attachmentDefaults.UploadTTL
	}
	if cfg.Attachments.RetentionHours <= 0 && os.Getenv("ATTACHMENT_RETENTION_HOURS") == "" {
		attachmentConfig.Retention = attachmentDefaults.Retention
	}
	if cfg.Attachments.TombstoneHours <= 0 && os.Getenv("ATTACHMENT_TOMBSTONE_HOURS") == "" {
		attachmentConfig.TombstoneTTL = attachmentDefaults.TombstoneTTL
	}
	if err := service.ValidateAttachmentConfig(attachmentConfig); err != nil {
		log.Fatalf("attachment configuration: %v", err)
	}
	attachmentStorage, err := service.NewLocalAttachmentStorage(attachmentStoragePath)
	if err != nil {
		log.Fatalf("attachment storage: %v", err)
	}
	attachmentSvc := service.NewAttachmentService(db, attachmentStorage, attachmentConfig)
	identSvc.SetAttachmentCleanup(func(ctx context.Context, attachmentIDs []string) error {
		for _, attachmentID := range attachmentIDs {
			if cleanupErr := attachmentStorage.DeleteAttachment(ctx, attachmentID); cleanupErr != nil {
				return cleanupErr
			}
		}
		return nil
	})

	hub := ws.NewHub(rdb, friendSvc, identSvc, messageReadSvc)

	// Aurora Push (enabled when both AppKey and MasterSecret are configured)
	if cfg.JPush.AppKey != "" && cfg.JPush.MasterSecret != "" {
		pushSvc := service.NewPushService(db, cfg.JPush.AppKey, cfg.JPush.MasterSecret, cfg.JPush.Enabled)
		hub.SetPushService(pushSvc)
		log.Println("JPush push notification enabled")
	}

	identHandler := handler.NewIdentityHandler(identSvc, inviteSvc, friendSvc, hub)
	userHandler := handler.NewUserHandler(identSvc)
	friendHandler := handler.NewFriendHandler(friendSvc, hub)
	inviteHandler := handler.NewInviteHandler(inviteSvc)
	wsHandler := handler.NewWSHandler(hub, identSvc, cfg.AllowedOrigins)
	turnHandler := handler.NewTurnHandler(cfg.Turn.Secret, cfg.Turn.Host, cfg.Turn.Port)
	messagesHandler := handler.NewMessagesHandler(messageReadSvc)
	deviceHandler := handler.NewDeviceHandler(db)
	versionHandler := handler.NewVersionHandler(
		cfg.Version.Latest,
		cfg.Version.MinSupported,
		cfg.Version.URL,
		cfg.Version.Windows,
		cfg.Version.APK,
		cfg.Version.Notes,
	)
	adminHandler := handler.NewAdminHandler(adminSvc)
	adminAuth := handler.NewAdminAuth(os.Getenv("ADMIN_USERNAME"), os.Getenv("ADMIN_PASSWORD"))
	robotHandler := handler.NewRobotHandler(db)
	robotMediaPath := os.Getenv("ROBOT_MEDIA_PATH")
	if robotMediaPath == "" {
		robotMediaPath = "./data/robot-media"
	}
	robotMediaHandler, err := handler.NewRobotMediaHandler(robotMediaPath)
	if err != nil {
		log.Fatalf("robot media storage: %v", err)
	}
	attachmentHandler := handler.NewAttachmentHandler(attachmentSvc)

	// Current limiting (mainly mobile phone + operator CGNAT: relax the threshold by IP, the main line of defense is based on user authRL):
	// - publicRL: Unauthenticated public interface 100 times/minute/IP (version check/login burst for multiple phones with the same IP)
	// - authRL: Authenticated interface 120 times/minute/user (by chatID, not affected by shared IP at all)
	// The "according to IP rate" current limit for WS connection establishment is handed over to edge nginx (with burst smoothing and real IP), and the backend no longer
	// Superimpose rate limiting to avoid accidental damage caused by reconnection storms under CGNAT; the backend uses the upper limit on the number of concurrent connections (see ws.go) to protect against accidental damage.
	publicRL := middleware.NewRateLimiter(100, time.Minute)
	authRL := middleware.NewRateLimiterFunc(120, time.Minute, func(c *gin.Context) string {
		if id := c.GetString(middleware.CtxChatID); id != "" {
			return id
		}
		return c.ClientIP()
	})

	r := gin.New()
	r.Use(middleware.PrivacyLogger(log.Writer()), middleware.PrivacyRecovery(log.Writer()))
	// The backend is only exposed after nginx backend, trusting the private network proxy so that ClientIP() can get the real client IP in XFF.
	if err := r.SetTrustedProxies([]string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.1/32"}); err != nil {
		log.Fatalf("set trusted proxies: %v", err)
	}
	r.Use(corsMiddleware(cfg.AllowedOrigins))

	api := r.Group("/api")
	{
		// No authentication required (limited flow)
		open := api.Group("", publicRL.Limit())
		open.POST("/identity/init", identHandler.Init)
		open.GET("/identity/reauth/challenge", identHandler.GetReauthChallenge)
		open.POST("/identity/reauth", identHandler.Reauth)
		open.GET("/invite/validate", inviteHandler.Validate)
		open.GET("/version", versionHandler.Get)
		open.GET("/robot/articles", robotHandler.List)
		open.GET("/robot/articles/:id", robotHandler.Get)
		open.GET("/robot/media/:name", robotMediaHandler.Get)
		open.POST("/admin/login", adminAuth.Login)

		// Authentication is required (current limit based on user)
		auth := api.Group("", middleware.Auth(identSvc), authRL.Limit())
		auth.PUT("/identity/pubkey", identHandler.UploadPubkey)
		auth.PUT("/identity/nickname", identHandler.UpdateNickname)
		auth.GET("/identity/me", identHandler.Me)
		auth.DELETE("/identity/logout", identHandler.Logout)
		auth.DELETE("/identity/me", identHandler.DeleteAccount)
		auth.GET("/users/search", userHandler.Search)
		auth.POST("/friends/request", friendHandler.SendRequest)
		auth.GET("/friends/requests", friendHandler.GetRequests)
		auth.GET("/friends/outgoing", friendHandler.GetOutgoing)
		auth.PUT("/friends/request/:id", friendHandler.HandleRequest)
		auth.DELETE("/friends/request/:id", friendHandler.CancelRequest)
		auth.GET("/friends", friendHandler.GetFriends)
		auth.POST("/invite/generate", inviteHandler.Generate)
		auth.GET("/turn-credentials", turnHandler.GetCredentials)
		auth.GET("/friends/:peerId/read-receipts", messagesHandler.GetReadReceipts)
		auth.POST("/device/token", deviceHandler.SaveToken)
		auth.DELETE("/device/token", deviceHandler.DeleteTokens)
		auth.POST("/attachments", attachmentHandler.Init)
		auth.GET("/attachments/quota", attachmentHandler.Quota)
		auth.GET("/attachments/:id", attachmentHandler.Get)
		auth.PUT("/attachments/:id/chunks/:index", attachmentHandler.PutChunk)
		auth.GET("/attachments/:id/chunks/:index", attachmentHandler.DownloadChunk)
		auth.POST("/attachments/:id/complete", attachmentHandler.Complete)
		auth.POST("/attachments/:id/ack", attachmentHandler.Acknowledge)
		auth.DELETE("/attachments/:id", attachmentHandler.Cancel)
		auth.POST("/robot/articles/:id/view", robotHandler.RecordView)

		admin := api.Group("/admin", adminAuth.Require())
		admin.GET("/stats", adminHandler.GetStats)
		admin.POST("/logout", adminAuth.Logout)
		admin.GET("/robot/articles", robotHandler.List)
		admin.GET("/robot/articles/:id", robotHandler.Get)
		admin.GET("/robot/articles/:id/views", robotHandler.ListViews)
		admin.POST("/robot/articles", robotHandler.Create)
		admin.PUT("/robot/articles/:id", robotHandler.Update)
		admin.DELETE("/robot/articles/:id", robotHandler.Delete)
		admin.POST("/robot/media", robotMediaHandler.Upload)
	}

	// The dashboard shell itself. It holds no data — it prompts for a token and then
	// calls /api/admin/stats, which is where the actual authorisation happens.
	r.GET("/admin", publicRL.Limit(), adminHandler.Page)

	// Start a scheduled task: automatically reject friend requests that have not been processed for more than 7 days
	go func() {
		autoReject := func() {
			if err := friendSvc.AutoRejectExpired(context.Background()); err != nil {
				log.Printf("[cron] auto reject expired requests: %v", err)
			}
		}
		autoReject()
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			autoReject()
		}
	}()

	// Remove incomplete uploads after 24 hours, unclaimed attachments after 7
	// days, and ciphertext immediately after a recipient acknowledgement.
	go func() {
		cleanup := func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			if count, cleanupErr := attachmentSvc.CleanupExpired(ctx, 500); cleanupErr != nil {
				log.Printf("[cron] cleanup encrypted attachments: %v", cleanupErr)
			} else if count > 0 {
				log.Printf("[cron] cleaned up %d encrypted attachments", count)
			}
		}
		cleanup()
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			cleanup()
		}
	}()

	// Start a scheduled task: clean up read receipts older than 7 days to avoid unlimited growth of the message_reads table
	go func() {
		cleanup := func() {
			if n, err := messageReadSvc.ExpirePendingEncryptedMessages(context.Background()); err != nil {
				log.Printf("[cron] cleanup expired encrypted inbox: %v", err)
			} else if n > 0 {
				log.Printf("[cron] expired %d encrypted inbox messages", n)
			}
			n, err := messageReadSvc.DeleteOldReadReceipts(context.Background(), 7)
			if err != nil {
				log.Printf("[cron] cleanup read receipts: %v", err)
			} else if n > 0 {
				log.Printf("[cron] cleaned up %d old read receipts", n)
			}
		}
		cleanup()
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			cleanup()
		}
	}()

	r.GET("/ws", wsHandler.Serve)

	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	log.Printf("E2EE Chat server listening on %s", addr)

	// Explicitly configure timeouts to prevent slow attacks such as Slowloris from filling up connections/goroutines.
	// - ReadHeaderTimeout: the upper limit of reading the request header (slow attack core defense line)
	// - ReadTimeout: the upper limit for reading the entire request (gorilla will manage the deadline after WS upgrade and will not be affected)
	// - IdleTimeout: keep-alive idle recycling
	// - No WriteTimeout: WS is a long connection, and a unified write timeout will cause accidental killing (gorilla has its own deadline for each write)
	srv := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       20 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if err = srv.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}

func corsMiddleware(allowedOrigins []string) gin.HandlerFunc {
	allowAll := len(allowedOrigins) == 0 || (len(allowedOrigins) == 1 && allowedOrigins[0] == "*")

	originSet := make(map[string]struct{}, len(allowedOrigins))
	for _, o := range allowedOrigins {
		originSet[o] = struct{}{}
	}

	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if allowAll {
			if origin != "" {
				c.Header("Access-Control-Allow-Origin", origin)
				c.Header("Vary", "Origin")
			} else {
				c.Header("Access-Control-Allow-Origin", "*")
			}
		} else if _, ok := originSet[origin]; ok {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
		} else if handler.IsLocalDevOrigin(origin) {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
		}
		c.Header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Chunk-SHA256")
		c.Header("Access-Control-Expose-Headers", "Content-Length,X-Chunk-SHA256")
		c.Header("Access-Control-Allow-Credentials", "true")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
