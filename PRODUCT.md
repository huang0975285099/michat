# 云密（E2EE Chat）产品说明文档

> **云密**——只为隐私安全而生。基于端到端加密与零信任架构的私密应用，采用 ECDH P-256 密钥协商 + AES-256-GCM 加密，消息仅收发双方可解密，服务器零知识、零存储、零追踪。支持加密文字/文件传输、阅后即焚、语音通话、安全码锁定，邀请制注册保障社群纯净。Web / PWA / Electron 桌面端 / Android 原生端多端可用，离线消息通过极光推送实时提醒（推送不含任何消息正文）。

## 1. 产品概述

**云密**是一款基于端到端加密（End-to-End Encryption, E2EE）的私密应用，遵循"最小数据原则"设计理念，确保用户通信内容仅由通信双方掌控。服务器仅负责消息转发，不存储、不解析任何可读通信数据，从架构层面杜绝第三方窥探、数据泄露与非法抓取。

- **产品名称**：云密
- **产品定位**：隐私安全工具
- **部署域名**：https://yb.yzs88.com
- **支持平台**：Web 浏览器、PWA（可安装到桌面）、Electron 桌面客户端（Windows .exe）、Android 原生客户端（.apk）
- **客户端下载**：首页提供 Windows 桌面端（`yunChat.exe`）与 Android（`yunChat.apk`）下载，iOS 暂以 PWA 形式提供

---

## 2. 核心能力

### 2.1 端到端安全加密（E2EE）

采用现代密码学协议实现全链路加密保护：

- **密钥协商**：ECDH P-256 椭圆曲线密钥交换，通信双方协商出共享会话密钥
- **消息加密**：AES-256-GCM 高强度对称加密，单条消息独立会话密钥
- **私钥管理**：私钥仅存储于用户本地设备（IndexedDB），使用设备密钥加密保护，永不上传服务器
- **前向安全**：动态会话密钥更新，强化前向安全防护

### 2.2 极简轻量化服务架构

- 服务器仅参与消息转发，不存储可读数据
- 不记录用户行为日志
- 最大限度缩小数据暴露范围

### 2.3 加密文件安全传输

- 支持图片、视频、文档、压缩包、APK 等多种文件类型
- 文件全程加密流转，传输与临时缓存全链路保护
- 文件分块传输（128KB/块），最大支持 10MB
- **可靠传输确认**：接收端收齐并解密成功后回发确认（`file_done`），发送方据此才标记「已发送」；接收端设有传输停滞看门狗（30 秒无进展即判定失败并通知发送方），任一分块丢失或中途掉线都会被检测并提示重发，避免出现「发送方显示成功、接收方实际未收到」的不一致
- 支持的文件类型：
  - 图片：JPEG、PNG、GIF、WebP、BMP、SVG
  - 视频：MP4、WebM、MOV
  - 文档：PDF、Word（doc/docx）、Excel（xls/xlsx）、PowerPoint（ppt/pptx）
  - 压缩包：ZIP、RAR、7Z、TAR、GZIP
  - Android 安装包：APK

### 2.4 阅后即焚

- 发送方可逐条开启「阅后即焚」
- 消息被阅读后 2 小时自动销毁，**收发双方各自的副本均会删除**（发送方从收到已读回执起算、接收方从本人阅读起算）
- 采用相对计时（记录阅读时刻而非绝对删除时间），防止篡改系统时间绕过销毁
- 不在设备或网络中留下长期痕迹

### 2.5 截屏防护与风险提醒

- 多终端适配隐私防护机制
- 支持截屏行为检测与风险提醒
- 多维度守护会话隐私（不同系统能力存在差异）

### 2.6 离线消息推送（隐私优先）

- Android 原生端集成极光推送（JPush），用户离线时也能实时收到新消息提醒
- 推送通知**不含任何消息正文**，仅携带发送者 Chat ID，端到端加密不被破坏
- 服务器仅在接收方不在线时触发推送，且在独立 goroutine 中异步执行，不阻塞消息转发
- 点击通知可直达对应会话；退出登录自动清除设备推送 Token

