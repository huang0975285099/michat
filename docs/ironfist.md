# 铁拳 - 回合制心理格斗小游戏

> MVP 设计文档（含数值平衡与技术方案）

---

## 一、游戏概述

**铁拳**是一款 **1v1 回合制心理博弈格斗游戏**，集成于云密（E2EE Chat）应用的游戏中心。

两位好友通过邀请对战后，在同一战场中通过"攻击 / 防御 / 蓄力 / 反击"四种基础动作进行对抗。每回合有 **30 秒决策时间**，双方同时选择动作后进行结算，循环直到一方 HP 归零。

核心体验：

> 猜测对手行为 + 做出策略选择 + 争取一回合优势

---

## 二、核心玩法循环

```
进入回合 → 30秒倒计时 → 双方选择动作 → 锁定 → 结算 → 更新状态 → 下一回合
```

循环直到一方 HP ≤ 0。

---

## 三、游戏状态机

```
                    ┌──────────────────────────────────────┐
                    │                                      │
                    ▼                                      │
  ┌──────┐   invite   ┌──────────┐   accept   ┌─────────┐ │
  │ idle │ ─────────► │ inviting │ ─────────► │ playing │ │
  └──┬───┘            └────┬─────┘            └────┬────┘ │
     │                     │                       │      │
     │  invite             │ reject/timeout        │      │
     ▼                     ▼                       ▼      │
  ┌──────────┐        ┌───────┐              ┌────────┐  │
  │ invited  │ ──────►│ idle  │              │ result │  │
  └──────────┘ reject └───────┘              └───┬────┘  │
                                              │         │
                                              ▼         │
                                         ┌────────┐      │
                                         │ lobby  │ ◄────┘
                                         └────────┘  backToLobby
```

**状态说明：**

| 状态 | 说明 |
|------|------|
| `idle` | 空闲，可发起或接受邀请 |
| `inviting` | 已发出邀请，等待对方接受（30 秒超时自动取消） |
| `invited` | 收到邀请，可接受或拒绝 |
| `playing` | 对战进行中 |
| `result` | 对战结束，展示胜负结果 |

**战斗子状态（playing 内部）：**

```
round_start → deciding（30秒倒计时）→ locked → resolving → waiting_confirm → round_end → round_start / game_over
```

| 子状态 | 说明 |
|--------|------|
| `round_start` | 回合开始，显示回合数，重置倒计时 |
| `deciding` | 双方选择动作，30 秒倒计时 |
| `locked` | 双方动作已锁定，不可更改（一方选完等另一方） |
| `resolving` | 结算克制关系、计算伤害、播放动画 |
| `waiting_confirm` | 结算动画播放完毕，等待玩家点击"下一回合"确认 |
| `round_end` | 更新 HP，检查胜负条件 |

---

## 四、基础数值系统

### 1. 玩家基础属性

| 属性 | 值 | 说明 |
|------|----|------|
| HP | 100 | 生命值，归零则败 |
| 攻击力 | 10 | 影响攻击伤害 |
| 防御值 | 0 | MVP 不做数值防御，全部由动作系统控制 |
| 气值（Energy） | 0 | MVP 可选，后续扩展用 |

### 2. 数值平衡原则

- 单次有效伤害 ≤ 25% HP（避免秒杀）
- 防御减伤 60%，但不完全免伤（避免防御拖平局）
- 蓄力成功 = 爆发，被抓 = 惩罚更重（高风险高收益）
- 反击成功很赚，失败会亏血（不稳定但高收益）
- 目标战斗长度 5~8 回合
- 无单一最优策略

---

## 五、动作系统与数值设计

### 1. 攻击（Attack）

| 场景 | 伤害 | 说明 |
|------|------|------|
| 攻击 vs 防御 | 12 × 0.4 = **5** | 防御减伤 60% |
| 攻击 vs 攻击 | 双方各受 **12** | 风险对拼 |
| 攻击 vs 蓄力 | **12** | 打断蓄力 |
| 攻击 vs 反击 | 攻击方受 **18** | 被反击克制 |

特点：简单直接，容易被预测

