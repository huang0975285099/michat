# Iron Fist 龙虎斗玩法开发文档

## 1. 文档状态

- 状态：产品规则已确认，可进入开发
- 玩法名称：龙虎斗（Dragon Tiger）
- 所属模块：Iron Fist
- 目标目录：`frontend/src/games/ironfist`
- 核心原则：服务端权威、服务器时间、可验证公平、积分事务一致、循环自动开局

## 2. 玩法概述

龙虎斗是一个玩家与平台对赌的公开观战玩法。每轮由服务端控制龙（红方）和虎（蓝方）两个属性相同的 AI 自动进行 Iron Fist 对战。玩家在下注期内选择龙胜、虎胜或平局并使用积分下注。

每轮依次经过下注、封盘、自动对战、原子结算和结果展示，之后自动创建下一轮。所有在线用户看到同一轮、同一倒计时、同一战斗过程和同一结果。

该玩法不改变现有 PvE、PvP 和好友 PK 的规则、统计或积分结算。

## 3. 已确认产品规则

### 3.1 时间与状态

| 阶段 | 服务端状态 | 时间 | 行为 |
|---|---|---:|---|
| 下注 | `betting` | 固定 60 秒 | 接受首次下注和同方向加注 |
| 封盘/生成战报 | `locked` | 瞬时状态 | 拒绝下注，生成完整权威战报 |
| 自动对战 | `playing` | 最多 20 秒 | 所有客户端按统一时间轴播放 |
| 结算 | `settling` | 不设展示时长 | 服务端事务结算；失败自动重试 |
| 结果展示 | `settled` | 固定 10 秒 | 展示结果、收益和开奖记录 |
| 无效局 | `voided` | 固定 10 秒 | 完成退款后展示无效原因 |

上一轮成功结算或退款并展示 10 秒后，立即开启下一轮。不能按固定墙钟周期盲目创建新轮次，以免结算故障时出现重叠轮次。

所有阶段边界由数据库中的服务端时间确定。前端倒计时仅显示：

```text
remaining_ms = max(0, phase_ends_at - estimated_server_now)
```

前端本地计时器不得决定是否接受下注、是否开战或是否结算。

### 3.2 下注规则

- 下注选项：`dragon`（龙胜）、`tiger`（虎胜）、`draw`（平局）。
- 固定赔率：龙 1.95、虎 1.95、平 8.00。
- 赔率写死在版本化服务端规则中，不提供后台配置。
- 最低首次下注和单次加注均为 20 积分。
- 金额必须是 20 的整数倍。
- 单用户每轮累计下注最高 10,000 积分。
- 每轮首次下注后不可取消，不可更换选项，只能对原选项加注。
- 每次下注/加注成功后立即扣除可用积分并写入积分流水，不使用单独的冻结余额。
- 余额不足、轮次不处于下注期、累计超限、金额格式错误或尝试换边时，整笔请求失败；不做部分接受。
- 用户离开页面、掉线或退出登录不影响已下注记录及自动结算。
- 平台不设置单轮总投注额或总赔付上限。

### 3.3 派奖规则

中奖返还包含本金：

```text
龙/虎中奖返还 = 累计下注 × 195 / 100
平局中奖返还 = 累计下注 × 8
未中奖返还 = 0
```

因为所有下注金额都是 20 的整数倍，龙/虎的 1.95 倍返还始终为整数。实现必须使用整数运算，禁止使用浮点数计算积分。

示例：押龙 100，龙胜后返还 195，净收益 95。

### 3.4 对战规则

- 龙、虎初始血量均为 100。
- 沿用现有 Iron Fist 的攻击、防御、蓄力、反击、残血增强、残血护盾和僵局处理语义。
- 龙虎斗使用独立规则版本，最终伤害为普通规则伤害的 2 倍。
- 龙、虎使用完全相同的 AI 权重和基础属性。
- 每回合双方只读取该回合开始时的共同状态来决策，不能让后计算的一方看到对手本回合动作。
- 单场最多 10 个战斗回合。
- 任意一方血量先降到 0 时，对方获胜。
- 同一回合双方同时降到 0 时判平。
- 打满 10 回合后，剩余血量较高的一方获胜；血量相同判平。
- 系统异常属于无效局退款，不得记为平局。
- 不得根据任一选项的投注金额、人数或潜在赔付改变 AI 行为、随机种子或结果。

### 3.5 历史记录

