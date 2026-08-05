# 铁拳（Iron Fist）现行开发规格

> 版本：v2.0（2026-08-05）  
> 状态：现行唯一规格  
> 适用版本：中国版；奖励、余额、流水均为站内积分。

## 1. 规范边界

本文以当前 `main` 分支实现为准。服务端权威引擎决定线上对局、奖励、战绩和结算；客户端只提交动作意图并渲染服务端结果。

以下内容不属于现行能力：`$FIST`、Solana、SPL Token、Anchor、NFT、链上销毁、质押分红、DAO、国际版经济模型，以及客户端提交结果后结算的旧流程。历史方案不得作为开发或结算依据。

实现入口：

- 前端：`frontend/src/games/ironfist/`
- 规则引擎：`backend/internal/ironfistengine/`
- 权威服务：`backend/internal/service/ironfist_authority*.go`、`ironfist_deadlines.go`、`ironfist_settlement.go`
- HTTP/WebSocket：`backend/internal/handler/ironfist.go`、`backend/internal/ws/`
- 数据库迁移：`backend/migrations/021_ironfist_authority.sql`

## 2. 产品模式

| 模式 | 是否联网 | 是否影响可信状态 | 是否奖励积分 |
|---|---:|---:|---:|
| 练习 `practice` | 否 | 否 | 否 |
| 奖励 PvE `pve` | 是 | 是 | 胜局奖励 |
| 计分 PvP `pvp` | 是 | 是 | 依房间规则结算 |
| 好友 PvP `friend` | 是 | 是（战绩/成就） | 否 |

离线模式只能使用 JavaScript 本地规则引擎练习；线上模式必须有服务端签发的 `game_id`，不能回退到本地结算。

## 3. 权威边界

MySQL 是可信状态唯一来源。Redis 只用于在线状态、通知、限流和临时缓存；Redis 丢失不得改变对局结果或积分。

客户端不得提交或决定：HP、伤害、对手动作、结果、奖励、手续费、截止时间或 AI seed。客户端提交的动作格式为：

```json
{
  "round": 4,
  "action": "counter",
  "request_id": "uuid",
  "expected_version": 8
}
```

动作一经服务端接受即不可修改；对手动作在回合结算前不可见。相同 `request_id` 重试返回原响应。

## 4. 游戏规则 v1

初始状态：双方 HP=100；动作：`attack`、`defend`、`charge`、`counter`；每回合决策 30 秒。

基础伤害表（行方受到伤害 / 列方受到伤害）：

| 我方\\对手 | attack | defend | charge | counter |
|---|---:|---:|---:|---:|
| attack | 12 / 12 | 0 / 5 | 0 / 18 | 20 / 0 |
| defend | 5 / 0 | 0 / 0 | 0 / 0 | 0 / 8 |
| charge | 18 / 0 | 0 / 0 | 0 / 0 | 0 / 8 |
| counter | 0 / 20 | 8 / 0 | 8 / 0 | 8 / 8 |

补充规则：

- 已蓄力的攻击伤害乘 2，最高 24；攻击后消耗蓄力。
- 蓄力被打断不清除已有蓄力；蓄力最多携带两个未消耗回合，之后失效。
- 攻击方 HP<30 时该次伤害乘 1.1，向上取整。
- 被攻击方 HP<20 时，单次伤害不超过当前 HP 的 60%，向上取整。
- 连续 5 回合双方无真实伤害时，双方承受环境伤害：5、10、15……；产生真实伤害后归零。
- 双方同时蓄力超过 2 回合时，结算阶段清除双方蓄力标记并重置计数。
- 第 20 回合仍未结束：HP 高者胜；相同为平局；双方 HP≤5 为 `doubleLose`。
- HP 始终 clamp 到 0；同时归零为平局。

规则实现必须由 Go `ironfistengine` 和前端 practice resolver 的 golden fixture 保持一致。线上结果只采用 Go 引擎结果。

## 5. PvE

1. 客户端请求 `POST /games/ironfist/pve/sessions`，服务端生成私有随机 seed 和初始状态。
2. 每个账号最多一个奖励 PvE session；刷新/重连通过 active session 恢复。
3. AI 动作由服务端基于私有 seed、规则版本、回合和状态确定性生成，seed 在对局结束前不下发。
4. 30 分钟无活动自动放弃且无奖励；显式开始新局会放弃旧局。
5. 每个 UTC 日前 10 场胜利奖励 500 积分；第 10 场另加既有 1000 积分奖励；之后只记可信战绩，不再发积分。
6. 已发放积分不追缴；旧版待领取奖励在迁移时作废。