### 2. 防御（Defend）

| 场景 | 效果 | 说明 |
|------|------|------|
| 防御 vs 攻击 | 受到 12 × 0.4 = **5** 伤害 | 减伤 60% |
| 防御 vs 防御 | 无伤害 | 双方安全但无进展 |
| 防御 vs 蓄力 | 对方蓄力成功 | 亏节奏 |
| 防御 vs 反击 | 对方反击失败受 **8** 伤害 | 对方猜错 |

特点：抗压，克制攻击，但牺牲进攻节奏

### 3. 蓄力（Charge）

| 场景 | 效果 | 说明 |
|------|------|------|
| 蓄力 vs 攻击 | 自身受 **18** 伤害，蓄力失败 | 被打断，额外惩罚（12 × 1.5） |
| 蓄力 vs 防御 | 蓄力成功，下回合伤害 ×2 | 对方亏节奏 |
| 蓄力 vs 蓄力 | 双方蓄力成功 | 下回合双方爆发 |
| 蓄力 vs 反击 | 蓄力成功，对方反击失败受 **8** 伤害 | 对方猜错 |

蓄力成功后下一回合攻击伤害 = 12 × 2 = **24**（单回合伤害上限）

**蓄力状态持续规则**：蓄力成功后，蓄力标记一直保留，直到玩家选择攻击时才消耗并清除。如果蓄力后选择防御/反击，蓄力标记不消失，继续保留到下一次攻击。

特点：高风险高收益，容易被读穿

### 4. 反击（Counter）

| 场景 | 效果 | 说明 |
|------|------|------|
| 反击 vs 攻击 | 反击成功，造成 **20** 伤害 | 核心博弈技能 |
| 反击 vs 防御 | 反击失败，自身受 **8** 伤害 | 猜错 |
| 反击 vs 蓄力 | 反击失败，自身受 **8** 伤害 | 猜错 |
| 反击 vs 反击 | 双方反击失败，各受 **8** 伤害 | 互相猜忌 |

特点：心理博弈核心，成功收益高，失败代价大

---

## 六、克制关系总表

| 玩家动作 | 对手动作 | 玩家受到 | 对手受到 | 判定 |
|----------|----------|----------|----------|------|
| 攻击 | 攻击 | 12 | 12 | 互伤 |
| 攻击 | 防御 | 0 | 5 | 防御减伤 |
| 攻击 | 蓄力 | 0 | 12 | 打断蓄力 |
| 攻击 | 反击 | 18 | 0 | 被反击 |
| 防御 | 攻击 | 5 | 0 | 成功防御 |
| 防御 | 防御 | 0 | 0 | 无事发生 |
| 防御 | 蓄力 | 0 | 0 | 对方蓄力成功 |
| 防御 | 反击 | 0 | 8 | 对方猜错 |
| 蓄力 | 攻击 | 18 | 0 | 蓄力被打断 |
| 蓄力 | 防御 | 0 | 0 | 蓄力成功 |
| 蓄力 | 蓄力 | 0 | 0 | 双方蓄力 |
| 蓄力 | 反击 | 0 | 8 | 对方猜错 |
| 反击 | 攻击 | 0 | 20 | 反击成功 |
| 反击 | 防御 | 8 | 0 | 反击失败 |
| 反击 | 蓄力 | 8 | 0 | 反击失败 |
| 反击 | 反击 | 8 | 8 | 双方失败 |

---

## 七、战斗结算流程

### Step 1：锁定动作

- 双方在 30 秒内选择动作
- 超时未选择 → 自动执行"攻击"
- 双方动作同时确定，互不可见（自己只能看到自己的选择，对方的选择在结算时才揭示）

### Step 2：克制判定

- 根据克制关系总表判断优劣
- 确定伤害方向和倍率

### Step 3：伤害计算

```
基础攻击伤害 = 12
防御减伤 = 60%（最终伤害 = 基础伤害 × 0.4）
蓄力加成 = 下回合伤害 × 2
蓄力被打断惩罚 = 基础伤害 × 1.5 = 18
反击成功伤害 = 20
反击失败自伤 = 8
```