### 2.7 纯净无追踪体验

- 无广告推送
- 无用户画像采集
- 无后台行为追踪
- 加密私钥本地独立存储，充分保障用户数据自主权

---

## 3. 功能模块

### 3.1 身份管理

| 功能 | 说明 |
|------|------|
| 身份创建 | 通过邀请码注册，自动生成唯一 Chat ID（格式：NNNN-AAAA，如 1234-ABCD）和加密密钥对 |
| 直接注册 | Android 原生端与 Electron 桌面端无需邀请码即可直接创建身份（Web 端仍需邀请码） |
| 身份恢复 | 支持通过备份的私钥（Base64）恢复已有身份 |
| 昵称修改 | 支持自定义昵称，初始昵称由系统自动生成（颜色+动物组合） |
| 私钥备份 | 支持导出私钥为 Base64 文本，用于跨设备恢复 |
| 账号注销 | 彻底删除账号信息及所有好友关系，不可恢复 |

### 3.2 邀请制注册

- Web 端采用邀请制注册，保障社群私密环境
- 已注册用户可生成邀请链接
- 邀请码具有时效性，过期或无效将无法使用
- 通过邀请链接注册的用户将自动添加邀请者为好友
- Android / Electron 原生端可免邀请码直接注册（通过 `file://` 或 `https://localhost` 来源识别原生环境）

### 3.3 好友管理

| 功能 | 说明 |
|------|------|
| 搜索添加 | 通过 Chat ID 搜索用户并发送好友申请 |
| 好友申请 | 接收/拒绝/发送好友申请，实时推送通知 |
| 好友列表 | 查看好友在线状态、昵称、Chat ID |
| 好友删除 | 支持删除好友关系 |

### 3.4 聊天功能

| 功能 | 说明 |
|------|------|
| 文字消息 | 端到端加密文字聊天，支持表情发送 |
| 文件传输 | 加密文件传输，支持图片/视频预览和文件下载；含传输确认与失败检测，避免单边「假成功」 |
| 消息已读 | 已读/未读状态回执，双勾标识；回执持久化并在重连/重开会话时幂等补发，断网或刷新也不丢失 |
| 阅后即焚 | 开启后，被阅读 2 小时自动销毁，收发双方各自副本均删除 |
| 消息撤回 | 2 分钟内支持双方删除，超时仅支持为我删除 |
| 在线状态 | 实时显示好友在线/离线状态 |
| 消息通知 | 支持浏览器桌面通知，窗口失焦时自动推送；Android 端离线时通过极光推送提醒 |

### 3.5 音视频通话

- 基于 WebRTC 的端到端加密**语音 / 视频通话**（1:1），媒体流经 DTLS-SRTP 点对点加密
- 通过 TURN 服务器实现 NAT 穿透
- 语音：支持静音/取消静音
- 视频：全屏远端画面 + 本地小窗预览，支持开关摄像头、前后摄像头切换（移动端浏览器）
- 通话类型随呼叫信令传递，来电按"语音/视频"区分提示
- 来电提醒与呼叫等待（呼叫 30 秒无应答自动结束）
- 通话前进行设备与权限检测，无可用麦克风/摄像头时给出明确提示
- 视频分辨率默认约束 720p 以控制带宽
- 全端可用：移动端通过 Safari / Chrome 浏览器即可使用（需 HTTPS 安全上下文）

### 3.6 安全码锁定

| 功能 | 说明 |
|------|------|
| 安全码设置 | 设置 6 位数字安全码，防止他人查看聊天记录 |
| 自动锁定 | 支持自定义超时时间（10 分钟/30 分钟/1 小时/4 小时），超时自动锁定 |
| 手动锁定 | 支持立即锁定应用 |
| 防暴力破解 | 错误次数过多触发冷却期，防止暴力破解 |

---

## 4. 技术架构

### 4.1 整体架构

