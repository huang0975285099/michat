# 云密（E2EE Chat）产品说明文档

> **云密**——只为隐私安全而生。基于端到端加密与零信任架构的私密应用，采用 ECDH P-256 密钥协商 + AES-256-GCM 加密，消息仅收发双方可解密，服务器零知识、零明文、零追踪。支持加密文字/文件传输、阅后即焚、1:1 音视频通话、安全码锁定与铁拳3D对战。Web / PWA / Electron 桌面端 / Android 原生端多端可用，离线消息通过极光推送实时提醒（推送不含任何消息正文）。

> **当前产品版本**：v1.0.8　｜　**文档更新时间**：2026-08-02

## 1. 产品概述

**云密**是一款基于端到端加密（End-to-End Encryption, E2EE）的私密应用，遵循“最小数据原则”设计理念，确保用户通信内容仅由通信双方掌控。服务器负责实时转发，并可在 Redis 中临时保存最多7天的离线密文与必要回执；服务器不持有私钥，不能解析任何可读通信内容。

- **产品名称**：云密
- **产品定位**：隐私安全工具
- **部署域名**：https://m.yzs88.com
- **支持平台**：Web 浏览器、PWA（可安装到桌面）、Electron 桌面客户端（Windows .exe）、Android 原生客户端（.apk）
- **客户端下载**：首页提供 Windows 桌面端（`yunChat.exe`）与 Android（`yunChat.apk`）下载，iOS 暂以 PWA 形式提供
- **当前游戏入口**：铁拳3D（1v1策略对战）

---

## 2. 核心能力

### 2.1 端到端安全加密（E2EE）

采用现代密码学协议实现全链路加密保护：

- **密钥协商**：ECDH P-256 椭圆曲线密钥交换，通信双方协商出共享会话密钥
- **消息加密**：AES-256-GCM 高强度对称加密，单条消息独立会话密钥
- **私钥管理**：私钥仅存储于用户本地设备（IndexedDB），使用设备密钥加密保护，永不上传服务器
- **前向安全**：动态会话密钥更新，强化前向安全防护

### 2.2 极简轻量化服务架构

- 服务器仅参与密文转发；离线时最多临时保存7天密文，不保存可读消息
- 不记录用户行为日志
- 最大限度缩小数据暴露范围

### 2.3 加密文件安全传输

- 支持图片、视频、文档、压缩包、APK 等多种文件类型
- 文件全程加密流转，传输与临时缓存全链路保护
- 文件分块传输（128KB/块），最大支持 10MB
- **可靠传输确认**：发送方在传输分块前即建立完成回执监听；接收端收齐并解密成功后回发 `file_done`，发送方据此才生成本地文件消息并标记成功，避免极速回执早到丢失造成“实际收到但发送端误报失败”
- **失败检测**：接收端设有传输停滞看门狗（30 秒无进展即失败），发送端最多等待120秒完成确认；缺块、解密失败、中途断线都会通过 `file_error` 明确反馈
- 文件采用实时 WebSocket 中继，发送时双方必须在线；文件分块不进入离线消息队列
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
| 文字消息 | 端到端加密文字聊天，支持表情发送、最长10000字符，并防止中文输入法确认候选词时误发送 |
| 发送状态 | 消息先显示“发送中”；服务器 ACK 后显示单勾，已读后显示双勾；15秒未获 ACK 或 WebSocket 写入失败时明确标记失败，不自动重发以避免重复消息 |
| 文件传输 | 加密文件传输，支持图片/视频预览和文件下载；含传输确认与失败检测，避免单边「假成功」 |
| 消息已读 | 已读/未读状态回执，双勾标识；回执持久化并在重连/重开会话时幂等补发，断网或刷新也不丢失 |
| 阅后即焚 | 开启后，被阅读 2 小时自动销毁，收发双方各自副本均删除 |
| 消息撤回 | 144小时（6天）内支持双方删除，超时仅支持为我删除 |
| 在线状态 | 实时显示好友在线/离线状态 |
| 消息通知 | 支持浏览器桌面通知，窗口失焦时自动推送；Android 端离线时通过极光推送提醒 |

### 3.5 音视频通话