### Step 4：状态更新

- HP 变化
- 蓄力状态更新：
  - 本回合蓄力成功（选择蓄力且未被打断）→ 设置蓄力标记
  - 本回合选择攻击且已有蓄力标记 → 消耗蓄力标记，伤害 ×2
  - 本回合选择防御/反击且已有蓄力标记 → 蓄力标记保留，不消耗

### Step 5：回合结束

- 更新血条
- 播放伤害动画
- 检查胜负条件
- 重置倒计时，进入下一回合

---

## 八、30 秒回合机制

- 每回合固定 30 秒决策时间
- 玩家必须在时间内选择动作
- 超时未选择 → 自动执行"攻击"
- 双方都选择后立即进入结算（不必等满 30 秒）

目的：
- 强制决策压力
- 防止无限思考
- 保持游戏节奏紧凑

---

## 九、胜负条件

```
当任意一方 HP ≤ 0
→ 游戏结束
→ 判定胜利/失败
```

- 胜利方展示胜利动画
- 失败方展示失败动画
- 双方 HP 同时归零 → 平局

---

## 十、轻量随机性（可选，增强体验）

| 系统 | 规则 | 说明 |
|------|------|------|
| 暴击 | 10% 概率 ×1.5 伤害 | 增加不确定性 |
| 残血强化 | HP < 30 → 攻击 +10% | 增加翻盘可能 |

MVP 阶段可不实现，后续根据体验数据决定。

---

## 十一、NPC AI（MVP 版本）

NPC 行为为概率模型：

| 动作 | 概率 |
|------|------|
| 攻击 | 50% |
| 防御 | 25% |
| 蓄力 | 15% |
| 反击 | 10% |

说明：
- 不做复杂预测
- 保持"可读但不完全可预测"
- 后续可升级为基于玩家行为历史的简单预测模型

---

## 十二、UI 设计（手机竖屏优先）

### 设计理念

不照搬《拳皇》的左右站位，而是采用 **竖屏 + 上下对战 + 大按钮决策**，既符合手机操作习惯，又能突出策略博弈。

目标体验：**看起来像格斗游戏，玩起来是心理博弈策略游戏。**

参考方向：
- Marvel Snap 的竖屏交互体验
- Slay the Spire 的信息清晰度
- Shadow Fight 3 的角色表现

---

### 战斗主界面（MVP）

```
┌─────────────────────┐
│ 第3回合        ⏳22s │  ← 顶部信息栏（10%）
├─────────────────────┤
│                     │
│      🤖 NPC         │
│                     │  ← NPC 区域（25%）
│ HP ███████░░░ 72/100│
│                     │
│ 状态：蓄力中⚡       │
│                     │
├─────────────────────┤
│                     │
│      ⚔️ VS          │
│                     │  ← 战斗信息区（20%）
│  上回合：           │
│  你：攻击           │
│  NPC：防御          │
│                     │
│  造成伤害：5        │
│                     │
├─────────────────────┤
│                     │
│      🧑 玩家         │
│                     │  ← 玩家区域（25%）
│ HP █████████░ 85/100│
│                     │
│ 状态：正常          │
│                     │
├─────────────────────┤
│ [攻击]   [防御]      │
│                     │  ← 操作区（20%）
│ [蓄力]   [反击]      │
│                     │
└─────────────────────┘
```

**屏幕高度按比例分配：**

| 区域 | 比例 | 内容 |
|------|------|------|
| 顶部信息栏 | 10% | 回合数 + 倒计时 |
| NPC 区域 | 25% | 角色 + HP + 当前状态 |
| 战斗信息区 | 20% | 上回合结果 + 伤害数字 |
| 玩家区域 | 25% | 角色 + HP + 当前状态 |
| 操作区 | 20% | 四个动作按钮 |

这样在 iPhone / Android / 平板上都容易适配。

---

### 动作按钮设计