```
   Web / PWA / Electron / Android
┌──────────────┐     HTTPS/WSS     ┌──────────────┐
│              │ ◄───────────────► │              │
│   Frontend   │                   │   Backend    │
│  (Vue 3 +    │                   │  (Go + Gin)  │
│   Quasar)    │                   │              │
│              │                   │      │       │
└──────────────┘                   └──────┼───────┘
                                          │
                          ┌───────────┬───┼───┬───────────┐
                          │           │   │   │           │
                    ┌─────┴─────┐ ┌───┴─┐ │ ┌─┴───┐ ┌─────┴─────┐
                    │   MySQL   │ │Redis│ │ │ TURN│ │  JPush    │
                    │ (数据存储) │ │(缓存)│ │ │(穿透)│ │ (离线推送) │
                    └───────────┘ └─────┘ │ └─────┘ └─────┬─────┘
                                          │               │
                                          ▼               ▼
                                  消息转发(WS)      离线设备推送提醒
                                                 (不含消息正文)
```

### 4.2 前端技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Vue | 3.5+ | 前端框架 |
| Quasar | 2.17+ | UI 组件库 |
| Pinia | 2.3+ | 状态管理 |
| Vue Router | 4.5+ | 路由管理 |
| Axios | 1.7+ | HTTP 客户端 |
| Web Crypto API | - | 加密运算 |
| IndexedDB | - | 本地数据持久化 |
| WebSocket | - | 实时通信 |
| WebRTC | - | 语音 / 视频通话 |
| Workbox | 7.4+ | PWA Service Worker |
| Electron | 41+ | 桌面客户端（Windows） |
| Capacitor | 8.3+ | Android 原生客户端封装 |
| JPush (极光推送) | - | Android 原生端离线消息推送（cn.jpush SDK） |

### 4.3 后端技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Go | 1.25+ | 后端语言 |
| Gin | 1.12+ | Web 框架 |
| Gorilla WebSocket | 1.5+ | WebSocket 支持 |
| MySQL | - | 数据存储 |
| Redis | 9.18+ | 缓存/会话管理 |
| JPush REST API v3 | - | 向离线 Android 设备推送通知 |

### 4.4 加密方案

```
发送方                                    接收方
  │                                         │
  │  1. 加载对方公钥                          │
  │  2. ECDH P-256 密钥协商                   │
  │  ──────────────────────────────────►    │
  │  3. 派生 AES-256-GCM 会话密钥              │
  │  4. 加密消息明文                           │
  │  5. 通过 WebSocket 发送密文                │
  │  ──────────────────────────────────►    │
  │                                         │  6. ECDH P-256 密钥协商
  │                                         │  7. 派生相同会话密钥
  │                                         │  8. 解密消息密文
```

**密钥层级**：

- **身份密钥对**：ECDH P-256，注册时生成，公钥上传服务器，私钥加密存储于本地 IndexedDB
- **设备密钥**：AES-256-GCM，non-extractable，用于加密保护私钥存储
- **安全码密钥**：PBKDF2 派生，用户设置安全码后用于加密私钥
- **会话密钥**：ECDH 协商派生，用于消息加解密
- **消息存储密钥**：AES-256-GCM，用于 IndexedDB 中消息的加密存储

### 4.5 数据库设计

**users 表**（用户身份，仅存公开信息）：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGINT UNSIGNED | 主键 |
| chat_id | CHAR(9) | 唯一 Chat ID（NNNN-AAAA 格式） |
| nickname | VARCHAR(64) | 昵称 |
| public_key | TEXT | ECDH 公钥（Base64 编码） |
| is_ready | TINYINT(1) | 注册状态（0=待上传公钥，1=完成注册） |
| created_at | DATETIME | 创建时间 |
| last_seen | DATETIME | 最后在线时间 |

**friend_requests 表**（好友申请）：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGINT UNSIGNED | 主键 |
| from_user_id | BIGINT UNSIGNED | 申请发起者 |
| to_user_id | BIGINT UNSIGNED | 申请接收者 |
| status | ENUM | 状态（pending/accepted/rejected） |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

