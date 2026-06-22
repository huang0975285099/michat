# 炸弹人对战游戏设计文档

## 1. 概述

在 MiChat 聊天 App 内嵌的 2 人实时对战 H5 小游戏。玩家可在聊天界面向好友发起挑战，双方进入同一局游戏，最后存活者获胜。

**技术栈：** Vue 3 + Phaser 3 + 现有 WebSocket 中继

---

## 2. 游戏规则

- 2 名玩家，各自从地图对角出发
- 在网格地图上自由移动，放置炸弹
- 炸弹 3 秒后爆炸，爆炸沿四个方向扩散（默认射程 2 格）
- 爆炸可炸毁**软墙**（可破坏方块），硬墙不可破坏
- 软墙被炸后有概率掉落**道具**
- 玩家被爆炸波及即死亡，最后存活者获胜
- 单局时间上限 3 分钟，超时双方平局

### 道具类型

| 道具 | 效果 |
|------|------|
| 🔥 火焰 | 爆炸射程 +1（最大 6） |
| 💣 炸弹 | 可携带炸弹数 +1（最大 5） |
| 👟 速度 | 移动速度提升 |

---

## 3. 地图设计

**尺寸：** 15 × 13 格（每格 48px）

```
H H H H H H H H H H H H H H H
H . . . . . . . . . . . . . H
H . H . H . H . H . H . H . H
H . . S S S S S S S S S . . H
H . H . H . H . H . H . H . H
H . S S S S S S S S S S S . H
H . H . H . H . H . H . H . H
H . S S S S S S S S S S S . H
H . H . H . H . H . H . H . H
H . . S S S S S S S S S . . H
H . H . H . H . H . H . H . H
H . . . . . . . . . . . . . H
H H H H H H H H H H H H H H H

H = 硬墙（不可破坏）
. = 安全空地（玩家出生区域附近保持空旷）
S = 软墙（可破坏，随机生成）
```

**出生点：**
- Player 1：(1, 1) 左上角
- Player 2：(13, 11) 右下角

**确定性生成：** 服务端/邀请方生成随机 seed，双端用同一 seed 生成完全一致的软墙分布，无需传输地图数据。

---

## 4. 多人同步架构

### 4.1 同步模型

采用**输入广播 + 双端独立模拟**：

- 每个客户端只向对方广播**自己的操作**（移动位置、放炸弹）
- 双端各自运行完整游戏逻辑（爆炸计算、死亡判断）
- 地图初始状态由同一 seed 决定，保证确定性一致
- 炸弹爆炸时间基于**服务器时间戳**对齐，消除时钟偏差

### 4.2 WebSocket 消息协议

所有游戏消息走现有 WebSocket 连接，后端纯中继（不计算游戏逻辑）。

#### 消息格式

```json
{ "type": "game_xxx", "payload": { ... } }
```

#### 消息类型

| type | 方向 | payload | 说明 |
|------|------|---------|------|
| `game_invite` | A→B | `{ to, game:"bomberman", room_id }` | 发起游戏邀请 |
| `game_accept` | B→A | `{ to, room_id, seed }` | 接受邀请，携带地图 seed |
| `game_reject` | B→A | `{ to, room_id }` | 拒绝邀请 |
| `game_ready`  | 双向 | `{ to, room_id }` | 双方加载完成，准备开始 |
| `game_move`   | 双向 | `{ to, room_id, x, y, dir, seq }` | 玩家移动（10次/秒） |
| `game_bomb`   | 双向 | `{ to, room_id, x, y, ts }` | 放置炸弹，ts 为服务器时间戳 |
| `game_powerup`| 双向 | `{ to, room_id, x, y, collected }` | 拾取道具（防止双端竞争） |
| `game_death`  | 双向 | `{ to, room_id }` | 自己死亡通知 |
| `game_resign` | 双向 | `{ to, room_id }` | 主动认输/离开 |

#### 移动消息频率控制

- 玩家静止时不发送
- 移动中每 100ms 发一次位置（10次/秒）
- 对端收到后平滑插值渲染

### 4.3 后端变更（hub.go）

在 `dispatch()` 的 `switch` 中新增：

```go
case "game_invite", "game_accept", "game_reject", "game_ready",
     "game_move", "game_bomb", "game_powerup", "game_death", "game_resign":
    h.handleGameRelay(c, msg.Type, msg.Payload)
```