- 基于 WebRTC 的端到端加密**语音 / 视频通话**（1:1），媒体流经 DTLS-SRTP 点对点加密
- 通过 TURN 服务器实现 NAT 穿透
- 语音：支持静音/取消静音
- 视频：全屏远端画面 + 本地小窗预览，支持开关摄像头、前后摄像头切换（移动端浏览器）
- 通话类型随呼叫信令传递，来电按“语音/视频”区分提示
- 每场通话使用独立 UUID `call_id`；Answer、ICE、挂断、拒接和重连信令必须同时匹配当前对端与 `call_id`，迟到或无关信令不会污染当前通话
- 忙线隔离：A与B通话时，C呼叫A会收到明确的 `busy`，A-B通话不受影响；同一双方同时互拨时按 `call_id` 确定性保留一场通话
- 呼叫30秒无应答自动结束；被叫来电35秒无人处理自动清理；媒体在应答后20秒仍未建立则结束并提示网络异常
- 网络恢复：媒体链路断开后进入10秒恢复窗口，音频条/视频窗口显示“网络中断，正在恢复（N秒）”，并通过原 `call_id` 执行 ICE Restart；10秒内恢复则继续原通话，超时则关闭通话UI并释放麦克风、摄像头和 PeerConnection
- 恢复机制适用于页面/App进程仍存活的瞬时断网；刷新页面、强制结束进程或断网超过10秒后需要重新拨打
- 通话计时从媒体真正进入 `connected` 后开始；短暂恢复期间保留原计时、静音和摄像头开关状态
- 麦克风或摄像头中途断开时自动结束通话并给出明确提示；摄像头切换失败会释放临时轨道，避免设备持续占用
- 通话前进行设备与权限检测，无可用麦克风/摄像头时给出明确提示
- 视频分辨率默认约束 720p 以控制带宽
- 全端可用：移动端通过 Safari / Chrome 浏览器即可使用（需 HTTPS 安全上下文）

### 3.6 铁拳3D

- 当前游戏中心提供的正式游戏入口，支持PVE、好友对战与PVP撮合
- 提供战绩、成就、比赛记录和 `$FIST` 账户/交易流水
- PVP采用房间与双方结果上报机制，异常超时场次由服务端定时清理并执行退款兜底
- 前端使用 Phaser/Babylon.js 呈现2D/3D战斗，游戏实时动作通过 WebSocket 同步

### 3.7 安全码锁定

| 功能 | 说明 |
|------|------|
| 安全码设置 | 设置 6 位数字安全码，防止他人查看聊天记录 |
| 自动锁定 | 支持自定义超时时间（10 分钟/30 分钟/1 小时/4 小时），超时自动锁定 |
| 手动锁定 | 支持立即锁定应用 |
| 防暴力破解 | 错误次数过多触发冷却期，防止暴力破解 |

### 3.8 版本管理与更新

「我」页面底部展示当前版本号与构建日期（构建时由 `package.json` 注入），并自动与后端 `/api/version` 返回的线上版本对比，给出三档提示：

| 状态 | 条件 | 表现 |
|------|------|------|
| 已是最新 | 当前版本 ≥ `latest` | 「✅ 已是最新版本」 |
| 可选更新 | `min_supported` ≤ 当前版本 < `latest` | 「🔔 有新版本，点击更新」软提示（可稍后） |
| 强制更新 | 当前版本 < `min_supported` | 全局不可关闭弹窗「需要更新」，阻断使用直至更新 |

- **一键更新**：浏览器/PWA 端点击更新会清理缓存 + 注销 Service Worker 后刷新，用户无需懂「强制刷新」；原生端（桌面/安卓）跳转下载页更新安装包
- **防死循环**：若强刷后版本仍未达标（新版本尚未部署或配置有误），同一会话内不再反复强制，避免把用户永久锁死
- **口径统一**：Service Worker 的「发现新版本」软提示与上述版本判定一致，同版本重新构建/部署不会误弹，强制更新场景只显示硬性弹窗
- **服务端配置**：线上版本信息由 `docker-compose.yml` 的环境变量维护（`APP_LATEST_VERSION` 提示更新、`APP_MIN_VERSION` 强制更新阈值、`APP_UPDATE_URL` 下载地址、`APP_VERSION_NOTES` 更新说明），发版时与前端 `package.json` 的版本号同步递增

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
| Phaser | 3.90+ | 2D游戏与战斗场景 |
| Babylon.js | 9.14+ | 铁拳3D角色与战斗渲染 |
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

**游戏与代币数据表**：

- `$FIST`：`fist_accounts`、`fist_transactions`、`pve_daily_progress`、`pvp_matches`、`pvp_rounds`
- 铁拳3D：`ironfist_stats`、`ironfist_achievements`、`ironfist_matches`、`ironfist_pvp_rooms`

> 数据库结构通过 `backend/migrations/` 下的 SQL 迁移文件在服务启动时自动迁移。

---

## 5. 安全设计

### 5.1 通信安全

- 全链路 HTTPS/WSS 加密传输
- WebSocket 认证 Token 通过首条消息发送，不暴露在 URL 中
- CORS 严格限制允许的来源域名
- HSTS、X-Frame-Options、X-Content-Type-Options 安全头

### 5.2 数据安全

- **零知识架构**：服务器无法解密任何消息内容
- **离线密文最小化**：离线消息仅以密文形式在 Redis 临时保存，TTL为7天；客户端上线投递后从离线队列移除
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
- 通话信令授权：服务端对 Offer 及后续 Answer/ICE/挂断/拒接/重连信令执行好友校验；客户端再按对端与 UUID `call_id` 绑定当前会话
- 通话信令隔离：旧通话或第三方发送的迟到 Answer、ICE、Hangup 不匹配当前 `call_id` 时直接丢弃

---

## 6. 部署架构

### 6.1 容器化部署

