# 铁拳 - 回合制心理格斗小游戏

> MVP 设计文档（含数值平衡与技术方案）

---

## 一、游戏概述

**铁拳**是一款 **1v1 回合制心理博弈格斗游戏**，集成于云密（E2EE Chat）应用的游戏中心。

支持两种对战模式：

| 模式 | 说明 | 网络 |
|------|------|------|
| **PvP 人人对战** | 邀请在线好友进行对战，通过 WebSocket 实时同步 | 需要联网 |
| **PvE 人机对战** | 与本地 AI 对战，无需联网，随时可玩 | 纯本地 |

两种模式下，玩家通过"攻击 / 防御 / 蓄力 / 反击"四种基础动作进行对抗。每回合有 **30 秒决策时间**，双方同时选择动作后进行结算，循环直到一方 HP 归零。

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

### PvP 人人对战

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

### PvE 人机对战

```
  ┌──────┐   点击人机对战   ┌─────────┐   HP≤0   ┌────────┐
  │ idle │ ──────────────► │ playing │ ───────► │ result │
  └──────┘                  └─────────┘          └───┬────┘
                                                  │
                                                  ▼
                                             ┌────────┐
                                             │ lobby  │
                                             └────────┘
```

PvE 模式跳过邀请流程，直接从 `idle` 进入 `playing`。

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

- 满血不会被一击秒杀（常规蓄力攻击 24 ≈ 1/4 血）；残局互秒由残血护盾兜底（见第十节），不再用固定百分比上限描述
- 防御减伤 60%，但不完全免伤（避免防御拖平局）
- 蓄力成功 = 爆发，被抓 = 惩罚更重（高风险高收益）
- 反击成功很赚，失败会亏血（不稳定但高收益）
- 目标战斗长度 5~8 回合
- 无单一最优策略

**伤害取整规则**：所有伤害计算结果向上取整（`Math.ceil`），避免小数伤害。
例：`Math.ceil(12 × 0.4) = Math.ceil(4.8) = 5`

**乘区运算顺序**（必须严格按此顺序计算，避免歧义）：

```
最终伤害 = Math.ceil(
  基础伤害
  × 蓄力倍率（蓄力攻击时为 2，否则为 1）
  × 残血强化倍率（攻击方 HP < 30 时为 1.1，否则为 1）
  × 暴击倍率（10% 概率为 1.5，否则为 1）
  × 防御减伤系数（被防御时为 0.4，否则为 1）
)
```

> 注意：防御减伤在最后一步，意味着蓄力攻击打防御者 = `Math.ceil(12 × 2 × 0.4) = Math.ceil(9.6) = 10`。

---

## 五、动作系统与数值设计

### 1. 攻击（Attack）

| 场景 | 伤害 | 说明 |
|------|------|------|
| 攻击 vs 防御 | 12 × 0.4 = **5** | 防御减伤 60% |
| 攻击 vs 攻击 | 双方各受 **12** | 风险对拼 |
| 攻击 vs 蓄力 | **18** | 打断蓄力（与"蓄力被打断惩罚 18"对称，见 §7） |
| 攻击 vs 反击 | 攻击方受 **20** | 被反击克制（与"反击成功 20"对称） |

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

蓄力成功后攻击伤害 = 12 × 2 = **24**（常规单回合爆发值）

**蓄力状态持续与失效规则**（统一原 174/176 行矛盾）：

- 蓄力成功后设置蓄力标记，**最多保留 2 个"可用回合"**（常量 `CHARGE_HOLD_LIMIT = 2`）。
- "可用回合"指标记被携带进入决策但**未通过攻击消耗**的回合：每经过一个这样的回合计时 +1，达到 2 即失效（标记清除）。
- 即：第 N 回合蓄力成功 → 第 N+1、N+2 回合可用攻击 ×2；若到 N+2 仍未攻击，进入 N+3 前标记失效。
- 蓄力后选择防御/反击/再蓄力都**不消耗**标记，但**仍计入老化**（防止"蓄力 + 永久防御"乌龟流）。
- 选择攻击消耗标记、计时归零；机制 C 清除标记时计时也归零。

**蓄力标记叠加与冲突规则**（明确边界情况）：

| 场景 | 处理 | 说明 |
|------|------|------|
| 无标记 + 蓄力成功 | 设置标记 | 标准情况 |
| 有标记 + 蓄力成功 | 标记保留（不叠加） | 蓄力倍率始终为 ×2，不累积为 ×4 |
| 有标记 + 蓄力被打断 | **标记保留**（不丢失原有标记） | 仅本次蓄力失败，不影响已积累的标记 |
| 有标记 + 攻击 | 消耗标记，伤害 ×2，计时归零 | 标准消耗 |
| 有标记 + 防御/反击 | 标记保留但计时 +1 | 不消耗，但仍老化（最多 2 回合，见上文失效规则） |
| 双方同时有标记超过 2 回合 | 第 3 回合开始清除双方标记 | 见第九节僵局检测机制 C |

> 关键变更：原设计中"带着蓄力标记再蓄力被打断会清空原标记"不符合玩家直觉，已修正为"仅本次蓄力失败，原标记保留"。

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
| 攻击 | 蓄力 | 0 | 18 | 打断蓄力 |
| 攻击 | 反击 | 20 | 0 | 被反击 |
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
- 超时未选择 → 自动执行"**防御**"（统一以第八节为准；旧版"自动攻击"已废弃，原因见第八节）
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

- HP 变化（`HP = Math.max(0, HP - dmg)`，强制 clamp 到 0）
- 蓄力状态更新（按优先级判断）：
  1. 本回合选择**攻击**且已有蓄力标记 → 消耗蓄力标记（设为 false），伤害已在 Step 3 应用 ×2
  2. 本回合选择**蓄力**且被打断（playerDmg > 0）→ **保留原有蓄力标记**（不丢失，仅本次蓄力失败）
  3. 本回合选择**蓄力**且成功（playerDmg === 0）→ 设置蓄力标记为 true（若已有标记则保持，不叠加）
  4. 本回合选择**防御/反击** → 蓄力标记保持原状（有则保留，无则无）
- 僵局计数器更新：
  - 若本回合双方均未造成伤害 → `consecutiveNoDamageRounds++`，否则归零
  - 若双方都持有蓄力标记 → `bothChargedStalemate++`，否则归零
  - `totalRounds++`

### Step 5：回合结束

- 更新血条
- 播放伤害动画
- 检查胜负条件
- 重置倒计时，进入下一回合

---

## 八、30 秒回合机制

- 每回合固定 30 秒决策时间
- 玩家必须在时间内选择动作
- **超时未选择的默认动作规则**（避免误消耗蓄力标记）：
  - 玩家**无蓄力标记** → 自动执行"**防御**"（安全选项，不造成伤害也不消耗资源）
  - 玩家**有蓄力标记** → 自动执行"**防御**"（保留蓄力标记，避免被故意超时绕过博弈）
  - 不再使用"自动攻击"作为默认动作，原因：自动攻击会误消耗蓄力标记，且可被玩家利用"故意超时"绕过心理博弈
- 双方都选择后立即进入结算（不必等满 30 秒）

目的：
- 强制决策压力
- 防止无限思考
- 保持游戏节奏紧凑
- 超时惩罚为"放弃进攻机会"，而非"被迫消耗资源"

---

## 九、胜负条件

### 1. 基本胜负判定

```
当任意一方 HP ≤ 0
→ 游戏结束
→ 判定胜利/失败
```

- 胜利方展示胜利动画
- 失败方展示失败动画
- 双方 HP 同时归零 → 平局
- **HP 强制 clamp 到 0**：`HP = Math.max(0, HP - dmg)`，UI 永远不显示负数

**`gameResult` 枚举**（`resolveRound` 返回值，UI/战绩上报据此分支）：

| 值 | 含义 | 触发 |
|----|------|------|
| `null` | 未结束，继续下一回合 | 双方 HP > 0 且未达回合上限 |
| `'win'` | 玩家胜 | 对手 HP ≤ 0（玩家 > 0）；或回合上限时玩家 HP 高 |
| `'lose'` | 玩家负 | 玩家 HP ≤ 0（对手 > 0）；或回合上限时对手 HP 高 |
| `'draw'` | 平局 | 双方同时归零；或回合上限 HP 相同 |
| `'doubleLose'` | 双败 | 回合上限时双方 HP 均 ≤ 5（机制 B，防极限拖延）|

> `doubleLose` 在 UI 上展示为"双双力竭"，战绩按"双方各记一负"处理。

### 2. 僵局检测（防无限平局）

为避免 `防御 vs 防御`、双方蓄力后互相威慑等僵局，引入以下机制：

**机制 A：连续无伤害回合上限**

- 连续 **5 回合** 双方均未造成任何伤害（即 `playerDmg === 0 && opponentDmg === 0`）→ 触发"环境伤害"打破僵局
- 从第 5 个连续无伤害回合起，**该回合结算时**双方各受环境伤害（与本回合动作伤害一并扣除，非"下回合开始"）
- 环境伤害**逐回合递增**：第 5 个无伤害回合 5 点，第 6 个 10 点，第 7 个 15 点……即 `envDmg = 5 × (连续无伤害回合数 − 5 + 1)`，确保僵局快速终结
- 一旦某回合产生了真实伤害，连续无伤害计数器归零，环境伤害重置