```
┌──────────┐  ┌──────────┐
│    ⚔️     │  │    🛡️     │
│   攻击    │  │   防御    │
│  12伤害   │  │ 减伤60%  │
└──────────┘  └──────────┘
┌──────────┐  ┌──────────┐
│    ⚡     │  │    🔄     │
│   蓄力    │  │   反击    │
│ 下回合x2  │  │ 克制攻击  │
└──────────┘  └──────────┘
```

- 2×2 网格布局，大按钮易点击
- 每个按钮显示：图标 + 动作名 + 简要效果
- 选中后高亮，不可重复点击

---

### 回合锁定状态

玩家选择动作后，进入等待状态：

```
┌─────────────────────┐
│      已选择：攻击    │
│                     │
│   等待对手决策...    │
│                     │
│   对方剩余 ⏳18s    │
└─────────────────────┘
```

- 显示已选择的动作（仅自己可见，对方看不到）
- 等待对方选择完成
- 显示对方剩余决策时间（非自己倒计时）

---

### 回合结算动画

双方动作都确定后，展示结算动画：

```
┌─────────────────────┐
│      回合结算        │
├─────────────────────┤
│                     │
│ ⚔️ 你攻击成功        │
│                     │
│ 🤖 NPC蓄力被打断     │
│                     │
│ 造成18伤害          │
│                     │
│ HP:72→54            │
│                     │
│ [下一回合]          │
└─────────────────────┘
```

- 显示双方动作
- 显示克制关系判定结果
- 显示伤害数字和 HP 变化
- "下一回合" 按钮进入下一轮

---

### 第二版视觉升级方向（非 MVP）

MVP 跑通后，可升级为更像格斗游戏的视觉风格：

```
┌─────────────────────┐
│ ⏳22s      Round 3  │
├─────────────────────┤
│                     │
│       🤖            │
│    ██████░░░        │
│                     │
│                     │
│                     │
│       ⚔️            │
│                     │
│                     │
│                     │
│    ████████░        │
│       🧑            │
│                     │
├─────────────────────┤
│ ⚔️  🛡️  ⚡  🔄      │
└─────────────────────┘
```

类似《炉石传说》的信息布局 + 格斗游戏的视觉风格，但本质仍然是策略博弈。

---

### MVP 必须显示的信息

| 位置 | 信息 |
|------|------|
| 顶部 | 回合数、倒计时 |
| NPC 区域 | HP、当前状态 |
| 玩家区域 | HP、当前状态 |
| 中央 | 上回合结果、伤害数字 |
| 底部 | 四个动作按钮 |

### MVP 不做的事

先不要加：摇杆、技能树、装备栏、背包、商城、聊天、世界地图。先把 **攻击 / 防御 / 蓄力 / 反击** 这一套玩得有意思。

---

### 动画效果

| 场景 | 动画 |
|------|------|
| 攻击 | 角色前冲 + 伤害数字弹出 |
| 防御 | 角色举盾 + 护盾特效 |
| 蓄力 | 角色发光 + 能量聚集特效 |
| 反击成功 | 角色闪避 + 反击特效 |
| 反击失败 | 角色踉跄 + 失误提示 |
| HP 减少 | 血条平滑减少 + 伤害数字 |
| 蓄力被打断 | 角色硬直 + 打断提示 |
| 胜利 | 角色胜利姿势 + 金色特效 |
| 失败 | 角色倒地 + 灰色特效 |

---

## 十三、技术方案

### 1. 整体架构

沿用现有炸弹人游戏的架构模式：前端 Vue 3 + Quasar 页面驱动，WebSocket 信令中继，无服务端游戏逻辑。

```
  玩家A (前端)                    玩家B (前端)
  ┌──────────┐   WebSocket   ┌──────────┐
  │ IronFist │ ◄───────────► │ IronFist │
  │  Page    │    中继转发     │  Page    │
  └──────────┘               └──────────┘
        │                          │
        ▼                          ▼
  本地游戏逻辑               本地游戏逻辑
  (状态机 + 结算)            (状态机 + 结算)
```

**关键设计：服务端仅做消息中继，不做游戏逻辑运算。** 双方各自在本地维护完整的游戏状态，通过确定性同步保证一致性。

### 2. 确定性同步