**friendships 表**（好友关系，双向存储）：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGINT UNSIGNED | 主键 |
| user_id | BIGINT UNSIGNED | 用户 ID |
| friend_id | BIGINT UNSIGNED | 好友 ID |
| created_at | DATETIME | 创建时间 |

**message_reads 表**（消息已读回执）：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGINT UNSIGNED | 主键 |
| msg_id | VARCHAR(64) | 消息 ID |
| msg_from | CHAR(9) | 发送者 Chat ID |
| msg_to | CHAR(9) | 接收者 Chat ID |
| reader_chat_id | CHAR(9) | 已读者 Chat ID |
| read_at | DATETIME | 已读时间 |

**device_tokens 表**（设备推送 Token，用于极光离线推送）：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGINT UNSIGNED | 主键 |
| chat_id | CHAR(9) | 用户 Chat ID |
| reg_id | VARCHAR(255) | 极光 Registration ID（设备唯一推送 ID） |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

> 唯一键 `(chat_id, reg_id)`，同一账号可绑定多台设备；退出登录时删除该账号全部 Token。
>
> 数据库结构通过 `backend/migrations/` 下的 SQL 迁移文件（`001_init.sql`、`002_message_reads.sql`、`003_device_tokens.sql`）在服务启动时自动迁移。

---

## 5. 安全设计

### 5.1 通信安全

- 全链路 HTTPS/WSS 加密传输
- WebSocket 认证 Token 通过首条消息发送，不暴露在 URL 中
- CORS 严格限制允许的来源域名
- HSTS、X-Frame-Options、X-Content-Type-Options 安全头

### 5.2 数据安全

- **零知识架构**：服务器无法解密任何消息内容
- **私钥保护**：私钥使用设备密钥（AES-256-GCM, non-extractable）加密存储于 IndexedDB
- **安全码保护**：设置安全码后，私钥使用 PBKDF2 派生密钥二次加密
- **本地加密存储**：IndexedDB 中的消息使用独立密钥加密存储
- **阅后即焚**：被阅读后 2 小时自动从本地删除，收发双方各自副本均销毁，采用相对计时防篡改

### 5.3 认证安全

- JWT Token 认证机制
- 支持密钥签名重新认证（Re-auth）
- 401 自动清除本地会话状态
- 接口限流防护

### 5.4 防护机制

- 安全码防暴力破解（错误次数过多触发冷却期）
- 邀请码时效性验证
- Chat ID 格式严格校验
- 文件类型白名单限制（同时校验 MIME 类型与扩展名，两者满足其一即可）
- 文件大小限制（10MB）：前端发送前拦截（`MAX_FILE_SIZE`），后端收到 `file_offer` 时二次校验（`maxFileSize`），双层强制执行；WebSocket 单帧上限 256KB，文件以 128KB 分块传输，单文件最多 100 块

---

## 6. 部署架构

### 6.1 容器化部署

```
┌─────────────────────────────────────────────────┐
│                  Docker Compose                  │
│                                                  │
│  ┌──────────────────┐  ┌──────────────────────┐ │
│  │  e2eechat-backend │  │  e2eechat-frontend   │ │
│  │  (Go 服务)        │  │  (Nginx 静态托管)     │ │
│  │  Port: 8888      │  │  Port: 80            │ │
│  └──────────────────┘  └──────────────────────┘ │
│                                                  │
│  Network: e2eechat-net (连接外部 MySQL/Redis)     │
└─────────────────────────────────────────────────┘
```

### 6.2 外部依赖

| 服务 | 说明 |
|------|------|
| MySQL | 用户数据、好友关系、消息回执存储 |
| Redis | 会话缓存、WebSocket 状态管理 |
| TURN Server | WebRTC NAT 穿透（coturn，端口 3478） |
| Nginx | 反向代理、SSL 终止、WebSocket 升级 |
| JPush (极光推送) | Android 端离线消息推送（REST API，需配置 AppKey/MasterSecret） |

### 6.3 构建与部署

- **本地构建**：`build.sh` 脚本构建前后端 Docker 镜像并打包发布包
- **服务器部署**：`load.sh` 脚本加载镜像、初始化数据库、启动服务、配置 Nginx
- **SSL 配置**：TLS 1.2/1.3，强密码套件