```
┌────────────────────────────────────────────────────┐
│                 Docker Compose                     │
│                                                    │
│  edge Nginx (:80/:443) ──> frontend ──> backend   │
│                                             │      │
│                                     MySQL + Redis  │
│                                                    │
│  coturn (:3478, UDP relay :49160-49200)            │
│  MySQL/Redis 仅在 Compose 私有网络内可达              │
└────────────────────────────────────────────────────┘
```

### 6.2 运行依赖

| 服务 | 说明 |
|------|------|
| MySQL | Compose 内置；用户数据、好友关系、消息回执存储 |
| Redis | Compose 内置；会话缓存、WebSocket 状态管理、最多7天离线密文队列 |
| TURN Server | Compose 内置 coturn；WebRTC NAT 穿透（3478 与 UDP 49160-49200） |
| Nginx | Compose 内置；反向代理、SSL 终止、WebSocket 升级（80/443） |
| JPush (极光推送) | Android 端离线消息推送（REST API，需配置 AppKey/MasterSecret） |

### 6.3 构建与部署

- **本地构建**：`build.sh` 脚本构建前后端 Docker 镜像并打包发布包
- **服务器部署**：`load.sh` 脚本加载镜像、校验 Compose/Nginx 配置并启动隔离的服务栈
- **SSL 配置**：TLS 1.2/1.3，强密码套件
- **部署说明**：参见 `docs/deploy-m-yzs88-com.md`

---

## 7. 页面结构

| 页面 | 路由 | 说明 |
|------|------|------|
| 首页 | `/` | 产品介绍、核心能力展示、使用步骤引导 |
| 初始化页 | `/init` | 邀请码验证、身份创建、身份恢复 |
| 聊天列表 | `/chats` | 最近聊天记录、在线状态、未读计数 |
| 聊天页 | `/chat/:chatId` | 消息收发、文件传输、1:1音视频通话、阅后即焚 |
| 好友页 | `/friends` | 好友搜索、好友申请、好友列表 |
| 游戏中心 | `/games` | 当前提供铁拳3D入口及后续游戏占位 |
| 铁拳3D | `/games/ironfist` | PVE、好友模式、PVP撮合、战绩、成就和 `$FIST` 账本 |
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
| DELETE | `/api/friends/request/:id` | 撤销已发出的好友申请 |
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

### 8.8 `$FIST` 账户

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/fist/stats` | 公开聚合统计，不返回个人敏感数据 |
| GET | `/api/fist/account` | 获取当前用户余额与账户信息 |
| POST | `/api/fist/pve-reward` | 领取符合条件的PVE奖励 |
| GET | `/api/fist/transactions` | 获取个人交易流水 |

### 8.9 铁拳3D

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/games/ironfist/stats` | 获取战绩和成就 |
| POST | `/api/games/ironfist/stats` | 上报比赛结果 |
| GET | `/api/games/ironfist/matches` | 获取比赛记录 |
| POST | `/api/games/ironfist/pvp/queue` | 加入PVP撮合队列 |
| GET | `/api/games/ironfist/pvp/queue` | 查询撮合状态 |
| DELETE | `/api/games/ironfist/pvp/queue` | 取消PVP撮合 |

### 8.10 WebSocket

| 路径 | 说明 |
|------|------|
| `/ws` | WebSocket 连接（首条消息认证） |

**WebSocket 消息类型**：

| 类型 | 方向 | 说明 |
|------|------|------|
| auth | 客户端→服务端 | 认证消息（携带 Token） |
| auth_result | 服务端→客户端 | 认证结果 |
| message | 双向 | 加密消息传输 |
| ack | 服务端→客户端 | 服务器接收文字消息后的确认与统一时间戳 |
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
| call_offer | 双向 | 通话邀请（含 UUID `call_id` 与 `media`：audio/video） |
| call_answer | 双向 | 绑定 `call_id` 的通话应答 |
| call_ice | 双向 | 绑定 `call_id` 的 ICE 候选交换 |
| call_hangup / call_reject | 双向 | 挂断、拒接、忙线、设备错误或超时通知 |
| call_restart_request | 双向 | 网络中断方请求原发起方执行 ICE Restart |
| call_restart_offer / call_restart_answer | 双向 | 10秒恢复窗口内的 ICE Restart SDP 协商 |
| ironfist_action | 双向 | 铁拳实时对战动作，服务端暂存供断线重放 |
| ironfist_reconnect / ironfist_replay | 双向 | 铁拳对战断线恢复请求与动作历史回放 |
| ironfist_lobby_join / ironfist_lobby_leave | 客户端→服务端 | 加入或离开PVP大厅在线列表 |

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
   └─► 端到端加密聊天 → 文件传输 → 1:1音视频通话 → 阅后即焚

5. 安全管理
   └─► 设置安全码 → 备份私钥 → 管理锁定策略

6. 娱乐对战（可选）
   └─► 进入游戏中心 → 铁拳3D → PVE / 好友对战 / PVP撮合 → 查看战绩与 `$FIST` 账本
```