**机制 B：总回合上限**

- 总回合数达到 **20 回合** 仍未分出胜负 → 按剩余 HP 比例判定：
  - HP 高者胜
  - HP 相同 → 平局
  - 双方都 ≤ 5 HP → 双败（避免极限拖延）

**机制 C：蓄力威慑打破**

- 若双方同时持有蓄力标记超过 **2 回合** 都未消耗 → 第 3 回合开始时清除双方蓄力标记（避免"核威慑"永久僵局）

### 3. 状态追踪

游戏状态需新增字段：

```js
{
  consecutiveNoDamageRounds: 0,  // 连续无伤害回合数
  totalRounds: 0,                // 总回合数
  bothChargedStalemate: 0,       // 双方同时持有蓄力标记的回合数
  playerChargeUnused: 0,         // 玩家蓄力标记已携带未消耗的回合数（达 2 失效）
  opponentChargeUnused: 0,       // 对手同上
}
```

---

## 十、轻量随机性

| 系统 | 规则 | 是否 MVP | 说明 |
|------|------|----------|------|
| 暴击 | 10% 概率 ×1.5 伤害 | 否 | 增加不确定性，后续根据体验数据决定 |
| 残血强化 | HP < 30 → 攻击 +10% | **是** | 增加翻盘可能，缓解残局互秒问题 |
| 残血护盾 | HP < 20 时，单次受到伤害不超过当前 HP 的 60% | **是** | 防止残局被蓄力攻击（24 伤）一击秒杀，给劣势方反击机会 |

### 残血机制详细说明（MVP 必须实现）

**残血强化**：
- 触发条件：攻击方 HP < 30
- 效果：该次攻击伤害 ×1.1（向上取整）
- 例：基础 12 伤害 → `Math.ceil(12 × 1.1) = Math.ceil(13.2) = 14`
- 蓄力攻击：`Math.ceil(12 × 2 × 1.1) = Math.ceil(26.4) = 27`

**残血护盾**：
- 触发条件：被攻击方 HP < 20
- 效果：单次受到伤害上限 = `Math.ceil(当前HP × 0.6)`
- 例：HP = 15 时，单次最多受 `Math.ceil(15 × 0.6) = 9` 伤害（即使被 24 伤蓄力攻击也只扣 9）
- 目的：避免残局"谁先手谁赢"的互秒局面，让劣势方至少能再行动 1~2 回合

> 这两个机制共同作用：残血方攻击更强（强化）、被击杀更慢（护盾），形成翻盘窗口期。

---

## 十一、PvE 人机对战模式

### 1. 模式说明

PvE 模式下，玩家直接与本地 AI 对战，无需邀请好友、无需联网。从大厅点击"人机对战"即可立即开始。

与 PvP 的区别：

| 对比项 | PvP 人人对战 | PvE 人机对战 |
|--------|-------------|-------------|
| 对手 | 在线好友 | 本地 AI |
| 网络 | WebSocket 实时同步 | 纯本地，无网络通信 |
| 邀请流程 | 需要（invite → accept） | 不需要，直接开始 |
| 动作同步 | 双方各自选择后互发消息 | AI 在本地即时生成动作 |
| 倒计时 | 30 秒（双方都有压力） | 30 秒（仅玩家有压力，AI 瞬时决策） |
| 状态机 | idle → inviting → playing → result | idle → playing → result |

### 2. AI 行为模型（MVP）

NPC 行为为**状态感知概率模型**，在基础概率上根据双方蓄力状态调整，避免出现"AI 有蓄力标记却去防御浪费"等不合理行为。

#### 基础概率（无特殊状态时）

| 动作 | 概率 |
|------|------|
| 攻击 | 50% |
| 防御 | 25% |
| 蓄力 | 15% |
| 反击 | 10% |

#### 状态感知调整规则

| 触发条件 | 调整 | 理由 |
|----------|------|------|
| AI 自己有蓄力标记 | 攻击概率提升至 **70%**，防御 20%，反击 10%，蓄力 0% | 有大就要用，避免浪费标记 |
| 玩家有蓄力标记 | 防御 40%，反击 35%，攻击 15%，蓄力 10% | 倾向克制玩家可能的蓄力攻击（防御减伤或反击成功） |
| 双方都有蓄力标记 | 攻击 60%，防御 30%，反击 10% | 互秒局面优先出手 |
| AI 的 HP < 30（残血强化触发） | 攻击概率 +15%（从基础概率提升） | 利用残血强化翻盘 |
| 玩家的 HP < 20（残血护盾触发） | 蓄力概率 +10% | 需要蓄力破护盾 |
| 连续 2 回合 AI 蓄力被打断 | 蓄力概率归零，攻击 +20% | 避免重复犯错 |

#### 决策伪代码

```js
function aiDecide(aiState, playerState, history) {
  let weights = { attack: 50, defend: 25, charge: 15, counter: 10 }

  if (aiState.charged) {
    weights = { attack: 70, defend: 20, charge: 0, counter: 10 }
  } else if (playerState.charged) {
    weights = { attack: 15, defend: 40, charge: 10, counter: 35 }
  }

  if (aiState.hp < 30) weights.attack += 15
  if (playerState.hp < 20) weights.charge += 10
  if (history.consecutiveChargeInterrupted >= 2) {
    weights.charge = 0
    weights.attack += 20
  }

  return weightedRandom(weights)
}
```

说明：
- 保持"可读但不完全可预测"
- 避免明显不合理的行为（如有大不用、重复犯错）
- 后续可升级为基于玩家行为历史的简单预测模型

### 3. AI 决策时机

- 玩家选择动作并锁定后，AI 立即生成动作（模拟"同时选择"）
- AI 不需要等待 30 秒，但玩家仍受 30 秒倒计时约束
- AI 动作在结算时才揭示给玩家（与 PvP 体验一致）

### 4. AI 难度扩展方向（非 MVP）

| 难度 | 策略 | 说明 |
|------|------|------|
| 简单 | 纯随机概率 | MVP 版本 |
| 普通 | 统计玩家行为频率，倾向克制玩家常用动作 | 基于历史 |
| 困难 | 记忆玩家最近 N 回合序列，预测下一动作 | 简单马尔可夫链 |

---

## 十二、3D 场景与 UI 设计

### 设计理念

采用 **3D 战斗场景 + 2D UI 覆盖层** 的混合架构：战斗画面由 Babylon.js 渲染 3D 角色和场景，策略决策信息（HP、倒计时、动作按钮）用 2D HUD 覆盖在 3D 画面之上。

目标体验：**3D 格斗游戏的画面表现 + 心理博弈的策略深度**。

美术风格：**Low Poly 低多边形**，兼顾性能与表现力，角色面数控制在 5k 以内。

参考方向：
- 《暗影格斗 3》的镜头语言与打击感
- 《Marvel Snap》的竖屏信息层次
- Low Poly 风格的《堡垒之夜》简化质感

---

### 1. 战斗场景 3D 设计

#### 场景布局（竖屏）

```
┌─────────────────────────┐
│  Round 3        ⏳22s   │  ← HUD 顶部（2D 覆盖）
├─────────────────────────┤
│                         │
│         /─────\         │
│        │ NPC   │        │  ← 3D 远景角色（对手）
│         \─────/         │
│      ███████░░░ 72      │  ← HUD 血条（2D 覆盖）
│                         │
│  ─────────────────────  │  ← 场景中线（地面）
│                         │
│      █████████░ 85      │  ← HUD 血条（2D 覆盖）
│         /─────\         │
│        │ 玩家  │        │  ← 3D 近景角色（玩家）
│         \─────/         │
│                         │
├─────────────────────────┤
│ [攻击]  [防御]           │  ← HUD 操作区（2D 覆盖）
│ [蓄力]  [反击]           │
└─────────────────────────┘
```

- **3D 场景**：竖向擂台，玩家在下方（近），对手在上方（远）
- **2D HUD**：覆盖在 3D Canvas 之上，用 Vue 组件渲染，保证文字清晰度和点击响应
- **镜头**：略带俯视角（约 15°），强化"对峙"感

#### 3D 场景元素

| 元素 | 说明 | 资源 |
|------|------|------|
| 战斗擂台 | 圆形/方形地面平台，带边界光效 | Low Poly 模型，约 2k 面 |
| 背景环境 | 简化场馆/道场背景，烘托氛围 | Skybox + 远景低模 |
| 灯光 | 主光 + 补光 + 边缘光，突出角色 | Babylon.js 光照系统 |
| 粒子 | 蓄力能量、打击火花、胜利金光 | ParticleSystem |

#### 镜头系统

| 状态 | 镜头位置 | 说明 |
|------|----------|------|
| 回合开始 | 全景，包含双方角色 | 展示对峙 |
| 决策阶段 | 略微推进，聚焦玩家 | 突出决策压力 |
| 结算动画 | 动态切换到攻击方/受击方 | 强化打击感（见动画系统） |
| 胜利/失败 | 胜者特写 / 败者倒地全景 | 情绪渲染 |

镜头过渡使用 Babylon.js `Animation` 系统，缓动函数 `CubicEase`，过渡时间 300-500ms。

---

### 2. 角色设计

#### Low Poly 角色规格

