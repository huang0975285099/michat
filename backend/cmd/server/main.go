package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
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
		Notes        string `yaml:"notes"`
	} `yaml:"version"`
	AllowedOrigins []string `yaml:"allowed_origins"`
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

	// 环境变量覆写敏感字段
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
	// 版本信息（在 docker-compose 环境变量里维护，每次发版更新）
	if v := os.Getenv("APP_LATEST_VERSION"); v != "" {
		cfg.Version.Latest = v
	}
	if v := os.Getenv("APP_MIN_VERSION"); v != "" {
		cfg.Version.MinSupported = v
	}
	if v := os.Getenv("APP_UPDATE_URL"); v != "" {
		cfg.Version.URL = v
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
		// 本地开发：使用内存版 Redis，免安装
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
	fistSvc := service.NewFistService(db)
	fistHandler := handler.NewFistHandler(fistSvc)
	ironFistSvc := service.NewIronFistService(db)

	hub := ws.NewHub(rdb, friendSvc, identSvc, messageReadSvc)

	// IronFistHandler 需要 hub 推送 PVP 匹配通知，故在 hub 之后构造
	ironFistHandler := handler.NewIronFistHandler(ironFistSvc, hub)
	fistStatsHandler := handler.NewFistStatsHandler(fistSvc, ironFistSvc)

	// 极光推送（AppKey 和 MasterSecret 均配置时启用）
	if cfg.JPush.AppKey != "" && cfg.JPush.MasterSecret != "" {
		pushSvc := service.NewPushService(db, cfg.JPush.AppKey, cfg.JPush.MasterSecret, cfg.JPush.Enabled)
		hub.SetPushService(pushSvc)
		log.Println("JPush push notification enabled")
	}

	// 启用 PVP 大厅在线列表功能（大厅用户互看头像/余额/场次）
	hub.SetIronFistService(ironFistSvc)

	identHandler := handler.NewIdentityHandler(identSvc, inviteSvc, friendSvc, hub)
	userHandler := handler.NewUserHandler(identSvc)
	friendHandler := handler.NewFriendHandler(friendSvc, hub)
	inviteHandler := handler.NewInviteHandler(inviteSvc)
	wsHandler := handler.NewWSHandler(hub, identSvc, cfg.AllowedOrigins)
	turnHandler := handler.NewTurnHandler(cfg.Turn.Secret, cfg.Turn.Host, cfg.Turn.Port)
	messagesHandler := handler.NewMessagesHandler(messageReadSvc)
	deviceHandler := handler.NewDeviceHandler(db)
	versionHandler := handler.NewVersionHandler(cfg.Version.Latest, cfg.Version.MinSupported, cfg.Version.URL, cfg.Version.Notes)

	// 限流（手机为主 + 运营商 CGNAT：按 IP 的阈值放宽，主防线放在按用户 authRL）：
	//   - publicRL：未认证公开接口 100 次/分钟/IP（同 IP 多手机的版本检查/登录突发）
	//   - authRL  ：已认证接口 120 次/分钟/用户（按 chatID，完全不受共享 IP 影响）
	// WS 建连的“按 IP 速率”限流交给边缘 nginx（有突发平滑、用真实 IP），后端不再
	// 叠加速率限流以免 CGNAT 下重连风暴误伤；后端用并发连接数上限（见 ws.go）兜底。
	publicRL := middleware.NewRateLimiter(100, time.Minute)
	authRL := middleware.NewRateLimiterFunc(120, time.Minute, func(c *gin.Context) string {
		if id := c.GetString(middleware.CtxChatID); id != "" {
			return id
		}
		return c.ClientIP()
	})

	r := gin.Default()
	// 后端只在 nginx 反代之后暴露，信任私网代理以便 ClientIP() 取到 XFF 中的真实客户端 IP。
	if err := r.SetTrustedProxies([]string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.1/32"}); err != nil {
		log.Fatalf("set trusted proxies: %v", err)
	}
	r.Use(corsMiddleware(cfg.AllowedOrigins))

	api := r.Group("/api")
	{
		// 无需鉴权（有限流）
		open := api.Group("", publicRL.Limit())
		open.POST("/identity/init", identHandler.Init)
		open.GET("/identity/reauth/challenge", identHandler.GetReauthChallenge)
		open.POST("/identity/reauth", identHandler.Reauth)
		open.GET("/invite/validate", inviteHandler.Validate)
		open.GET("/version", versionHandler.Get)
		// $FIST 生态透明度统计（国际站介绍页用，纯聚合数据，无需鉴权）
		open.GET("/fist/stats", fistStatsHandler.GetStats)

		// 需要鉴权（按用户限流）
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

		// $FIST 代币
		auth.GET("/fist/account", fistHandler.GetAccount)
		auth.POST("/fist/pve-reward", fistHandler.ClaimPvEReward)
		auth.GET("/fist/transactions", fistHandler.GetTransactions)

		// 铁拳对战统计与成就
		auth.GET("/games/ironfist/stats", ironFistHandler.GetStats)
		auth.POST("/games/ironfist/stats", ironFistHandler.ReportMatch)
		auth.GET("/games/ironfist/matches", ironFistHandler.ListMatches)

		// PVP 撮合队列（加入 / 取消）
		auth.POST("/games/ironfist/pvp/queue", ironFistHandler.EnqueuePVP)
		auth.DELETE("/games/ironfist/pvp/queue", ironFistHandler.CancelPVPQueue)
		auth.GET("/games/ironfist/pvp/queue", ironFistHandler.GetPVPQueueStatus)
	}

	// 启动定时任务：自动拒绝超过 7 天未处理的好友申请
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

	// 启动定时任务：清理超过 7 天的已读回执，避免 message_reads 表无限增长
	go func() {
		cleanup := func() {
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

	// 启动定时任务：每 1 分钟扫描超时的 PVP 房间并退款兜底
	//   - matching 超时：客户端崩溃/失联未取消，全额退给 A
	//   - matched 超时：双方/单方断线未上报结果、或 WS 匹配通知丢失导致一方未开局，
	//     按平局退款，避免质押永久锁定
	go func() {
		sweep := func() {
			if n, err := ironFistSvc.SweepTimeoutPVPQueues(context.Background()); err != nil {
				log.Printf("[cron] sweep pvp timeout queues: %v", err)
			} else if n > 0 {
				log.Printf("[cron] swept %d timeout pvp queues", n)
			}
			if n, err := ironFistSvc.SweepTimeoutPVPMatched(context.Background()); err != nil {
				log.Printf("[cron] sweep pvp timeout matched: %v", err)
			} else if n > 0 {
				log.Printf("[cron] swept %d timeout pvp matched rooms", n)
			}
		}
		// 启动后等 1 分钟再首次执行，避免启动瞬间误判
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			sweep()
		}
	}()

	r.GET("/ws", wsHandler.Serve)

	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	log.Printf("E2EE Chat server listening on %s", addr)

	// 显式配置超时，防 Slowloris 等慢速攻击占满连接/goroutine。
	//   - ReadHeaderTimeout：读完请求头的上限（慢速攻击核心防线）
	//   - ReadTimeout：读完整个请求的上限（WS 升级后 gorilla 自管 deadline，不受影响）
	//   - IdleTimeout：keep-alive 空闲回收
	//   - 不设 WriteTimeout：WS 为长连接，统一写超时会误杀（gorilla 每次写自带 deadline）
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
		c.Header("Access-Control-Allow-Headers", "Content-Type,Authorization")
		c.Header("Access-Control-Allow-Credentials", "true")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