所有轮次永久保存在数据库中，列表按最新优先进行游标分页。主页面展示最近记录，完整历史可继续加载。

每轮至少保存和展示：

- 轮次 ID、规则版本和状态。
- 开放下注、封盘、开战、结束、结算时间。
- 龙/虎标识、每回合动作、伤害、血量和最终血量。
- 最终结果：龙胜、虎胜、平局或无效退款。
- 三方累计下注额、中奖人数和结算状态。
- 随机种子承诺值；结果公布后提供原始种子。
- 当前用户的选择、累计本金、赔率、返还额和净收益。

历史公共数据不得泄露其他用户身份或个人下注明细。

## 4. 可验证公平

### 4.1 Commit-Reveal

1. 创建下注轮次时，服务端使用密码学安全随机源生成 32 字节 `server_seed`。
2. 服务端计算承诺：`seed_commitment = SHA-256(server_seed)`。
3. 下注期只公开 `seed_commitment`，不公开 `server_seed`。
4. 封盘后使用确定性 PRNG 从 `server_seed + round_id + rules_version` 派生本轮随机流。
5. 所有 AI 随机选择按规范中的固定顺序消费随机流。
6. 结果成功结算后公开 `server_seed` 和战报。
7. 客户端或独立工具可复算承诺、动作和结果。

`server_seed` 必须在下注开放前生成并持久化。不得在看到投注分布后生成或替换。数据库仅允许在轮次创建时写入；后续业务代码不提供更新路径。

### 4.2 确定性要求

- 服务端实现专用确定性 PRNG，不依赖 Go map 遍历顺序或平台相关浮点行为。
- AI 权重使用整数。
- 固定动作枚举和抽样顺序：`attack`、`defend`、`charge`、`counter`。
- 固定每回合随机消费顺序：先龙、后虎。
- 双方动作完成后再一起解析该回合。
- 战报保存随机流位置或每步派生索引，便于审计。
- `rules_version` 决定伤害表、AI 权重、最大回合和 PRNG 算法，旧版本永不就地修改。

## 5. 服务端状态机

```text
betting --封盘--> locked --生成战报--> playing --到达播放结束时间--> settling
   ^                                                               |
   |                                                               v
   +---------------- settled + 10 秒 <----原子派奖成功--------------+
   |
   +---------------- voided  + 10 秒 <----原子退款成功----异常------+
```

允许的状态迁移必须使用条件更新或锁行事务完成。任何 worker 都可以重试，但每个迁移只能生效一次。

推荐使用数据库作为权威时钟：在事务中读取 `UTC_TIMESTAMP(3)`，或保证应用节点时钟同步后将同一个 `now` 参数贯穿整笔事务。禁止先在应用层判断截止时间、稍后再无条件写入。

## 6. 数据模型

建议新增独立表，不把平台公共轮次伪装成现有 `ironfist_games` 的双用户游戏。表名可在实现时跟随仓库命名约定调整。

### 6.1 `ironfist_dragon_tiger_rounds`

| 字段 | 建议类型 | 说明 |
|---|---|---|
| `id` | `BIGINT UNSIGNED PK` | 轮次 ID |
| `status` | `ENUM` | `betting/locked/playing/settling/settled/voided` |
| `state_version` | `BIGINT UNSIGNED` | 每次状态改变递增 |
| `rules_version` | `SMALLINT UNSIGNED` | 本轮规则版本 |
| `seed_commitment` | `BINARY(32)` | 下注期公开的哈希 |
| `server_seed` | `BINARY(32)` | 结算后才通过 API 公开 |
| `battle_json` | `JSON NULL` | 完整权威战报 |
| `result` | `ENUM NULL` | `dragon/tiger/draw/void` |
| `void_reason` | `VARCHAR(64) NULL` | 无效原因代码 |
| `dragon_bet_total` | `BIGINT UNSIGNED` | 公共汇总 |
| `tiger_bet_total` | `BIGINT UNSIGNED` | 公共汇总 |
| `draw_bet_total` | `BIGINT UNSIGNED` | 公共汇总 |
| `winning_user_count` | `INT UNSIGNED` | 中奖人数 |
| `betting_started_at` | `DATETIME(3)` | 下注开始 |
| `betting_ends_at` | `DATETIME(3)` | 权威封盘点 |
| `battle_started_at` | `DATETIME(3) NULL` | 动画统一起点 |
| `battle_ends_at` | `DATETIME(3) NULL` | 动画统一终点，最长 20 秒 |
| `settled_at` | `DATETIME(3) NULL` | 原子结算完成时间 |
| `display_ends_at` | `DATETIME(3) NULL` | 结果展示截止时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |

