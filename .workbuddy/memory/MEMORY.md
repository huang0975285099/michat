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

## 版本号与升级提示（发布必读，易漏）
升级提示是**服务端驱动**的：客户端只在启动时调一次 `GET /api/version`（`MainLayout.checkAppUpdate`，无轮询），用 `getUpdateStatus(APP_VERSION, latest, min_supported)` 判断——`current == latest` 返回 `current`，**不提示**。因此「本地打包出 exe/apk」不等于「发布了新版本」。

提升版本时必须同步改 **7 处**（历史上多次只改了前 5 处，导致老用户收不到升级提示）：
1. `frontend/package.json` → `"version"`
2. `frontend/src-capacitor/package.json` → `"version"`
3. `frontend/src-tauri/Cargo.toml` → `version =`
4. `frontend/src-tauri/Cargo.lock` → `[[package]] name = "yunmi"` 下的 `version =`
5. `frontend/src-capacitor/android/app/build.gradle` → `versionName` + `versionCode`（+1）
6. `docker-compose.yml` → `APP_LATEST_VERSION`（生产 `/api/version` 的真正来源）
7. `backend/config.yaml` → `version.latest`（本地/开发值；生产被 compose 环境变量覆盖）

发布还须：把新包上传到服务器 `/usr/share/nginx/html/download/{yunChat.exe,yunChat.apk}`（下载 URL 是固定文件名，见 `APP_WINDOWS_UPDATE_URL` / `APP_APK_UPDATE_URL`），并重建 backend 容器（环境变量仅启动时读取）。改完用 `curl https://m.yzs88.com:8088/api/version` 核对 `latest`。

用户侧：已打开的客户端不会立即弹提示，需重启 App，或在「我的」页手动「检查更新」。