由于回合制游戏的天然确定性（无实时操作、无随机地图），同步方案比炸弹人更简单：

- **回合同步**：双方各自选择动作后发送给对方，收到对方动作后本地结算
- **无随机性**：MVP 阶段无暴击等随机系统，结算结果完全由双方动作决定
- **无需 seed**：不像炸弹人需要共享随机种子
- **防作弊**：MVP 阶段信任客户端，后续可加服务端校验

### 3. 文件结构

```
frontend/src/games/ironfist/
├── IronFistPage.vue          # 游戏主页面（大厅/邀请/对战/结果）
└── game/
    ├── IronFistGame.js        # 游戏核心逻辑（状态机、结算、AI）
    ├── GameConstants.js      # 常量定义（HP、伤害、时间等）
    ├── GameNet.js             # 网络通信（复用 bomberman 的 GameNet 模式）
    └── animations.js          # 动画控制（CSS 动画 / 简单 Canvas）
```

### 4. 路由注册

在 `frontend/src/router/index.js` 中添加：

```js
{ path: 'games/ironfist', component: () => import('src/games/ironfist/IronFistPage.vue') }
```

### 5. 游戏中心入口

在 `frontend/src/pages/GamesPage.vue` 中添加铁拳卡片：

```vue
<div class="col-6 col-sm-4 col-md-3">
  <q-card class="game-card cursor-pointer" @click="router.push('/games/ironfist')">
    <q-card-section class="text-center q-pa-lg">
      <div style="font-size: 52px">🥊</div>
      <div class="text-subtitle1 text-bold q-mt-sm">铁拳</div>
      <div class="text-caption text-grey-6">回合制心理博弈</div>
    </q-card-section>
    <q-separator />
    <q-card-actions align="center" class="q-py-sm">
      <q-chip dense color="positive" text-color="white" icon="people" label="1v1" />
      <q-chip dense color="purple" text-color="white" icon="psychology" label="策略" />
    </q-card-actions>
  </q-card>
</div>
```

### 6. GameStore 扩展

现有 `useGameStore` 已支持邀请/接受/拒绝流程，铁拳游戏复用同一套邀请机制，仅需在 `invite()` 中将 `game` 字段改为 `'ironfist'`，并在路由跳转时指向 `/games/ironfist`。

```js
// 发送邀请时指定游戏类型
send('game_invite', { to: chatId, game: 'ironfist', room_id: roomId.value })

// 接受邀请后跳转到铁拳页面
_router?.push({
  path: '/games/ironfist',
  query: { opponent: opponentId.value, room: roomId.value, role: 'guest' },
})
```

---

## 十四、WebSocket 协议

### 邀请阶段（复用现有协议）

| 方向 | 类型 | Payload | 说明 |
|------|------|---------|------|
| 发起方 → 服务端 | `game_invite` | `{ to, game: 'ironfist', room_id }` | 发起对战邀请 |
| 服务端 → 接收方 | `game_invite` | `{ from, game: 'ironfist', room_id }` | 转发邀请 |
| 接收方 → 服务端 | `game_accept` | `{ to, room_id }` | 接受邀请 |
| 服务端 → 发起方 | `game_accept` | `{ from, room_id }` | 通知发起方 |
| 任意方 → 服务端 | `game_reject` | `{ to, room_id, reason? }` | 拒绝/取消 |

### 对战阶段（铁拳专用）

| 方向 | 类型 | Payload | 说明 |
|------|------|---------|------|
| 双方 → 对方 | `ironfist_action` | `{ room_id, round, action, ts }` | 提交本回合动作 |
| 双方 → 对方 | `ironfist_ready` | `{ room_id, round }` | 确认已准备好（可选） |
| 任意方 → 对方 | `game_resign` | `{ room_id }` | 认输 |

**`ironfist_action` 详细定义：**

```js
{
  type: 'ironfist_action',
  payload: {
    room_id: 'abc123',        // 房间 ID
    round: 3,                 // 回合数（从 1 开始）
    action: 'attack',         // 动作：attack / defend / charge / counter
    ts: 1719123456789,        // 时间戳
  }
}
```