约束和索引：

- 同一时刻最多一个非终态轮次；可通过单行 `scheduler` 锁或 MySQL advisory lock 保证，而不是依赖不完整的条件唯一索引。
- `INDEX(status, betting_ends_at)`、`INDEX(status, battle_ends_at)`、`INDEX(status, display_ends_at)` 用于 worker 扫描。
- 已公开结果的轮次不得更改 `rules_version`、种子、战报或结果。

### 6.2 `ironfist_dragon_tiger_bets`

| 字段 | 建议类型 | 说明 |
|---|---|---|
| `id` | `BIGINT UNSIGNED PK` | 投注聚合记录 ID |
| `round_id` | `BIGINT UNSIGNED FK` | 轮次 |
| `user_id` | `BIGINT UNSIGNED FK` | 用户 |
| `selection` | `ENUM` | `dragon/tiger/draw`，首次下注后不可变 |
| `stake_amount` | `BIGINT UNSIGNED` | 本轮累计本金 |
| `payout_amount` | `BIGINT UNSIGNED` | 最终返还 |
| `status` | `ENUM` | `active/won/lost/refunded` |
| `settled_at` | `DATETIME(3) NULL` | 结算时间 |
| `created_at` | `DATETIME(3)` | 首次下注时间 |
| `updated_at` | `DATETIME(3)` | 最近加注时间 |

必须有 `UNIQUE(round_id, user_id)`。同一用户同轮只有一条聚合记录，从数据结构上禁止换边和多选。

### 6.3 `ironfist_dragon_tiger_bet_commands`

用于 HTTP 重试幂等，建议保存：

- `request_id CHAR(36)` 主键或与 `user_id` 组成唯一键。
- `round_id`、`user_id`、`amount`。
- `response_json`，用于同请求重放相同响应。
- `created_at`。

相同 `request_id` 且参数相同返回首次成功结果；相同 ID 但参数不同返回 `409 idempotency_conflict`。

### 6.4 积分流水扩展

现有 `fist_transactions.type` 是 ENUM，需要迁移新增：

- `dragon_tiger_bet`：下注/加注扣款，负数。
- `dragon_tiger_payout`：中奖返还，正数。
- `dragon_tiger_refund`：无效局退款，正数。

继续使用现有 `settlement_ref` 唯一约束。推荐引用：

```text
下注：dt:bet:{round_id}:{request_id}
派奖：dt:payout:{round_id}:{user_id}
退款：dt:refund:{round_id}:{user_id}
```

### 6.5 公共事件 Outbox

现有 `ironfist_outbox` 外键依赖 `ironfist_games.game_id`，不应直接塞入龙虎斗事件。新增通用或专用 outbox，例如 `ironfist_dragon_tiger_outbox`，事务提交后发布到 Redis，再由 WebSocket hub 广播。

事件只保存可丢弃通知；MySQL 快照始终是恢复真相。

## 7. 并发与事务设计

### 7.1 下注和第 60 秒封盘竞争

这是实现中的最高风险边界。推荐所有下注按以下顺序在单个数据库事务中执行：

1. 根据请求中的 `round_id` 使用 `SELECT ... FOR UPDATE` 锁定轮次。
2. 在同一事务中取得权威 `now`。
3. 仅当 `status = betting AND now < betting_ends_at` 时继续。
4. 检查/写入 `bet_commands.request_id`，处理重试。
5. 锁定用户 `fist_accounts` 行和本轮用户投注行。
6. 校验金额为 20 的正整数倍、余额充足、累计不超过 10,000。
7. 已有投注时校验 `selection` 完全一致。
8. 扣余额、更新累计投注、写积分流水、更新轮次汇总。
9. 提交并返回新的余额和投注快照。

封盘 worker 同样先 `SELECT ... FOR UPDATE` 锁定该轮。由数据库锁获取顺序决定先后：

- 下注事务先拿到轮次锁并在截止时间前通过校验：下注成功，封盘随后会包含该注。
- 封盘先拿到锁，或下注拿到锁时 `now >= betting_ends_at`：下注返回 `409 betting_closed`，不得扣款。