| 属性 | 规格 | 说明 |
|------|------|------|
| 面数 | ≤ 5000 三角面 | 中端机性能预算 |
| 纹理 | 512×512（最大 1024×1024） | Low Poly 风格无需高分辨率 |
| 骨骼 | ≤ 30 骨骼 | 兼顾动作丰富度与性能 |
| 材质 | PBR 简化材质 + 卡通描边（可选） | Low Poly 质感 |

#### 角色资源

| 角色 | 来源 | 说明 |
|------|------|------|
| 玩家角色 | Mixamo/Sketchfab 免费模型 | Low Poly 风格，需统一骨骼 |
| NPC 角色 | Mixamo/Sketchfab 免费模型 | 与玩家风格一致 |
| 角色变体 | 后续扩展 | 不同职业/皮肤 |

#### 动作动画（Animation Clip）

每个角色需准备以下动作动画（从 Mixamo 获取或通用骨骼重定向）：

| 动作 | 时长 | 说明 | 触发场景 |
|------|------|------|----------|
| Idle 待机 | 循环 | 呼吸、轻微晃动 | 决策阶段 |
| Attack 攻击 | 0.6s | 挥拳/挥剑前冲 | 选择攻击 |
| Defend 防御 | 0.4s | 举盾/格挡姿势 | 选择防御 |
| Charge 蓄力 | 1.0s | 蓄力发光姿势 | 选择蓄力 |
| Counter 反击 | 0.8s | 闪避+反击动作 | 选择反击 |
| Hit 受击 | 0.5s | 后仰/踉跄 | 被攻击命中 |
| Stagger 硬直 | 0.6s | 蓄力被打断 | 蓄力被打断 |
| Victory 胜利 | 循环 | 庆祝姿势 | 游戏胜利 |
| Defeat 失败 | 1.0s | 倒地 | 游戏失败 |

> Mixamo 提供大量免费动作捕捉动画，可直接下载 FBX/GLB 格式，骨骼绑定后即可使用。

---

### 3. UI 覆盖层（HUD）

HUD 用 Vue 3 + Quasar 组件实现，覆盖在 3D Canvas 之上，保证文字清晰和交互响应。

#### 屏幕布局

| 区域 | 比例 | 渲染层 | 内容 |
|------|------|--------|------|
| 顶部信息栏 | 8% | 2D HUD | 回合数 + 倒计时 |
| 对手血条区 | 7% | 2D HUD | 对手 HP + 蓄力状态 |
| 3D 战斗区 | 55% | 3D Canvas | 角色对战 + 特效 |
| 玩家血条区 | 7% | 2D HUD | 玩家 HP + 蓄力状态 |
| 战斗信息区 | 8% | 2D HUD | 上回合结果 + 伤害数字 |
| 操作区 | 15% | 2D HUD | 四个动作按钮 |

#### 动作按钮设计

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
- 按钮带 3D 悬浮效果（CSS transform + shadow）

#### 回合锁定状态

玩家选择动作后，3D 角色播放对应预备动画，HUD 显示等待状态：

```
┌─────────────────────┐
│      已选择：攻击    │
│                     │
│   等待对手决策...    │
│                     │
│   对方剩余 ⏳18s    │
└─────────────────────┘
```

#### 回合结算覆盖层

结算动画期间，3D 场景播放动作对决，HUD 显示结算信息：

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

---

### 4. 必须显示的信息

| 位置 | 信息 | 渲染层 |
|------|------|--------|
| 顶部 | 回合数、倒计时 | 2D HUD |
| 对手区域 | HP、蓄力状态 | 2D HUD |
| 玩家区域 | HP、蓄力状态 | 2D HUD |
| 3D 场景 | 角色动作、特效、镜头 | 3D Canvas |
| 中央 | 上回合结果、伤害数字 | 2D HUD |
| 底部 | 四个动作按钮 | 2D HUD |

### 5. MVP 不做的事

先不要加：摇杆操作、技能树、装备栏、背包、商城、聊天、世界地图、角色定制。先把 **3D 战斗表现 + 攻击/防御/蓄力/反击** 这一套玩得有画面感。

---

### 6. 3D 动画系统

#### 动画状态机

角色动画由 Babylon.js `AnimationGroup` 管理，状态切换如下：

```
                    ┌──────────┐
                    │  Idle    │ ◄────────────┐
                    └────┬─────┘              │
                         │ 选择动作            │
            ┌────────────┼────────────┐       │
            ▼            ▼            ▼       │
      ┌──────────┐ ┌──────────┐ ┌──────────┐ │
      │ Attack   │ │ Defend   │ │ Charge   │ │
      └────┬─────┘ └────┬─────┘ └────┬─────┘ │
           │            │            │       │
           │    ┌───────┘            │       │
           ▼    ▼                    ▼       │
      ┌──────────┐            ┌──────────┐   │
      │ Counter  │            │  Stagger │   │
      └────┬─────┘            └────┬─────┘   │
           │                       │         │
           ▼                       ▼         │
      ┌──────────┐            ┌──────────┐   │
      │   Hit    │            │   Hit    │   │
      └────┬─────┘            └────┬─────┘   │
           │                       │         │
           └───────────┬───────────┘         │
                       ▼                     │
                 ┌──────────┐                │
                 │ Victory  │ / Defeat       │
                 └──────────┘                │
                       │                     │
                       └─────────────────────┘
                       （下一回合回到 Idle）
```

#### 结算动画时序

双方动作确定后，按以下时序播放结算动画：

| 时间 | 镜头 | 攻击方 | 受击方 | 特效 |
|------|------|--------|--------|------|
| 0ms | 切换到攻击方侧后方 | 起手预备动作 | Idle | - |
| 200ms | 跟随攻击动作 | Attack 动画播放 | - | 起手光效 |
| 500ms | 切换到受击方 | - | Hit/Stagger 动画 | 打击火花 + 屏幕震动 |
| 600ms | 全景 | 收招 | 后仰 | 伤害数字弹出（3D 空间） |
| 1200ms | 回到默认机位 | Idle | Idle | - |

- 镜头切换使用 `Camera.interpolateTo()`，过渡 200ms
- 屏幕震动使用 `Camera.shake()`，强度根据伤害值
- 伤害数字用 3D 空间中的 `DynamicTexture` Sprite，向上漂浮 + 淡出

#### 特效系统

| 场景 | 特效 | 实现 |
|------|------|------|
| 攻击命中 | 打击火花 + 屏幕震动 | ParticleSystem + Camera.shake |
| 防御成功 | 护盾光效 + 格挡音效 | 透明球体材质 + 动画 |
| 蓄力中 | 能量聚集 + 角色发光 | 环绕粒子 + 自发光材质 |
| 蓄力攻击 | 强化攻击拖尾 | TrailMesh + 强化粒子 |
| 反击成功 | 闪避残影 + 反击光效 | 残影 Sprite + 爆发粒子 |
| 反击失败 | 踉跄 + 失误提示 | 角色晃动动画 + 红色闪烁 |
| 蓄力被打断 | 硬直 + 能量消散 | 粒子爆散 + 灰色滤镜 |
| HP 减少 | 血条平滑减少 + 伤害数字 | HUD 动画 + 3D 数字 |
| 胜利 | 金色光柱 + 胜利姿势 | 粒子系统 + 镜头特写 |
| 失败 | 灰色滤镜 + 倒地 | 后处理 + 动画 |
| 僵局环境伤害 | 全场震动 + 红色警示 | 屏幕震动 + 边缘红光 |

#### 后处理效果

| 效果 | 触发场景 | 实现 |
|------|----------|------|
| 慢动作 | 反击成功 / 蓄力攻击命中 | `Scene.timeScale = 0.3`，持续 500ms |
| 屏幕震动 | 任意伤害命中 | `Camera.shake(intensity, duration)` |
| 色调分离 | 残血状态（HP<20） | `DefaultRenderingPipeline` + 色差 |
| 模糊 | 蓄力中 | `DepthOfFieldEffect` 聚焦角色 |
| 灰度 | 失败 | `DefaultRenderingPipeline.grain` |

---

## 十三、技术方案

### 1. 整体架构

前端 Vue 3 + Quasar 页面驱动，**Babylon.js 负责 3D 渲染**，WebSocket 信令中继，无服务端游戏逻辑。

**渲染分层架构：**

```
┌─────────────────────────────────────────────┐
│              IronFistPage.vue               │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─────────────────┐  ┌──────────────────┐ │
│  │   2D HUD 层      │  │   3D Canvas 层    │ │
│  │   (Vue + Quasar) │  │   (Babylon.js)   │ │
│  │                  │  │                  │ │
│  │  - 血条/倒计时   │  │  - 角色模型      │ │
│  │  - 动作按钮      │  │  - 场景/灯光     │ │
│  │  - 结算信息      │  │  - 动画/特效     │ │
│  │  - 大厅/结果页   │  │  - 镜头控制      │ │
│  └────────┬────────┘  └────────┬─────────┘ │
│           │                    │           │
│           └─────────┬──────────┘           │
│                     ▼                      │
│           ┌──────────────────┐             │
│           │  游戏逻辑核心     │             │
│           │  IronFistGame.js │             │
│           │  (状态机 + 结算)  │             │
│           └────────┬─────────┘             │
│                    │                       │
│         ┌──────────┼──────────┐            │
│         ▼          ▼          ▼            │
│   ┌──────────┐ ┌────────┐ ┌──────────┐    │
│   │ GameNet  │ │ GameAI │ │ ResourceManager│ │
│   │ (PvP)    │ │ (PvE)  │ │ (3D 资源) │    │
│   └──────────┘ └────────┘ └──────────┘    │
└─────────────────────────────────────────────┘
```