---

## 7. 页面结构

| 页面 | 路由 | 说明 |
|------|------|------|
| 首页 | `/` | 产品介绍、核心能力展示、使用步骤引导 |
| 初始化页 | `/init` | 邀请码验证、身份创建、身份恢复 |
| 聊天列表 | `/chats` | 最近聊天记录、在线状态、未读计数 |
| 聊天页 | `/chat/:chatId` | 消息收发、文件传输、语音通话、阅后即焚 |
| 好友页 | `/friends` | 好友搜索、好友申请、好友列表 |
| 个人页 | `/profile` | 身份信息、邀请好友、私钥备份、安全码管理、账号注销、版本号与更新检查 |

---

## 8. API 接口概览

### 8.1 身份相关

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/identity/init` | 初始化身份（支持邀请码） |
| GET | `/api/identity/reauth/challenge` | 获取重新认证挑战 |
| POST | `/api/identity/reauth` | 密钥签名重新认证 |
| PUT | `/api/identity/pubkey` | 上传公钥 |
| GET | `/api/identity/me` | 获取当前用户信息 |
| DELETE | `/api/identity/logout` | 退出登录 |
| DELETE | `/api/identity/me` | 注销账号 |
| PUT | `/api/identity/nickname` | 修改昵称 |

### 8.2 好友相关

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/friends/request` | 发送好友申请 |
| GET | `/api/friends/requests` | 获取收到的好友申请 |
| GET | `/api/friends/outgoing` | 获取发出的好友申请 |
| PUT | `/api/friends/request/:id` | 处理好友申请 |
| GET | `/api/friends` | 获取好友列表 |
| GET | `/api/friends/:peerId/read-receipts` | 获取已读回执 |

### 8.3 用户搜索

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/users/search?id=NNNN-AAAA` | 按 Chat ID 搜索用户 |

### 8.4 邀请相关

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/invite/generate` | 生成邀请码 |
| GET | `/api/invite/validate?code=xxx` | 验证邀请码 |

### 8.5 通话相关

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/turn-credentials` | 获取 TURN 服务器凭证 |

### 8.6 设备推送

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/device/token` | 注册/更新设备极光 Registration ID |
| DELETE | `/api/device/token` | 退出登录时删除该账号所有设备 Token |