不要用“先 UPDATE 账户，再检查轮次”的顺序；也不要只依赖定时任务是否已经把状态改成 `locked`。即使 worker 延迟，`betting_ends_at` 也必须独立封住迟到下注。

### 7.2 首次下注与并发加注

`UNIQUE(round_id, user_id)` 配合锁行/重复键重试保证同轮单选。账户、投注和轮次汇总必须在同一事务更新。统一锁顺序为：轮次 → 账户 → 投注，降低死锁概率。死锁可有限次数重试，但复用同一 `request_id`。

### 7.3 封盘和生成战报

封盘使用条件状态迁移并递增 `state_version`。完整战报可在短事务内确定性生成；若生成耗时不可控，则先原子改为 `locked`，事务外计算，再以 `status=locked` 和预期版本条件写入。相同种子与规则必须生成字节等价结果。

战报写入成功后设置 `battle_started_at`、`battle_ends_at` 并改为 `playing`。多 worker 重复执行只能得到同一战报，且仅一个状态更新成功。

### 7.4 原子结算

结算 worker 锁定轮次并将 `playing` 条件迁移到 `settling`。建议按投注主键分页、固定顺序锁账户，以控制事务规模并减少死锁；但如果采用分批结算，结果不得提前公开，且必须有持久化批次进度和最终核对。预计单轮投注规模可控时，首版优先整轮单事务：

1. 锁定轮次及本轮全部投注。
2. 按 `user_id` 升序锁定相关账户。
3. 整数计算每位用户的返还。
4. 更新中奖账户及 `total_earned`，写唯一派奖流水。
5. 将所有投注更新为 `won/lost`。
6. 写结果、中奖人数、`settled_at`、`display_ends_at`。
7. 插入 outbox 事件。
8. 将轮次置为 `settled` 后提交。

事务成功后客户端才可获取 `result`、`server_seed` 和最终余额。重试依靠轮次状态、投注状态和唯一 `settlement_ref` 防止重复派奖。

### 7.5 无效局退款

以下情况进入 `voided` 退款流程：

- 服务重启后无法恢复种子或权威状态。
- AI 执行错误、战报不完整或规则版本不可用。
- 种子承诺、原始种子和战报校验不一致。
- 20 秒内无法产生合法结果。
- 持续数据库错误导致无法正常权威结算。

退款与状态落库在同一事务完成；每个用户返还全部本金并写唯一退款流水。无效局不是平局，不使用 8 倍赔率。

## 8. 调度与高可用

在现有 Iron Fist deadline/outbox 后台循环旁增加龙虎斗 scheduler，建议每 250–500ms 扫描到期状态。多实例部署时使用 `FOR UPDATE SKIP LOCKED`、advisory lock 或专用 scheduler 单行锁竞争工作，不能依赖单机内存定时器。

启动和周期自愈逻辑：

- 没有当前轮次：创建一个 `betting` 轮次。
- `betting` 已过期：封盘。
- `locked`：确定性生成或恢复战报。
- `playing` 已到 `battle_ends_at`：结算。
- `settling`：继续幂等结算或按明确恢复策略退款。
- `settled/voided` 已到 `display_ends_at`：创建下一轮。

任意节点重启后只需读取 MySQL 即可恢复，不依赖 Redis 或进程内状态。Redis、WebSocket 事件丢失不影响账务和轮次推进。

## 9. HTTP API 草案

所有接口均位于已认证路由 `/api/games/ironfist/dragon-tiger`。

### 9.1 当前快照

`GET /current`

返回当前轮次、`server_time`、阶段截止时间、种子承诺、公共投注汇总、战斗公开进度、当前用户投注和余额。下注期及对战期绝不能返回 `server_seed` 或未到播放时间的未来动作。

如果前端需要一次性获得完整战报以同步动画，API 可以在 `playing` 返回战报，但这会提前暴露最终结果。推荐按服务端时间只释放已经发生的回合，或返回加密/分段事件；首版最简单安全的方案是通过快照返回 `revealed_rounds`，结果结算后再返回完整战报。

### 9.2 下注/加注

`POST /rounds/:round_id/bets`

```json
{
  "request_id": "uuid",
  "selection": "dragon",
  "amount": 100
}
```

成功返回累计投注、扣款后余额、轮次版本和服务器时间。建议错误码：

- `invalid_amount`
- `invalid_selection`
- `insufficient_balance`
- `betting_closed`
- `selection_locked`
- `round_limit_exceeded`
- `stale_round`
- `idempotency_conflict`