**PvP 人人对战：**

```
  玩家A (前端)                    玩家B (前端)
  ┌──────────┐   WebSocket   ┌──────────┐
  │ IronFist │ ◄───────────► │ IronFist │
  │  Page    │    中继转发     │  Page    │
  │ +Babylon │               │ +Babylon │
  └──────────┘               └──────────┘
        │                          │
        ▼                          ▼
  本地游戏逻辑               本地游戏逻辑
  (状态机 + 结算 + 3D)       (状态机 + 结算 + 3D)
```

**PvE 人机对战：**

```
  玩家 (前端)
  ┌──────────────────┐
  │   IronFist Page  │
  │   + Babylon.js   │
  │                  │
  │  ┌────────────┐  │
  │  │ 游戏逻辑    │  │  ← 状态机 + 结算
  │  └────────────┘  │
  │  ┌────────────┐  │
  │  │ AI 模块     │  │  ← 概率模型生成动作
  │  └────────────┘  │
  │  ┌────────────┐  │
  │  │ 3D 渲染     │  │  ← Babylon.js 场景
  │  └────────────┘  │
  └──────────────────┘
  （纯本地，无网络通信）
```

**关键设计：**
- **渲染分层**：3D Canvas 在底层，2D HUD 用绝对定位覆盖在上层，互不干扰
- **逻辑与渲染解耦**：`IronFistGame.js` 只管状态机和结算，不关心 3D 渲染；3D 层订阅状态变化播放动画
- PvP 模式：服务端仅做消息中继，双方各自在本地维护完整游戏状态，通过确定性同步保证一致性
- PvE 模式：完全本地运行，AI 动作由前端即时生成，无需任何网络通信

### 2. Babylon.js 集成方案

#### 依赖安装

```bash
npm install @babylonjs/core @babylonjs/loaders @babylonjs/materials
```

- `@babylonjs/core`：核心引擎（渲染、场景、相机、光照、动画）
- `@babylonjs/loaders`：模型加载器（GLB/GLTF/FBX）
- `@babylonjs/materials`：扩展材质库

> 使用 ES Module 按需引入，配合 Vite 的 tree-shaking，减小打包体积。

#### 引擎初始化

```js
import { Engine, Scene, ArcRotateCamera, HemisphericLight, DirectionalLight } from '@babylonjs/core'

class IronFistRenderer {
  constructor(canvas) {
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      disableWebGL2Support: false,
    }, true)  // 第4个参数 true 启用自适应 DPR
    this.scene = new Scene(this.engine)
    this.setupCamera()
    this.setupLights()
    this.setupPipeline()

    // 自适应渲染循环
    this.engine.runRenderLoop(() => {
      this.scene.render()
    })

    // 窗口尺寸自适应
    window.addEventListener('resize', () => this.engine.resize())
  }

  setupCamera() {
    // 竖屏格斗视角：略带俯视
    this.camera = new ArcRotateCamera(
      'camera',
      -Math.PI / 2,  // alpha：正面
      Math.PI / 2 - 0.26,  // beta：俯视约 15°
      8,  // radius
      new Vector3(0, 1, 0),
      this.scene
    )
  }

  setupLights() {
    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), this.scene)
    hemi.intensity = 0.6
    const dir = new DirectionalLight('dir', new Vector3(-1, -2, -1), this.scene)
    dir.intensity = 0.8
    dir.position = new Vector3(5, 10, 5)
  }

  setupPipeline() {
    // 后处理管线：残血色调、慢动作等
    this.pipeline = new DefaultRenderingPipeline('pipeline', true, this.scene, [this.camera])
    this.pipeline.fxaaEnabled = true
    this.pipeline.bloomEnabled = true
    this.pipeline.bloomThreshold = 0.7
    this.pipeline.bloomWeight = 0.3
  }
}
```

#### 与 Vue 集成

```vue
<!-- IronFistPage.vue -->
<template>
  <div class="ironfist-page">
    <!-- 3D Canvas 层 -->
    <canvas ref="canvasRef" class="game-canvas" />

    <!-- 2D HUD 覆盖层 -->
    <div class="hud-overlay">
      <TopBar :round="round" :countdown="countdown" />
      <HealthBar v-for="p in players" :key="p.id" :player="p" />
      <ActionBar v-if="phase === 'deciding'" @select="onAction" />
      <ResultPanel v-if="phase === 'waiting_confirm'" :result="lastResult" @next="nextRound" />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { IronFistRenderer } from './game/Renderer'
import { IronFistGame } from './game/IronFistGame'

const canvasRef = ref(null)
let renderer, game

onMounted(() => {
  renderer = new IronFistRenderer(canvasRef.value)
  game = new IronFistGame()
  // 游戏状态变化 → 驱动 3D 动画
  game.on('stateChange', (state) => renderer.syncState(state))
})

onBeforeUnmount(() => {
  renderer?.dispose()
  game?.dispose()
})
</script>

<style scoped>
.ironfist-page {
  position: relative;
  width: 100%;
  height: 100vh;
  overflow: hidden;
}
.game-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  touch-action: none;  /* 防止移动端手势冲突 */
}
.hud-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;  /* 默认不拦截事件，子元素按需开启 */
}
.hud-overlay > * {
  pointer-events: auto;
}
</style>
```

### 3. 确定性同步

由于回合制游戏的天然确定性（无实时操作、无随机地图），同步方案比炸弹人更简单：

- **回合同步**：双方各自选择动作后发送给对方，收到对方动作后本地结算
- **无随机性**：MVP 阶段无暴击等随机系统，结算结果完全由双方动作决定
- **无需 seed**：不像炸弹人需要共享随机种子
- **防作弊**：MVP 阶段信任客户端，后续可加服务端校验
- **3D 动画独立**：双方 3D 渲染各自独立，不影响游戏逻辑一致性

### 4. 文件结构

```
frontend/src/games/ironfist/
├── IronFistPage.vue              # 游戏主页面（大厅/邀请/对战/结果）
├── components/                   # 2D HUD 组件
│   ├── TopBar.vue                # 顶部信息栏（回合 + 倒计时）
│   ├── HealthBar.vue             # 血条 + 蓄力状态
│   ├── ActionBar.vue             # 动作按钮区
│   ├── ResultPanel.vue           # 结算信息面板
│   └── Lobby.vue                 # 大厅视图
├── game/
│   ├── IronFistGame.js           # 游戏核心逻辑（状态机、结算）
│   ├── GameConstants.js          # 常量定义（HP、伤害、时间等）
│   ├── GameNet.js                # 网络通信（PvP 模式）
│   ├── GameAI.js                 # AI 决策模块（PvE 模式）
│   └── three/                    # 3D 渲染模块
│       ├── Renderer.js           # Babylon.js 引擎封装
│       ├── SceneManager.js       # 场景管理（擂台、灯光、镜头）
│       ├── CharacterController.js # 角色控制（模型加载、动画切换）
│       ├── AnimationManager.js   # 动画状态机管理
│       ├── EffectManager.js      # 特效系统（粒子、后处理）
│       └── CameraController.js   # 镜头控制（机位切换、震动）
└── assets/
    └── models/                   # 3D 模型资源（GLB 格式）
        ├── arena.glb             # 战斗擂台
        ├── player.glb            # 玩家角色（含动画）
        ├── npc.glb               # NPC 角色（含动画）
        └── effects/              # 特效资源
            ├── hit_particle.png
            ├── charge_energy.png
            └── victory_beam.png
```

### 5. 路由注册

在 `frontend/src/router/index.js` 中添加：

```js
{ path: 'games/ironfist', component: () => import('src/games/ironfist/IronFistPage.vue') }
```

### 6. 游戏中心入口

在 `frontend/src/pages/GamesPage.vue` 中添加铁拳卡片：

```vue
<div class="col-6 col-sm-4 col-md-3">
  <q-card class="game-card cursor-pointer" @click="router.push('/games/ironfist')">
    <q-card-section class="text-center q-pa-lg">
      <div style="font-size: 52px">🥊</div>
      <div class="text-subtitle1 text-bold q-mt-sm">铁拳</div>
      <div class="text-caption text-grey-6">3D 回合制心理博弈</div>
    </q-card-section>
    <q-separator />
    <q-card-actions align="center" class="q-py-sm">
      <q-chip dense color="positive" text-color="white" icon="people" label="1v1" />
      <q-chip dense color="purple" text-color="white" icon="psychology" label="策略" />
      <q-chip dense color="deep-orange" text-color="white" icon="3d_rotation" label="3D" />
    </q-card-actions>
  </q-card>
</div>
```

### 7. GameStore 扩展

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

## 十三.5、3D 资源管理

### 1. 资源清单