## 6. PvP 与好友对战

匹配房间继续使用现有 `ironfist_pvp_rooms` 托管入场积分。匹配成功后，同一事务创建一个权威 `ironfist_games` 并关联房间；好友对战创建无押注的 `friend` 游戏。

- 首个合法动作按座位锁定，重复或冲突动作返回 `409 action_locked`。
- 在线玩家 30 秒未行动，服务端写入 `defend`。
- 断线玩家暂停其剩余行动时间并获得 60 秒重连窗口；超时即弃权。
- 双方都在重连窗口内断开并同时到期，结果为平局并按平局费率处理。
- 主动认输立即判负。
- 对局完成后自动写入战绩、成就、积分账本、房间结算和 outbox 事件；不存在客户端触发结算。

押注结算：胜负手续费 5%，平局/双败手续费 2.5%；手续费账分为 `fee_burn` 与 `fee_treasury` 两部分，当前仅站内记账，不进行链上转账或销毁。

## 7. HTTP API

- `POST /games/ironfist/pve/sessions`：创建或显式替换奖励 PvE session。
- `GET /games/ironfist/sessions/active`：恢复当前奖励 PvE。
- `GET /games/ironfist/games/:id`：读取参与者可见的权威状态。
- `POST /games/ironfist/games/:id/actions`：提交动作。
- `POST /games/ironfist/games/:id/resign`：认输/放弃。
- `POST /games/ironfist/pvp/queue`、`DELETE`、`GET`：撮合队列。
- `GET /games/ironfist/stats`、`GET /games/ironfist/matches`：读取可信战绩。

错误语义：400 参数错误，403 非参与者，404 不存在，409 状态冲突，410 session 过期。旧 `POST /games/ironfist/stats` 和 `POST /fist/pve-reward` 已禁用，返回 `upgrade_required`。

## 8. WebSocket 通知

WebSocket 只传递通知，不承载权威状态：

- `ironfist_game_ready`
- `ironfist_player_locked`
- `ironfist_round_resolved`
- `ironfist_presence_changed`
- `ironfist_game_finished`

每个事件包含 `game_id`、状态版本、服务端时间和适用截止时间。客户端丢弃旧版本；发现版本间隙时重新 GET 权威状态。

## 9. 数据与结算要求

权威表包括 `ironfist_games`、`ironfist_game_actions`、`ironfist_game_rounds`、`ironfist_active_pve` 和事务 outbox。`ironfist_matches`、`ironfist_stats`、`ironfist_achievements`、`fist_accounts`、`fist_transactions` 是结算事务内更新的投影/账本。

所有状态变更必须在锁定游戏行后完成：推进逾期状态、校验版本、写入不可变动作、回合结算、持久化状态、终局结算、写 outbox，最后提交事务再发布通知。结算账本使用唯一 settlement reference 防止重试重复发放。

账号删除必须先处理相关进行中对局，再在同一事务中删除用户关联数据；服务端失败时回滚，前端只有收到成功确认后才清除恢复材料。

## 10. 测试与发布门槛

必须覆盖：16 个动作组合、蓄力老化/打断/消耗、残血强化与护盾、环境伤害、双蓄力清除、同时击倒、20 回合结算、重复动作、并发结算、截止时间、断线重连、PvE 日上限、账号删除和旧数据迁移。

当前验证命令：

```text
cd backend && go test ./...
cd frontend && npm run test:ironfist
cd frontend && npm run lint
cd frontend && npm run build
```

发布前必须确认：没有可信前端路径调用结果上报、PvP 客户端结算或 PvE 客户端领奖；MySQL 迁移已执行；旧开放房间已退款；旧待领奖励已失效。

## 11. 历史资料

旧版 `$FIST` 经济模型、客户端本地 PvP 结算、Redis action replay、双上报仲裁和国际版 NFT/质押方案均为历史资料。若未来重新评审，必须另立版本化设计并重新完成合规、安全、经济模型和测试评审；不得恢复旧代码路径作为默认实现。
