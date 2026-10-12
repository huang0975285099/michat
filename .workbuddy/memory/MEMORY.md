# miChat 项目架构速览

> 仓库模块名 `e2eechat`；产品对外名 yunChat(云密)/Yunmi；生产域名 https://m.yzs88.com:8088
> 端到端加密聊天应用。后端不解密 —— 私钥永不上传，后端仅存 P-256 公钥 + 转发密文 + ECDSA 验签。

## 技术栈
- 后端：Go 1.25 + Gin + gorilla/websocket + go-redis + MySQL 8.1；监听 :8888
- 前端：Quasar 2 / Vue 3 / Vite + Web Crypto API + Pinia + axios
- 加密：P-256（Web Crypto 无 X25519，故用 P-256 单密钥双用途：ECDH 派生 AES-256-GCM 消息密钥 + 重新导入为 ECDSA 做登录挑战签名）
- 部署：docker-compose（mysql/redis/backend/frontend/edge-nginx/coturn）；API+WS 走「客户端→edge→frontend(nginx)→backend」双重代理；admin 壳由后端直供
- 多端：Web/PWA、Electron(Win)、Tauri、Capacitor(Android)、TURN 信令用于 WebRTC 通话

## 后端关键目录
- cmd/server/main.go —— 依赖装配 + 全部路由注册
- internal/handler —— HTTP 层，仅编排，调 service
- internal/service —— 业务核心（identity/friend/group/message_read/attachment/invite/admin/ironfist/dragon_tiger/push）
- internal/ws/hub.go —— 实时中枢（消息/文件/通话信令/在线状态/可靠收件箱）
- internal/dragontiger、internal/ironfistengine —— 游戏权威引擎
- internal/model、migrations/*.sql —— 33 张表，自动迁移
- pkg/crypto —— 空目录（后端不解密）；pkg/mysql、pkg/redis

## 前端关键目录
- services/crypto.js —— 单聊/文件 ECDH+AES-GCM、密钥生成存储、ECDSA 挑战
- services/group-crypto.mjs —— 群聊内容密钥 + 每成员密钥信封
- services/websocket.js、api.js —— 全部通信入口
- games/ironfist —— 铁拳(含龙虎斗下注)、$FIST 代币经济
- stores/(Pinia)、pages/、components/、boot/、router/

## 上手阅读顺序
1. main.go → 2. ws/hub.go → 3. service/identity.go → 4. frontend crypto.js/group-crypto.mjs → 5. websocket.js/api.js → 6. docker-compose + nginx 配置 → 7. migrations