### 9.3 历史列表

`GET /rounds?before_id=&limit=20`

`limit` 最大 100。返回公共开奖记录及当前用户投注摘要；不返回其他用户个人信息。

### 9.4 战报详情

`GET /rounds/:round_id`

仅对已结算/已退款轮次返回完整种子和战报。未结算时按当前服务器时间裁剪可见动作。

## 10. WebSocket 事件草案

- `ironfist_dragon_tiger_round_opened`
- `ironfist_dragon_tiger_bet_totals_changed`
- `ironfist_dragon_tiger_locked`
- `ironfist_dragon_tiger_battle_started`
- `ironfist_dragon_tiger_round_revealed`
- `ironfist_dragon_tiger_settled`
- `ironfist_dragon_tiger_voided`

所有事件携带：

```json
{
  "event_id": "uuid",
  "round_id": 123,
  "state_version": 8,
  "server_time": "2026-09-02T12:00:00.000Z",
  "type": "ironfist_dragon_tiger_settled",
  "payload": {}
}
```

事件面向所有已认证且订阅该玩法的连接广播。前端丢弃较小 `round_id` 或不大于当前 `state_version` 的重复/旧事件；发现版本跳跃时立即 `GET /current`，不得猜测缺失状态。下注结果只认 HTTP 响应，不能把 WebSocket 通知当作成功凭证。

## 11. 前端设计

### 11.1 接入方式

- 在 `IronFistLobby.vue` 增加“龙虎斗”入口。
- 在 `IronFistPage.vue` 增加独立 `dragon-tiger` 视图，或增加子路由 `/games/ironfist/dragon-tiger`。
- 推荐新增 `components/dragon-tiger/`，避免继续扩大主页面。
- 在 `frontend/src/services/api.js` 的 `ironfistApi` 中加入 current、bet、history、detail 方法。
- 在现有 WebSocket store/hub 消息分发中加入龙虎斗事件处理。

建议组件：

```text
DragonTigerPage.vue
├── DragonTigerHeader.vue       服务器倒计时、轮次、阶段
├── DragonTigerArena.vue        龙/虎统一时间轴战斗
├── DragonTigerBetPanel.vue     三方选择、金额、加注
├── DragonTigerMyBet.vue        本轮累计下注、预计返还、余额
├── DragonTigerRoadmap.vue      最近开奖结果走势
└── DragonTigerHistory.vue      分页历史和战报入口
```

### 11.2 下注交互

- 未下注时可选择龙、虎、平，输入或快捷选择 20 的倍数。
- 首次成功后锁定选择，其他两个选项永久禁用到下一轮。
- 主按钮变为“继续加注”，明确显示本轮累计金额和中奖返还。
- 请求发送期间禁用重复点击；网络超时使用同一 `request_id` 重试。
- 不做乐观扣款，必须以服务端响应更新余额和投注。
- 收到 `betting_closed` 时立即拉取 `/current` 并切换封盘状态。
- 页面离开提示“已下注不会取消，将自动结算”，但不阻止离开。

### 11.3 时间同步

每次 HTTP 响应和 WebSocket 事件都带 `server_time`。客户端估算偏移量，并用 `performance.now()` 平滑倒计时。定期获取 `/current` 校正；切到后台再返回时立即校正。

倒计时显示归零不等于本地立即开战。前端进入等待封盘状态，直到收到新版本事件或快照。这样不会把网络延迟误显示为仍可下注。

### 11.4 战斗同步

- 使用 `battle_started_at` 和服务端时间计算当前动画位置。
- 新进入、刷新或重连时直接跳到当前应播放的回合。
- 客户端动画、帧率和音效不参与结果计算。
- 结果公布前不得从响应字段、动画队列长度或资源加载路径推断最终结果。
- 低性能设备可跳过动画并按时间显示已公开状态，不阻塞结算。

## 12. 安全与风控

- 所有下注接口要求有效登录身份，不接受客户端传入 `user_id`。
- 使用严格 JSON 解码并拒绝未知字段。
- 对下注接口做按用户速率限制，但不得以限流替代事务校验。
- 日志记录 `round_id`、用户内部 ID、`request_id`、状态版本和错误码；不得记录会在结算前泄露的原始种子。
- 管理员和运维接口在结算前也不得读取原始种子或完整未来战报。
- 公共历史不显示用户 ID、chat ID、昵称或个人金额。
- 账号删除时，已扣款未结算的投注不能简单级联删除；必须先完成正常结算或无效退款，再按账户删除政策处理历史匿名化。
- 对单用户投注频率、异常重试和多账户行为保留审计指标。