新增 `handleGameRelay` 函数：验证 `to` 字段格式，校验好友关系（可选），直接中继给目标 chatID。

---

## 5. 前端架构

### 5.1 文件结构

```
src/
  pages/
    GamesPage.vue                  # 游戏大厅（游戏卡片列表）
  games/
    bomberman/
      BombermanPage.vue            # 路由页，管理邀请/等待/游戏状态
      game/
        BombermanGame.js           # Phaser.Game 工厂函数
        scenes/
          LoadScene.js             # 资源预加载
          GameScene.js             # 主游戏场景（核心逻辑）
          ResultScene.js           # 胜负结算场景
        entities/
          Player.js                # 玩家精灵：移动、动画、碰撞
          Bomb.js                  # 炸弹：倒计时、爆炸触发
          Explosion.js             # 爆炸波：扩散、伤害判定
          PowerUp.js               # 道具：类型、拾取
        MapGenerator.js            # 确定性地图生成（基于 seed）
        GameNet.js                 # WS 消息收发封装
        GameConstants.js           # 常量：格子大小、速度、时间等
  router/
    index.js                       # 新增 /games/bomberman 路由
```

### 5.2 Vue 页面状态机

```
BombermanPage.vue 内部状态：

idle         → 显示"挑战好友"按钮
inviting     → 等待对方响应（可取消）
invited      → 收到邀请弹窗（接受/拒绝）
loading      → Phaser 游戏加载中
playing      → 游戏进行中（Phaser 全屏）
result       → 胜负结算（再来一局/返回）
```

### 5.3 Phaser 与 Vue 通信

- Vue → Phaser：通过 `game.events.emit('xxx', data)` 传递网络消息
- Phaser → Vue：通过回调函数 `onGameEnd(result)` 通知结果
- Phaser 挂载到 Vue 模板中的 `<div id="bomberman-container">`

---

## 6. Phaser 游戏实现要点

### 6.1 GameScene 职责

1. **地图渲染**：用 Phaser TileMap 或 Graphics 绘制硬墙/软墙/地面
2. **玩家控制**：WASD/方向键移动，空格放炸弹；移动端虚拟摇杆
3. **网络同步**：接收对方位置更新，插值渲染对手位置
4. **炸弹系统**：本地放炸弹 → 广播 → 双端同时倒计时 → 同时爆炸
5. **碰撞检测**：玩家不能穿过墙体和炸弹
6. **死亡判定**：爆炸波与玩家重叠判定，发送 `game_death`

### 6.2 炸弹爆炸同步

```
放炸弹流程：
1. 本地立即显示炸弹（乐观渲染）
2. 发送 game_bomb { x, y, ts: Date.now() }
3. 对端收到后，根据 ts 计算剩余时间（3000 - (now - ts)）恢复倒计时
4. 双端在各自计时器触发时执行爆炸扩散
```

### 6.3 移动端适配

- 屏幕宽度 < 768px 时显示**虚拟摇杆**（左侧方向盘 + 右侧炸弹按钮）
- Phaser 画布自适应容器宽度（`scale: { mode: Phaser.Scale.FIT }`）

---

## 7. 视觉风格

- **像素风**（16-bit 复古风格），简洁清晰
- 色调参考：橙色/蓝色双方玩家，绿色草地背景
- 爆炸特效：橙色火焰 + 简单粒子效果（Phaser 内置）
- 不需要外部美术资源，使用 Phaser Graphics API 程序化绘制（纯色块 + 简单形状）即可 MVP

---

## 8. 开发阶段

### Phase 1：基础可玩（当前目标）
- [x] 文档设计
- [ ] 安装 Phaser 3
- [ ] 后端 game relay（hub.go）
- [ ] 前端路由 + GamesPage 入口
- [ ] 邀请/接受 UI 流程
- [ ] 地图生成 + 渲染
- [ ] 本地移动 + 网络同步
- [ ] 炸弹放置 + 爆炸
- [ ] 胜负判定 + 结算界面

### Phase 2：完善体验
- [ ] 道具系统
- [ ] 移动端虚拟摇杆
- [ ] 音效（Phaser 内置音频）
- [ ] 平滑插值（网络抖动补偿）
- [ ] 胜负战绩记录

### Phase 3：扩展
- [ ] 3-4 人房间
- [ ] 观战模式
- [ ] 地图编辑器