| 资源 | 格式 | 大小预估 | 来源 | 说明 |
|------|------|----------|------|------|
| 战斗擂台 | GLB | ~200KB | Sketchfab Low Poly | 场景地面 + 边界 |
| 玩家角色 | GLB | ~500KB | Mixamo | 含骨骼 + 动画 |
| NPC 角色 | GLB | ~500KB | Mixamo | 含骨骼 + 动画 |
| 动作动画集 | GLB 内嵌 | - | Mixamo | 9 个动作（见第十二节） |
| 粒子贴图 | PNG | ~50KB | OpenGameArt | 火花、能量、光柱 |
| Skybox | JPG ×6 | ~300KB | OpenGameArt | 立方体贴图 |
| 音效 | MP3 | ~200KB | Freesound | 打击、蓄力、胜利等 |

**总资源体积预估：~1.8MB**（gzip 后约 1.2MB）

### 2. 资源加载策略

#### 分阶段加载

```
阶段 1：大厅（进入页面立即加载）
  - 大厅 UI（Vue 组件）
  - 战绩数据（API 请求）

阶段 2：匹配中（点击对战后并行加载）
  - 战斗擂台 GLB
  - Skybox
  - 灯光/相机初始化

阶段 3：对战准备（进入 playing 状态）
  - 玩家角色 GLB + 动画
  - NPC 角色 GLB + 动画
  - 粒子贴图
  - 音效

阶段 4：按需加载（结算时）
  - 胜利/失败特效
  - 后处理资源
```

#### 加载进度展示

```vue
<template>
  <div v-if="loading" class="loading-overlay">
    <q-spinner-dots size="40px" />
    <div class="q-mt-sm">{{ loadingText }}... {{ progress }}%</div>
    <q-linear-progress :value="progress / 100" />
  </div>
</template>
```

#### 加载实现

```js
import { SceneLoader } from '@babylonjs/core'
import '@babylonjs/loaders'

class ResourceManager {
  constructor(scene) {
    this.scene = scene
    this.cache = new Map()
  }

  async loadArena(onProgress) {
    if (this.cache.has('arena')) return this.cache.get('arena')
    const result = await SceneLoader.ImportMeshAsync(
      '', './models/', 'arena.glb', this.scene, onProgress
    )
    this.cache.set('arena', result.meshes[0])
    return result.meshes[0]
  }

  async loadCharacter(type, onProgress) {
    // type: 'player' | 'npc'
    if (this.cache.has(type)) return this.cache.get(type)
    const result = await SceneLoader.ImportMeshAsync(
      '', './models/', `${type}.glb`, this.scene, onProgress
    )
    const mesh = result.meshes[0]
    const animationGroups = result.animationGroups
    this.cache.set(type, { mesh, animationGroups })
    return { mesh, animationGroups }
  }

  dispose() {
    this.cache.forEach(mesh => mesh.dispose?.())
    this.cache.clear()
  }
}
```

### 3. 资源缓存

- **会话内缓存**：同一次页面访问内，模型加载后缓存在内存，重复进入对战不重新加载
- **浏览器缓存**：GLB/PNG 文件通过 HTTP 缓存头（Cache-Control: max-age=31536000）长期缓存
- **预加载**：大厅空闲时后台预加载角色模型，减少首次对战等待

### 4. 资源优化

| 优化项 | 方案 | 预期收益 |
|--------|------|----------|
| 模型压缩 | 使用 `Draco` 压缩 GLB | 体积减少 50-70% |
| 纹理压缩 | 使用 KTX2/Basis 格式 | 体积减少 40-60%，GPU 解压快 |
| 动画合并 | 多个动作烘焙到同一 GLB | 减少请求次数 |
| LOD | 角色距离远时切换低面数模型 | 中端机帧率提升 |
| 纹理图集 | 粒子贴图合并为图集 | 减少 Draw Call |

---

## 十三.6、性能优化

### 1. 性能目标

| 设备等级 | 目标帧率 | 模型面数 | 纹理分辨率 | 特效等级 |
|----------|----------|----------|------------|----------|
| 高端机 | 60 FPS | ≤ 10k | 1024×1024 | 全开 |
| 中端机（目标） | 30 FPS | ≤ 5k | 512×512 | 标准 |
| 低端机 | 24 FPS | ≤ 3k | 256×256 | 简化 |

### 2. 设备检测与自适应

```js
class PerformanceDetector {
  static detect() {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) return { tier: 'unsupported' }

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : ''

    // 简单分级：根据 GPU 型号和内存
    const memory = navigator.deviceMemory || 4
    const cores = navigator.hardwareConcurrency || 4

    if (memory >= 8 && cores >= 8) return { tier: 'high' }
    if (memory >= 4 && cores >= 4) return { tier: 'medium' }
    return { tier: 'low' }
  }
}
```

### 3. 渲染优化

| 优化项 | 实现 | 说明 |
|--------|------|------|
| 帧率限制 | `engine.setHardwareScalingLevel(1 / targetFps)` | 限制渲染频率 |
| 视锥剔除 | Babylon.js 默认开启 | 背面角色不渲染 |
| 阴影优化 | `ShadowGenerator.useExponentialShadowMap = true` | 软阴影性能更好 |
| 粒子数量控制 | 中端机粒子数 ×0.6，低端机 ×0.3 | 根据设备等级调整 |
| 后处理降级 | 低端机关闭 Bloom/DOF | 保证基础帧率 |
| 纹理压缩 | KTX2 格式 + Basis 解码 | 移动端 GPU 友好 |

### 4. 内存管理

```js
class IronFistRenderer {
  dispose() {
    // 释放所有资源
    this.resourceManager?.dispose()
    // 停止渲染循环
    this.engine.stopRenderLoop()
    // 释放场景
    this.scene.dispose()
    // 释放引擎
    this.engine.dispose()
  }
}
```

- **页面卸载时必须释放**：Vue `onBeforeUnmount` 调用 `renderer.dispose()`
- **长时间空闲时降级**：切到后台时暂停渲染循环 `engine.stopRenderLoop()`，回前台时恢复
- **资源引用计数**：ResourceManager 跟踪资源使用，及时释放不再使用的模型

### 5. 移动端适配

| 问题 | 解决方案 |
|------|----------|
| WebGL 兼容性 | 检测 WebGL 支持，不支持时降级为 2D 模式（CSS 动画） |
| 触摸事件冲突 | Canvas 设置 `touch-action: none`，HUD 按钮独立处理 |
| 内存不足 | 低端机自动降级模型面数和纹理 |
| 发热降频 | 限制 30 FPS，减少持续高负载 |
| 屏幕尺寸 | Canvas 自适应 `engine.resize()`，HUD 用响应式布局 |

### 6. 降级方案

若设备不支持 WebGL 或性能严重不足，自动降级为 2D 模式：

```js
const tier = PerformanceDetector.detect()
if (tier.tier === 'unsupported') {
  // 降级为 CSS 动画模式（保留原 MVP 的简单实现作为 fallback）
  useFallback2DMode()
} else {
  // 使用 Babylon.js 3D 模式
  use3DMode(tier)
}
```

> 降级模式保留原 CSS 动画的简单实现，保证所有设备可玩，但无 3D 画面感。

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
| 双方 → 对方 | `ironfist_state_sync` | `{ room_id, round, hp, charged, ... }` | 状态同步（用于回合校验和断线恢复） |
| 任意方 → 对方 | `ironfist_reconnect` | `{ room_id, last_round }` | 请求断线重连，附带自己最后确认的回合 |
| 任意方 → 对方 | `game_resign` | `{ room_id }` | 认输 |

> **已删除 `ironfist_ready`**：原协议中标注为"可选"且语义不明，实际结算只需 `ironfist_action` 即可推进。若需要"双方都准备好才开始下一回合"的语义，由 `ironfist_action` 的 round 字段对齐即可，无需额外消息。

**`ironfist_action` 详细定义：**

```js
{
  type: 'ironfist_action',
  payload: {
    room_id: 'abc123',        // 房间 ID
    round: 3,                 // 回合数（从 1 开始，用于校验）
    action: 'attack',         // 动作：attack / defend / charge / counter
    ts: 1719123456789,        // 时间戳
  }
}
```

**结算流程：**

1. 双方各自选择动作后发送 `ironfist_action`
2. 收到对方动作后，**先校验 round 字段**（见下方回合校验）
3. 校验通过后本地执行结算（无需等服务端）
4. 播放动画，更新 HP
5. 检查胜负，若继续则进入下一回合

**回合校验（防状态错位）：**

```js
function onReceiveOpponentAction(msg) {
  if (msg.round !== currentRound) {
    // 回合不一致，发起状态同步
    send('ironfist_state_sync', {
      room_id,
      round: currentRound,
      hp: playerHP,
      charged: playerCharged,
      last_action: lastPlayerAction,
    })
    // 暂存对方动作，等状态对齐后再结算
    pendingOpponentAction = msg
    return
  }
  // round 一致，正常结算
  resolveRound(msg.action)
}
```

- 收到 round 不匹配的动作时，**不直接结算**，而是发起状态同步
- 双方交换 `ironfist_state_sync` 后，以 round 较大的一方为准对齐
- 若连续 3 次同步仍无法对齐 → 判定为不可恢复错误，提示玩家"网络异常，对战结束"

**超时处理：**

- 本地 30 秒倒计时结束未选择 → 自动发送 `action: 'defend'`（见第八节超时规则）
- 对方 30 秒内未收到动作 → 视为对方选择"防御"
- 超时方若持有蓄力标记，自动防御不会消耗标记

**断线重连：**