## 13. 监控与告警

至少增加以下指标：

- 当前轮次、状态和状态停留时长。
- 下注成功/拒绝数量及错误码分布。
- 每个选项的总本金、总返还和平台净值变化。
- 封盘延迟、战报生成耗时、结算耗时。
- 结算重试、退款局和无效原因。
- outbox 未发布数量、最大积压时间和 WebSocket 发布失败。
- 积分账本与投注表对账差异。

若轮次停留超过预期、结算持续失败、种子验证失败或账务对账不平，必须告警并停止创建新轮次，优先保护积分一致性。

## 14. 测试计划

### 14.1 规则与确定性单元测试

- 相同种子和规则版本生成完全相同的双方动作、伤害和结果。
- 龙虎交换身份进行大样本模拟，胜率差异应处于预设统计容差。
- 2 倍伤害、蓄力、护盾、反击和环境伤害顺序正确。
- 同回合双 KO、10 回合血量比较和同血平局正确。
- 20 的倍数在 1.95 倍赔率下始终整数结算。

### 14.2 下注并发集成测试

- 在 `betting_ends_at` 前后并发下注，只有持锁后权威时间仍早于截止点的请求成功。
- 封盘 worker 与下注请求同时锁轮次，不发生扣款后漏记投注。
- 同用户两个首次下注请求选择不同选项，最多一个成功。
- 同用户并发加注后累计金额、账户扣款和轮次汇总一致。
- 相同 `request_id` 重试只扣款一次并返回相同结果。
- 达到 10,000 后继续加注完整拒绝。
- 余额不足时账户、投注、汇总和流水均无变化。

### 14.3 结算与恢复集成测试

- 多 worker 同时结算只派奖一次。
- 在派奖事务任意步骤注入失败，事务回滚且重试后正确完成。
- 服务在每个状态重启均能从 MySQL 自动恢复。
- Redis 不可用、事件丢失或重复不影响轮次和余额。
- 无效局只退款本金，不按平局 8 倍派奖。
- 结算成功前 API 和事件不泄露结果或原始种子。
- 结算后种子承诺和完整战报可独立复算。

### 14.4 前端测试

- 首次下注后锁边，只能同方向加注。
- 网络超时重试复用请求 ID。
- 本地时钟快慢、标签页休眠和恢复不影响服务器阶段。
- WebSocket 断线、重复、乱序和版本缺口能通过 `/current` 恢复。
- 中途进入战斗能跳到正确回合。
- 历史分页无重复/遗漏，个人投注摘要准确。

## 15. 推荐实施顺序

1. 将现有 Iron Fist 规则提取/复用为服务端可版本化的 AI-vs-AI 确定性引擎。
2. 增加数据库迁移：轮次、投注、幂等命令、专用 outbox 和流水类型。
3. 实现轮次状态机、调度恢复和 commit-reveal。
4. 实现下注事务及第 60 秒并发测试。
5. 实现原子派奖、无效退款及故障注入测试。
6. 实现 HTTP 快照、历史、详情接口。
7. 实现 outbox、Redis 和 WebSocket 广播及断线补拉。
8. 增加大厅入口和独立龙虎斗前端页面。
9. 完成确定性、公平性、账务对账、压力和端到端测试。
10. 灰度上线，先验证轮次推进和模拟账务，再开放真实积分下注。

## 16. 验收标准

- 所有用户看到同一轮次、阶段、战斗过程和结果。
- 第 60 秒边界不存在封盘后成功下注或成功扣款但未入局的情况。
- 同轮不能取消、换边或累计超过 10,000，只能以 20 的倍数同方向加注。
- 任意请求重试、worker 重入、服务重启和 WebSocket 事件重复都不会重复扣款或派奖。
- 结果公布前无法从 API、事件或客户端资源获得原始种子和最终结果。
- 结果公布后可以用公开种子、规则版本和战报复算结果。
- 异常局全额退款，正常局按 1.95/1.95/8.00 整数精确结算。
- 全部历史可分页查询，个人记录与积分流水一致。
- 龙虎斗代码和配置不会改变现有 PvE/PvP/好友 PK 行为。