### 8.7 版本与更新

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/version` | 返回线上最新版本（`latest`/`min_supported`/`url`/`notes`），供前端对比提示更新 |

> 版本信息由 `docker-compose.yml` 的环境变量维护（`APP_LATEST_VERSION`/`APP_MIN_VERSION`/`APP_UPDATE_URL`/`APP_VERSION_NOTES`），发版时与前端 `package.json` 的 `version` 同步修改。前端构建时将自身版本号注入（`APP_VERSION`），在「我」页面展示并与该接口对比，提示「已是最新 / 有新版本」。

### 8.8 WebSocket

| 路径 | 说明 |
|------|------|
| `/ws` | WebSocket 连接（首条消息认证） |

**WebSocket 消息类型**：

| 类型 | 方向 | 说明 |
|------|------|------|
| auth | 客户端→服务端 | 认证消息（携带 Token） |
| auth_result | 服务端→客户端 | 认证结果 |
| message | 双向 | 加密消息传输 |
| status | 服务端→客户端 | 在线状态变更 |
| friend_request | 服务端→客户端 | 好友申请通知 |
| read / read_receipt | 双向 | 已读回执（接收方上报已读、服务端转发给发送方） |
| recall | 双向 | 消息撤回 |
| file_offer | 双向 | 文件发送邀请（携带分块数、加密参数、服务器时间戳） |
| file_chunk | 双向 | 文件分块数据 |
| file_accept / file_reject | 双向 | 接收方接受/拒绝文件 |
| file_complete | 双向 | 发送方分块发送完毕信号 |
| file_done | 双向 | 接收方收齐并解密成功的确认（回带服务器时间戳） |
| file_error | 双向 | 文件传输失败/超时通知 |
| call_offer | 双向 | 通话邀请（含 `media` 字段：audio/video） |
| call_answer | 双向 | 通话应答 |
| call_ice | 双向 | ICE 候选交换 |
| call_hangup | 双向 | 挂断通话 |

---

## 9. PWA 支持

云密支持 PWA（Progressive Web App），可像原生应用一样安装到桌面：

- **离线缓存**：通过 Service Worker 缓存静态资源
- **安装到桌面**：支持 Android Chrome 原生安装提示和 iOS Safari 手动添加
- **桌面通知**：支持浏览器推送通知
- **微信浏览器引导**：检测微信环境，引导用户使用外部浏览器打开
- **全屏模式**：standalone 显示模式，隐藏浏览器地址栏
- **无感更新**：发版后用户无需手动强刷即可获取最新版本，多层保障——
  - Nginx 对 `index.html` 与 Service Worker 设 `no-cache`（每次校验），对哈希命名的静态资源设长期强缓存（`immutable`）
  - 新 Service Worker 安装后 `skipWaiting + clientsClaim` 立即接管并清理旧缓存，检测到新版本时弹出「发现新版本，点击刷新」提示
  - 「我」页面对比线上版本（`/api/version`），落后时显示「有新版本」，浏览器端点击即自动清理缓存并刷新到最新

---

## 10. Electron 桌面客户端

云密同时提供 Electron 桌面客户端版本（Windows `.exe`）：

- 原生窗口体验
- 任务栏闪烁提醒（新消息）
- 窗口聚焦（点击通知时）
- 系统托盘集成
- 免邀请码直接注册

---

## 11. Android 原生客户端

云密基于 **Capacitor** 将 Web 应用封装为 Android 原生客户端（`.apk`），在 PWA 能力之上增强了原生推送与后台体验：

- **极光推送（JPush）**：集成 `cn.jpush` SDK，离线时也能收到新消息提醒，推送内容不含消息正文
- **设备 Token 上报**：登录后自动获取并上报极光 Registration ID 至后端（`/api/device/token`），Registration ID 变更时自动重新上报
- **通知点击跳转**：点击推送通知可冷启动或从后台唤起 App 并直达对应会话
- **前台/后台感知**：通过原生 `ChatService` 插件与前端 `visibilitychange`、`MainActivity` 生命周期协同维护前后台状态
- **通知权限申请**：适配 Android 13+ 运行时通知权限（`POST_NOTIFICATIONS`）
- **免邀请码直接注册**：原生端可直接创建身份
- **关键组件**：`MainActivity.java`（JPush 初始化）、`ChatServicePlugin.java`（Capacitor 桥接）、`JPushEventReceiver.java`（极光注册与通知点击回调）
- **构建方式**：通过 `frontend/build-android.cmd` / `build-android.sh` 构建 APK

### 客户端原生桥接接口（ChatService 插件）

| 方法 | 说明 |
|------|------|
| getRegistrationId | 获取极光 Registration ID |
| setForeground | 上报 App 前台/后台状态 |
| getPendingNotification | 获取待跳转的通知会话 |
| requestNotificationPermission | 申请系统通知权限 |
| addListener('registrationId') | 监听极光异步回调的新 Registration ID |

> Web / Electron 端对该插件提供空实现，不影响多端统一代码运行。

---

## 12. 使用流程

```
1. 准入注册
   ├─► Web 端：从已有用户获取邀请链接（邀请制）
   └─► Android / Electron 客户端：下载安装后免邀请码直接注册

2. 创建身份
   └─► 接受邀请 / 直接创建 → 系统生成 Chat ID 和加密密钥对 → 私钥本地封存

3. 添加好友
   └─► 搜索对方 Chat ID → 发送好友申请 → 对方接受

4. 私密沟通
   └─► 端到端加密聊天 → 文件传输 → 语音通话 → 阅后即焚

5. 安全管理
   └─► 设置安全码 → 备份私钥 → 管理锁定策略
```