- 玩家断线后，前端检测到 WebSocket 重连成功 → 发送 `ironfist_reconnect`，附带自己最后确认的回合号
- 对方收到后回复 `ironfist_state_sync`，包含完整游戏状态（HP、蓄力标记、回合数、僵局计数器）
- 断线方根据同步状态恢复本地状态机，从断线回合继续
- **断线超时**：断线后 30 秒内未重连 → 判断断线方负
- 重连后双方都需重新发送当前回合的 `ironfist_action`（避免动作丢失）

### PvP 一致性补强（确定性同步的两个关键约束）

> 以下两点是 PvP 不分叉的前提，PvE 不受影响（本地单端结算）。

**1. 回合推进 barrier（解决 `waiting_confirm` 挂机卡死）**

`waiting_confirm` 等玩家点"下一回合"，但若一方挂机不点，另一方会永远卡住。规则：

- 玩家点"下一回合"后，本地从 `waiting_confirm` → `round_start(round+1)`，并把下一回合的动作锁定流程激活。
- **不需要为"确认"单独发消息**：对方进入下一回合的标志，就是收到对方 `ironfist_action` 且其 `round === 本地round + 1`。
- `waiting_confirm` 自身也设 **超时上限（建议 15 秒）**：超时未点自动进入下一回合，避免单方挂机。
- 因此回合推进的真正 barrier 是"双方的 `round+1` 动作都到齐才结算"，由 `ironfist_action.round` 字段对齐（见第十四节回合校验），与是否手动点确认解耦。

**2. 超时动作以"发送方本地判定"为唯一真相（解决两端分叉）**

两端计时器有网络延迟，不能各自独立判"对方超时"。规则：

- **只有动作的拥有者能决定自己是否超时**。A 的动作永远以 A 本地发出的 `ironfist_action` 为准；B 不得在本地"替 A 判超时"。
- A 本地 30 秒到点未选 → A 立即发送 `action: 'defend'`（带当前 round），这才是 A 本回合的真实动作。
- B 的等待上限放宽到 **33 秒**（30s + 3s 网络宽限）。33 秒内仍未收到 A 的动作 → 视为掉线，进入断线重连流程（而非直接替 A 判 defend 结算）。
- 这样同一回合 A 的动作在两端完全一致，结算结果确定，HP 不分叉。

**3. `game_resign` / 异常退出的战绩处理**