**结算流程：**

1. 双方各自选择动作后发送 `ironfist_action`
2. 收到对方动作后，本地执行结算（无需等服务端）
3. 播放动画，更新 HP
4. 检查胜负，若继续则进入下一回合

**超时处理：**

- 本地 30 秒倒计时结束未选择 → 自动发送 `action: 'attack'`
- 对方 30 秒内未收到动作 → 视为对方选择"攻击"

---

## 十五、核心代码设计

### 1. 游戏状态机（IronFistGame.js）

```js
// 游戏阶段
const PHASE = {
  ROUND_START: 'round_start',       // 回合开始
  DECIDING: 'deciding',             // 选择动作（30秒倒计时）
  LOCKED: 'locked',                 // 动作锁定（一方选完等另一方）
  RESOLVING: 'resolving',           // 结算动画
  WAITING_CONFIRM: 'waiting_confirm', // 等待玩家确认结算结果
  ROUND_END: 'round_end',           // 回合结束
  GAME_OVER: 'game_over',           // 游戏结束
}

// 动作类型
const ACTION = {
  ATTACK: 'attack',
  DEFEND: 'defend',
  CHARGE: 'charge',
  COUNTER: 'counter',
}
```

### 2. 结算逻辑

```js
// 伤害表：[玩家动作][对手动作] = { playerDmg, opponentDmg }
// 注意：蓄力成功的 ×2 加成不在此表中，由 resolveRound() 额外计算
const DAMAGE_TABLE = {
  attack: {
    attack:   { playerDmg: 12, opponentDmg: 12 },
    defend:   { playerDmg: 0,  opponentDmg: 5  },   // 防御减伤 60%
    charge:   { playerDmg: 0,  opponentDmg: 12 },    // 打断蓄力
    counter:  { playerDmg: 18, opponentDmg: 0  },     // 被反击
  },
  defend: {
    attack:   { playerDmg: 5,  opponentDmg: 0  },    // 成功防御
    defend:   { playerDmg: 0,  opponentDmg: 0  },
    charge:   { playerDmg: 0,  opponentDmg: 0  },     // 对方蓄力成功，下回合对方攻击 ×2
    counter:  { playerDmg: 0,  opponentDmg: 8  },     // 对方反击失败
  },
  charge: {
    attack:   { playerDmg: 18, opponentDmg: 0  },     // 蓄力被打断（12×1.5）
    defend:   { playerDmg: 0,  opponentDmg: 0  },     // 蓄力成功，下回合攻击 ×2
    charge:   { playerDmg: 0,  opponentDmg: 0  },     // 双方蓄力成功，下回合双方攻击 ×2
    counter:  { playerDmg: 0,  opponentDmg: 8  },     // 对方反击失败，自身蓄力成功
  },
  counter: {
    attack:   { playerDmg: 0,  opponentDmg: 20 },     // 反击成功
    defend:   { playerDmg: 8,  opponentDmg: 0  },     // 反击失败
    charge:   { playerDmg: 8,  opponentDmg: 0  },     // 反击失败
    counter:  { playerDmg: 8,  opponentDmg: 8  },     // 双方反击失败
  },
}
```

### 3. 蓄力状态处理