- 认输方记为负、对方记为胜；中途直接退出页面等同认输（离开 `playing` 前发送 `game_resign`）。
- 战绩上报由各端在本地结算出最终 `gameResult` 后上报自己的结果（MVP 信任客户端，不做双端交叉校验）。

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
// 注意：蓄力 ×2、残血强化、残血护盾不在此表中，由 resolveRound() 按乘区顺序额外计算
const DAMAGE_TABLE = {
  attack: {
    attack:   { playerDmg: 12, opponentDmg: 12 },
    defend:   { playerDmg: 0,  opponentDmg: 5  },   // 防御减伤 60%（Math.ceil(12×0.4)=5）
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

// 常量
const BASE_DAMAGE = 12
const DEFEND_REDUCTION = 0.4       // 防御减伤系数
const CHARGE_MULTIPLIER = 2        // 蓄力倍率
const LOW_HP_THRESHOLD = 30        // 残血强化阈值（攻击方）
const LOW_HP_BUFF = 1.1            // 残血强化倍率
const SHIELD_HP_THRESHOLD = 20     // 残血护盾阈值（被攻击方）
const SHIELD_RATIO = 0.6           // 残血护盾伤害上限比例
const STALE_NO_DMG_LIMIT = 5       // 连续无伤害回合上限
const STALE_ENV_DMG = 5            // 僵局环境伤害
const MAX_ROUNDS = 20              // 总回合上限
const BOTH_CHARGED_LIMIT = 2       // 双方同时蓄力标记僵局上限
```

### 3. 蓄力状态处理与完整结算

```js
// 完整结算函数：按乘区顺序计算伤害，更新蓄力标记和僵局计数器
// 乘区顺序：基础 → 蓄力 → 残血强化 → 暴击(未实现) → 防御减伤 → 残血护盾
function resolveRound(playerAction, opponentAction, gameState) {
  const { playerHP, opponentHP, playerCharged, opponentCharged } = gameState
  let result = { ...DAMAGE_TABLE[playerAction][opponentAction] }

  // === 乘区 1：蓄力加成（直接对表内伤害 ×2）===
  // 关键 1：只有当攻击"本来就会造成伤害"时才放大（opponentDmg > 0）。
  //         否则蓄力攻击撞上"反击"（opponentDmg 应为 0）会被错误放大，反击成功方凭空挨打。
  // 关键 2：对**表内已减伤的值** ×2，而非从 BASE 重算。
  //         attack/defend：5 × 2 = 10 = ceil(12×2×0.4)；attack/attack：12 × 2 = 24。
  //         整数倍率下与严格乘区顺序结果一致；从 BASE 重算会丢掉防御减伤（把 10 错算成 24）。
  if (playerCharged && playerAction === 'attack' && result.opponentDmg > 0) {
    result.opponentDmg *= CHARGE_MULTIPLIER
  }
  if (opponentCharged && opponentAction === 'attack' && result.playerDmg > 0) {
    result.playerDmg *= CHARGE_MULTIPLIER
  }

  // === 乘区 2：残血强化（攻击方 HP < 30）===
  if (playerHP < LOW_HP_THRESHOLD && result.opponentDmg > 0) {
    result.opponentDmg = Math.ceil(result.opponentDmg * LOW_HP_BUFF)
  }
  if (opponentHP < LOW_HP_THRESHOLD && result.playerDmg > 0) {
    result.playerDmg = Math.ceil(result.playerDmg * LOW_HP_BUFF)
  }

  // === 乘区 3：残血护盾（被攻击方 HP < 20，单次伤害上限）===
  if (playerHP < SHIELD_HP_THRESHOLD && result.playerDmg > 0) {
    const cap = Math.ceil(playerHP * SHIELD_RATIO)
    result.playerDmg = Math.min(result.playerDmg, cap)
  }
  if (opponentHP < SHIELD_HP_THRESHOLD && result.opponentDmg > 0) {
    const cap = Math.ceil(opponentHP * SHIELD_RATIO)
    result.opponentDmg = Math.min(result.opponentDmg, cap)
  }

  // === 蓄力标记更新（按第五节规则）===
  // 关键：有标记 + 蓄力被打断 → 保留原标记（不丢失）
  let newPlayerCharged = playerCharged
  if (playerAction === 'attack' && playerCharged) {
    newPlayerCharged = false             // 消耗标记
  } else if (playerAction === 'charge' && result.playerDmg === 0) {
    newPlayerCharged = true              // 蓄力成功（已有则保持，不叠加）
  }
  // charge 被打断时 newPlayerCharged 保持 playerCharged 原值（保留原标记）
  // defend/counter 时保持原值

  let newOpponentCharged = opponentCharged
  if (opponentAction === 'attack' && opponentCharged) {
    newOpponentCharged = false
  } else if (opponentAction === 'charge' && result.opponentDmg === 0) {
    newOpponentCharged = true
  }

  // === 僵局计数器更新 ===
  const noDamage = result.playerDmg === 0 && result.opponentDmg === 0
  const newConsecutiveNoDmg = noDamage ? gameState.consecutiveNoDamageRounds + 1 : 0
  const newTotalRounds = gameState.totalRounds + 1
  const bothCharged = newPlayerCharged && newOpponentCharged
  let newBothChargedStalemate = bothCharged ? gameState.bothChargedStalemate + 1 : 0

  // === 僵局机制应用 ===
  // 机制 A：连续无伤害回合 → 本回合结算即扣环境伤害，逐回合递增
  let envDmg = 0
  if (newConsecutiveNoDmg >= STALE_NO_DMG_LIMIT) {
    envDmg = STALE_ENV_DMG * (newConsecutiveNoDmg - STALE_NO_DMG_LIMIT + 1)
  }
  // 机制 C：双方蓄力标记僵局 → 清除双方标记，并重置计数器（periodic 清除）
  // 不重置会导致计数器永不归零、此后每回合都清标记，永久剥夺双蓄力窗口
  if (newBothChargedStalemate > BOTH_CHARGED_LIMIT) {
    newPlayerCharged = false
    newOpponentCharged = false
    newBothChargedStalemate = 0
  }

  // === HP 更新（clamp 到 0）===
  const newPlayerHP = Math.max(0, playerHP - result.playerDmg - envDmg)
  const newOpponentHP = Math.max(0, opponentHP - result.opponentDmg - envDmg)

  // === 胜负判定 ===
  let gameResult = null
  if (newPlayerHP <= 0 && newOpponentHP <= 0) {
    gameResult = 'draw'
  } else if (newPlayerHP <= 0) {
    gameResult = 'lose'
  } else if (newOpponentHP <= 0) {
    gameResult = 'win'
  } else if (newTotalRounds >= MAX_ROUNDS) {
    // 机制 B：总回合上限。双方都 ≤5 HP → 双败（避免极限拖延），否则按剩余 HP 比
    if (newPlayerHP <= 5 && newOpponentHP <= 5) gameResult = 'doubleLose'
    else if (newPlayerHP > newOpponentHP) gameResult = 'win'
    else if (newPlayerHP < newOpponentHP) gameResult = 'lose'
    else gameResult = 'draw'
  }

  return {
    ...result,
    envDmg,
    playerHP: newPlayerHP,
    opponentHP: newOpponentHP,
    playerCharged: newPlayerCharged,
    opponentCharged: newOpponentCharged,
    consecutiveNoDamageRounds: newConsecutiveNoDmg,
    totalRounds: newTotalRounds,
    bothChargedStalemate: newBothChargedStalemate,
    gameResult,
  }
}

// 蓄力加成 = 直接对表内伤害 ×2（无需辅助函数）。详见上方乘区 1 注释。
```

> **注意（已实现验证）**：蓄力加成对 **DAMAGE_TABLE 表内已减伤的值** 做 `× CHARGE_MULTIPLIER`，而不是从 `BASE_DAMAGE` 重算。
> - `attack vs defend`：表值 5 × 2 = **10** = `Math.ceil(12 × 2 × 0.4)` ✓
> - `attack vs attack`：表值 12 × 2 = **24** ✓
> - 整数倍率下与"严格乘区顺序"结果完全一致，且自动正确处理防御减伤。
>
> ⚠️ 早期设计曾用 `return BASE_DAMAGE × 2`（恒为 24），这会**丢掉防御减伤**，把"蓄力攻击打防御者"错算成 24（应为 10）。单元测试已覆盖此用例，实现请勿回退到 BASE 重算方案。
>
> **修正（蓄力攻击被克制）**：蓄力加成必须加 `result.opponentDmg > 0` 守卫。否则带蓄力标记的攻击撞上"反击"时（`attack/counter` 的 `opponentDmg` 本应为 0、攻击方吃 18 反击伤），`applyCharge` 会无条件把对手伤害写成 24，让反击成功的一方反而挨打。加守卫后：蓄力攻击被反击 = 攻击方吃 18、对手 0 伤、蓄力标记消耗（committed 攻击的代价），符合直觉。
>
> 但由于 `DAMAGE_TABLE` 中已包含防御减伤结果，为避免重复减伤，`resolveRound` 需要区分"基础伤害"和"已减伤伤害"。完整实现建议将 `DAMAGE_TABLE` 拆分为"基础伤害表"和"减伤判定"，由 `resolveRound` 统一按乘区顺序计算。MVP 阶段可保持现有 `DAMAGE_TABLE` + `applyCharge` 的简化方案，因为数值结果一致。

---

## 十六、页面视图设计

IronFistPage.vue 包含 4 个视图：

| 视图 | 条件 | 说明 |
|------|------|------|
| `lobby` | 默认 | 大厅：选择对战模式（人机/人人） |
| `inviting` | `gameStore.state === 'inviting'` | 等待对方接受邀请（仅 PvP） |
| `playing` | `route.query.role` 或 `mode === 'pve'` | 对战进行中 |
| `result` | 对战结束 | 展示胜负结果 |

### 大厅视图

大厅提供两个入口：

```
┌─────────────────────┐
│       🥊 铁拳        │
│   回合制心理博弈     │
├─────────────────────┤
│                     │
│  ┌───────────────┐  │
│  │  🤖 人机对战   │  │  ← 立即开始，无需联网
│  │  随时练习     │  │
│  └───────────────┘  │
│                     │
│  ┌───────────────┐  │
│  │  👥 好友对战   │  │  ← 需要邀请在线好友
│  │  实时 1v1     │  │
│  └───────────────┘  │
│                     │
├─────────────────────┤
│  游戏规则说明        │
│  4 种动作 + 克制关系 │
└─────────────────────┘
```

- **人机对战**：点击后直接进入 `playing`，`mode = 'pve'`，无需邀请流程
- **好友对战**：展开在线好友列表（复用 `friendApi.getFriends()`），点击好友 → 调用 `gameStore.invite()` 发起邀请
- 游戏规则说明（4 种动作 + 克制关系简表）

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

在 `backend/internal/ws/hub.go` 的 `dispatch` 方法中，`game_*` 类型已统一走 `handleGameRelay`，铁拳的消息需要新增处理：

```go
case "ironfist_action", "ironfist_state_sync", "ironfist_reconnect":
    h.handleGameRelay(c, msg.Type, msg.Payload)
```

> 注意：`ironfist_ready` 已从协议中删除，无需处理。

### 2. 胜场记录接口（MVP）

为支持进度系统，新增简单的胜场统计接口：

```go
// GET /api/games/ironfist/stats  → 获取当前用户胜场记录
// POST /api/games/ironfist/stats → 上报对局结果（win/lose/draw）
```

数据结构（可复用现有用户元数据表，无需新建表）：

```json
{
  "user_id": "xxx",
  "pvp_wins": 12,
  "pvp_losses": 5,
  "pvp_draws": 1,
  "pve_wins": 30,
  "pve_losses": 8,
  "max_win_streak": 7,
  "current_win_streak": 3
}
```

### 3. 其他

回合制游戏无其他持久化数据需求，游戏过程状态在前端维护。

---

## 十八、MVP 设计目标

这个版本只追求四点：

### 1. 可玩
- 能完整对战
- 有胜负
- 有僵局处理，不会出现永远打不完的局

### 2. 有心理博弈
- 玩家需要猜对手行为
- 四种动作各有克制关系

### 3. 有基本策略
- 防御 / 攻击 / 蓄力 / 反击之间有选择权
- 无单一最优策略

### 4. 有翻盘与进度反馈
- 残血强化 + 残血护盾提供翻盘窗口
- 胜场记录提供长期目标（见第二十节）

---

## 十九、进度系统（MVP）

为提升短期留存，MVP 阶段引入轻量进度系统：

### 1. 胜场记录

| 字段 | 说明 |
|------|------|
| PvP 胜/负/平 | 人人对战战绩 |
| PvE 胜/负/平 | 人机对战战绩 |
| 当前连胜 | 连续胜利次数 |
| 历史最高连胜 | 个人记录 |

- 数据存储在后端（复用用户元数据表），跨设备同步
- PvE 战绩也记录，方便玩家追踪练习进度

### 2. 大厅展示

在大厅页面顶部展示个人战绩卡片：

```
┌─────────────────────┐
│  🥊 战绩             │
│  PvP: 12胜 5负 1平   │
│  PvE: 30胜 8负       │
│  连胜: 3 🔥          │
└─────────────────────┘
```

### 3. 结果页上报

对战结束后，结果页自动上报战绩到后端，并展示战绩变化：

```
┌─────────────────────┐
│      🎉 胜利！       │
│                     │
│  PvP 战绩：13胜 5负  │
│  连胜：4 🔥          │
│                     │
│  [返回大厅]          │
└─────────────────────┘
```

### 4. 简单成就（可选，非必须）

| 成就 | 条件 |
|------|------|
| 初出茅庐 | 完成 1 场对战 |
| 百战不殆 | 累计 100 场对战 |
| 连胜达人 | 连胜 5 场 |
| 反击大师 | 单场反击成功 3 次 |
| 残血翻盘 | HP < 10 时获胜 |

成就仅本地存储，作为额外目标，不影响核心玩法。

---

## 二十、后续扩展方向（非 MVP）

| 方向 | 说明 |
|------|------|
| 状态系统 | 眩晕 / 破防 / 强化 |
| 连击系统 | 连续相同动作触发额外效果 |
| 技能系统 | 替换/增强基础动作 |
| NPC AI 学习 | 基于玩家行为历史调整概率 |
| 角色职业 | 不同角色有不同属性/技能 |
| 装备系统 | 影响属性和技能 |
| 暴击系统 | 10% 概率 ×1.5 伤害 |
| 气值系统 | 防御/反击消耗气值，攻击/蓄力回复气值 |
| 排行榜 | 全局胜率排名（MVP 仅个人战绩，无全局排名） |
| 回放系统 | 记录对战过程供复盘 |
| 角色定制 | 玩家自定义角色外观、皮肤、武器 |
| 动作捕捉 | 用真实动捕数据替换 Mixamo 通用动画 |
| 物理打击 | 布娃娃系统，受击物理反应 |

> 注：原"残血强化"已纳入 MVP（见第十节），此处移除。

---

## 二十一、总结

本 MVP 的核心：

> 用最少的 4 种动作 + 克制关系 + 风险收益设计 + 时间压力
> + 残血翻盘机制 + 僵局检测 + 状态感知 AI + 胜场记录
> + Babylon.js 3D 战斗场景 + Low Poly 美术 + 打击感动效
> 构建一个具有画面感与心理博弈深度的回合制 3D 格斗游戏

技术层面：

> Vue 3 + Quasar 负责 UI 与页面流程，Babylon.js 负责 3D 渲染
> 渲染分层：3D Canvas 底层 + 2D HUD 覆盖层，逻辑与渲染解耦
> 复用现有游戏邀请/通信架构，前端本地结算，服务端仅做消息中继
> 中端机 30 FPS 性能预算，低端机自动降级为 2D 模式

### 关键设计决策汇总

| 问题 | 解决方案 | 章节 |
|------|----------|------|
| 数值取整歧义 | 统一 `Math.ceil`，明确乘区顺序 | 第四节 |
| 蓄力标记丢失 | 被打断时保留原标记 | 第五节、第七节 |
| 无限平局 | 连续无伤害环境伤害 + 总回合上限 + 蓄力僵局清除 | 第九节 |
| 超时误消耗标记 | 超时默认防御 | 第八节 |
| 残局互秒 | 残血强化 + 残血护盾 | 第十节 |
| AI 行为不合理 | 状态感知概率模型 | 第十一节 |
| PvP 状态错位 | round 校验 + 状态同步 | 第十四节 |
| 断线无恢复 | 重连协议 + 30 秒超时判负 | 第十四节 |
| HP 负数显示 | 强制 clamp 到 0 | 第九节、第十五节 |
| 缺乏进度反馈 | 胜场记录 + 成就 | 第十九节 |
| 画面表现力不足 | Babylon.js 3D 引擎 + Low Poly 美术 | 第十二节 |
| 移动端性能压力 | 设备检测 + 自适应画质 + 2D 降级 | 第十三.6节 |
| 3D 资源加载 | 分阶段加载 + 会话缓存 + Draco 压缩 | 第十三.5节 |
| 逻辑与渲染耦合 | 渲染分层架构，IronFistGame 只管状态机 | 第十三节 |

### 漏洞修正记录（实现前 review）

| 漏洞 | 修正 | 章节 |
|------|------|------|
| 蓄力攻击被反击时算出 24 伤（应 0） | 蓄力加成加 `opponentDmg > 0` 守卫 | 第十五节 |
| 决胜回合文字"每回合+5"与代码"每5回合+5"不符 | 统一为逐回合递增 `5×(连续无伤回合−4)`，当回合结算即扣 | 第九节、第十五节 |
| 机制 B"双方≤5HP双败"未实现 | `resolveRound` 补 `doubleLose` 分支 | 第九节、第十五节 |
| `waiting_confirm` 一方挂机卡死全场 | 确认设 15s 超时 + 以 `round+1` 动作到齐为推进 barrier | 第十四节 |
| PvP 超时两端各判分叉致 HP 不一致 | 超时动作以发送方本地判定为唯一真相，收方放宽到 33s | 第十四节 |
| `game_resign`/退出战绩处理未定义 | 退出等同认输，各端本地结算后上报 | 第十四节 |
| `applyCharge` 返回 `BASE×2` 丢失防御减伤 | 改为对表内值 `×2`（5→10 而非 24），单测锁死 | 第十五节 |

### 代码 review 修正（一期实现后）

| 漏洞 | 影响 | 修正 |
|------|------|------|
| 伤害表不对称：`attack/charge.od=12≠charge/attack.pd=18`、`attack/counter.pd=18≠counter/attack.od=20` | **PvP 两端结算同回合得出不同 HP（desync）**；PvE 因"谁是 player"数值不公 | 统一为 §7 权威值（打断 18、反击 20），表恢复对称，已用脚本校验全 16 格 |
| 机制 C 计数器清标记后不归零 | 双蓄力一旦超 2 回合，此后**每回合都清标记**，永久剥夺双蓄力窗口 | 清标记时一并 `newBothChargedStalemate = 0`，改为每 3 回合周期性清除 |
| 对方认输 `game_resign` 只 emit gameover 不置 `GAME_OVER` | 对局已结束但本地倒计时/`selectAction` 仍可运行 | handler 内先 `_setPhase(GAME_OVER)` 再 emit |
| `lastResult` 跨回合不清除 | 新回合决策阶段信息栏显示上回合摘要，"选择你的动作"提示不出现 | round-start 时 `lastResult.value = null` |
| 蓄力失效期：174 行"下回合" vs 176 行"永不失效"矛盾，代码按永不失效 | 允许"蓄力 + 永久防御/反击留大"乌龟流，违背"无单一最优策略" | 统一为**最多保留 2 个可用回合**（`CHARGE_HOLD_LIMIT=2`），新增 `chargeUnused` 计时；引擎 state、PvP 同步字段同步补齐 |
| 平衡原则"单次有效伤害 ≤25% HP" | 实际最大单次 24~40，该表述与数值矛盾、误导 | 删除固定百分比表述，改为"满血不被秒杀 + 残血护盾兜底" |
| 缺少出招记录 | 心理博弈缺少复盘信息，看不到对手历史出招 | 对战界面新增横向滚动「出招记录」条（上=对手/下=你，胜负描边，最新在右）|
| 终局仍显示"下一回合"，点完才进结果页 | 对局已结束还要点"下一回合"，逻辑绕、易困惑 | 结算动画后若 `gameResult` 非空，跳过确认 barrier 直接进结果页（返回大厅）；中盘回合保留"下一回合" |

> 原"已知遗留"三条已全部清理（见下表）。剩余真正留到二期的是**完整断线重连**（当前 33s 宽限只做到"判定中断、不记胜负"，不做状态恢复续局）。

### 已知遗留清理（本轮）

| 原遗留 | 处理 |
|--------|------|
| ①PvP 对方久不发动作卡 LOCKED | 本地出招后启动 `OPPONENT_GRACE_MS=33s` 宽限计时；超时 → `gameover: 'aborted'`（对局中断，不记胜负），结果页提示"对手可能掉线"。对方动作送达即清除计时 |
| ②AI 持标记仍可能再蓄力 | `weights.charge += 10` 加 `!ai.charged` 守卫，已有标记时不再浪费回合蓄力（实测占比 0%）|
| ③蓄力打断蓄力 = 36/40 超上限 | 蓄力 ×2 封顶 `MAX_CHARGED_HIT = 24`，阻止"×2"与"打断 1.5× 惩罚"叠加；残血强化在其后另算仍可达 27（设计内）|

---

## 二十二、分期实施计划与动画演进路线

> 核心原则：**逻辑/网络/HUD 一次写好不再动，只有"战斗表现层"随期升级**。
> 三层视觉共享同一组动作语义（lunge/hit/charge/stagger/dodge/guard），
> 因此 2D → 2.5D → 3D 跨度平滑，玩家不会感到断层。

### 1. 渲染替换点（架构保证）

所有视觉表现集中在一个组件 `components/BattleArena.vue`，对外接口固定：

```
props: {
  result,          // 最近一次结算结果（驱动对战动画）
  playerCharged,   // 玩家蓄力光环
  opponentCharged, // 对手蓄力光环
  playerEmoji / opponentEmoji  // 角色外观（后期换成精灵/模型句柄）
}
```

升级 = 新建 `BattleArena25D.vue` / `BattleArena3D.vue` 实现同一组 props，在 `IronFistPage.vue` 里按性能分级选择挂载哪个。`IronFistGame.js`、`GameNet.js`、HUD 组件、后端**全部零改动**。

### 2. 三期演进

| 阶段 | 视觉形态 | 人物表现 | 工作量 | 状态 |
|------|----------|----------|--------|------|
| **一期** | 2D-CSS | emoji 角色 + CSS 位移/受击闪白/蓄力光环/屏幕震动/伤害数字 | ~1 周 | ✅ 已完成 |
| **二期** | 2.5D 精灵 | 序列帧立绘（每动作 4~8 帧），billboard 站位，受击/蓄力/反击各一套帧动画 | ~1.5 周 + 选素材 | 待开始 |
| **三期** | 3D | Babylon.js Low Poly 角色 + 骨骼动画（见第十二节动作清单），镜头/粒子/后处理 | ~3~6 周（强依赖美术） | 待开始 |

### 3. 人物动作的逐期对应（保证不断层）

| 动作语义 | 一期 2D-CSS | 二期 2.5D 帧 | 三期 3D 骨骼 |
|----------|------------|-------------|-------------|
| 攻击 lunge | translateY 前冲 | 4 帧出拳序列 | Attack 动画 0.6s |
| 受击 hit | 闪白 + 晃动 | 2 帧后仰 | Hit 动画 0.5s |
| 蓄力 charge | 上下浮动 + 黄色光环 | 蓄力发光循环帧 | Charge 1.0s + 粒子 |
| 蓄力被打断 stagger | 灰度 + wobble | 踉跄帧 | Stagger 0.6s |
| 反击 dodge | 侧移 + 旋转 | 闪避残影帧 | Counter 0.8s + 慢动作 |
| 防御 guard | 缩放 + 蓝光 | 举盾帧 | Defend 0.4s |

### 4. 开源素材来源（全部允许商用，注意逐一核对授权）

| 类型 | 推荐来源 | 授权 | 用于 |
|------|----------|------|------|
| 2.5D 像素格斗精灵 | itch.io（搜 "fighter sprite CC0"）、OpenGameArt、Kenney.nl | CC0 / CC-BY | 二期 |
| 3D Low Poly 人物 | Quaternius、Kenney、Sketchfab（筛 CC 协议） | CC0 / CC-BY | 三期 |
| 3D 骨骼动作动画 | Mixamo（免费，含格斗动作捕捉，可重定向） | Adobe 免费授权 | 三期 |
| 粒子贴图 | OpenGameArt、Kenney Particle Pack | CC0 | 二/三期 |
| 音效（打击/蓄力/胜负） | Freesound（筛 CC0）、Kenney Audio | CC0 / CC-BY | 二/三期 |
| Skybox / 场景 | Poly Haven（HDRI/CC0）、OpenGameArt | CC0 | 三期 |

> 授权合规：CC-BY 需在应用「关于/致谢」页署名作者；CC0 无需署名但建议记录来源。Mixamo 角色/动画用于 App 内是允许的，但不可单独再分发模型文件。