```js
// 蓄力成功后，下一回合攻击伤害 ×2
// 蓄力标记持续保留，直到玩家选择攻击时才消耗
function resolveRound(playerAction, opponentAction, playerCharged, opponentCharged) {
  let result = { ...DAMAGE_TABLE[playerAction][opponentAction] }

  // 蓄力加成：如果已有蓄力标记且本回合选择攻击，伤害 ×2，并消耗蓄力标记
  if (playerCharged && playerAction === 'attack') {
    result.opponentDmg *= 2
  }
  if (opponentCharged && opponentAction === 'attack') {
    result.playerDmg *= 2
  }

  // 蓄力状态更新：
  // - 本回合蓄力成功（选择蓄力且未被打断）→ 设置蓄力标记
  // - 本回合选择攻击且已有蓄力标记 → 消耗蓄力标记（设为 false）
  // - 本回合选择防御/反击且已有蓄力标记 → 保留蓄力标记
  // - 本回合蓄力被打断 → 不设置蓄力标记
  let newPlayerCharged = playerCharged  // 默认保留
  if (playerAction === 'charge' && result.playerDmg === 0) {
    newPlayerCharged = true              // 蓄力成功
  } else if (playerAction === 'attack' && playerCharged) {
    newPlayerCharged = false             // 消耗蓄力标记
  } else if (playerAction === 'charge' && result.playerDmg > 0) {
    newPlayerCharged = false             // 蓄力被打断
  }

  let newOpponentCharged = opponentCharged
  if (opponentAction === 'charge' && result.opponentDmg === 0) {
    newOpponentCharged = true
  } else if (opponentAction === 'attack' && opponentCharged) {
    newOpponentCharged = false
  } else if (opponentAction === 'charge' && result.opponentDmg > 0) {
    newOpponentCharged = false
  }

  return { ...result, playerCharged: newPlayerCharged, opponentCharged: newOpponentCharged }
}
```

---

## 十六、页面视图设计

IronFistPage.vue 包含 4 个视图，与 BombermanPage.vue 结构一致：

| 视图 | 条件 | 说明 |
|------|------|------|
| `lobby` | 默认 | 大厅：选择在线好友发起对战 |
| `inviting` | `gameStore.state === 'inviting'` | 等待对方接受邀请 |
| `playing` | `route.query.role` 存在 | 对战进行中 |
| `result` | 对战结束 | 展示胜负结果 |

### 大厅视图

- 游戏规则说明（4 种动作 + 克制关系简表）
- 在线好友列表（复用 `friendApi.getFriends()`）
- 点击好友 → 调用 `gameStore.invite()` 发起邀请

### 对战视图

- 上方：对手信息（昵称 + HP 血条 + 蓄力状态）
- 中间：战斗动画区域（CSS 动画实现，无需游戏引擎）
- 下方：玩家信息 + 倒计时 + 4 个动作按钮

### 结果视图

- 胜/负/平局图标和文字
- "返回大厅" 按钮

---

## 十七、后端改动

### 1. Hub 消息中继

在 `backend/internal/ws/hub.go` 的 `dispatch` 方法中，`game_*` 类型已统一走 `handleGameRelay`，铁拳的 `ironfist_action` 消息需要新增处理：

```go
case "ironfist_action", "ironfist_ready":
    h.handleGameRelay(c, msg.Type, msg.Payload)
```

### 2. 无需新增数据库表

回合制游戏无持久化数据需求，所有游戏状态在前端维护。

---

## 十八、MVP 设计目标

这个版本只追求三点：

### 1. 可玩
- 能完整对战
- 有胜负

### 2. 有心理博弈
- 玩家需要猜对手行为
- 四种动作各有克制关系

### 3. 有基本策略
- 防御 / 攻击 / 蓄力 / 反击之间有选择权
- 无单一最优策略

---

## 十九、后续扩展方向（非 MVP）

| 方向 | 说明 |
|------|------|
| 状态系统 | 眩晕 / 破防 / 强化 |
| 连击系统 | 连续相同动作触发额外效果 |
| 技能系统 | 替换/增强基础动作 |
| NPC AI 学习 | 基于玩家行为历史调整概率 |
| 角色职业 | 不同角色有不同属性/技能 |
| 装备系统 | 影响属性和技能 |
| 暴击系统 | 10% 概率 ×1.5 伤害 |
| 残血强化 | HP < 30 → 攻击 +10% |
| 气值系统 | 防御/反击消耗气值，攻击/蓄力回复气值 |
| 排行榜 | 胜率统计与排名 |
| 回放系统 | 记录对战过程供复盘 |

---

## 二十、总结

本 MVP 的核心：

> 用最少的 4 种动作 + 克制关系 + 风险收益设计 + 时间压力
> 构建一个轻量但具有心理博弈深度的回合制格斗系统

技术层面：

> 复用现有游戏邀请/通信架构，前端本地结算，服务端仅做消息中继
> 无需游戏引擎，CSS 动画即可满足表现需求