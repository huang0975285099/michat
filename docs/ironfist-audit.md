# 铁拳现状审查清单

> 审查日期：2026-08-05  
> 基线：`main`（已合并 `feature/ironfist-authority`）  
> 范围：规格、前端 `frontend/src/games/ironfist`、后端权威引擎、接口、迁移和现有测试。  
> 本文只记录问题和证据，不在本轮修改业务逻辑。

## 结论摘要

权威对局主链路已经落地：Go 规则引擎、MySQL 状态、服务端结算、前端 authoritative adapter 均有实现，Go 测试和 IronFist 前端测试通过，生产构建通过。

当前主要风险不是规则引擎失效，而是旧国际版/旧积分命名仍暴露在入口、组件、注释和错误文案中；后续维护者可能误把停用能力重新接回现行路径。

## 优先级定义

- **P0**：可能改变奖励、押注、胜负或权限边界，应在继续开发前处理。
- **P1**：会造成错误产品认知、运维风险或难以发现的线上故障，应近期处理。
- **P2**：清理、可维护性、工具链和体验问题。

## P0：本轮未发现已被测试证明的权威结算漏洞

已验证：

- `backend/internal/ironfistengine` 覆盖 16 个动作组合及关键边界。
- 权威动作接口不接受客户端 HP、伤害、结果或对手动作。
- 旧结果上报和旧 PvE 领奖接口返回 `upgrade_required`。
- 结算使用唯一 settlement reference，并在事务内更新余额、账本、战绩和房间。

迁移约束集成测试已在本机 MySQL 通过；仍需补充真实数据库集成测试：并发重复动作、并发终局结算、截止时间 worker 与请求竞态、outbox 重试，以及账号删除中途失败回滚。

## P1-1：停用的 `$FIST` 国际入口仍存在

证据：

- `frontend/src/games/ironfist/components/IronFistFist.vue:13-184` 仍展示 `$FIST Token`、Solana、veFIST、DAO、NFT 和销毁模型。
- `backend/cmd/server/main.go:223-248` 仍注册 `/fist/stats`、`/fist/account`、`/fist/transactions` 等历史接口。
- `frontend/src/games/ironfist/IronFistPage.vue:4-17` 仍保留国际版入口和旧说明注释。

影响：当前文档已明确中国版积分唯一有效，但代码和页面仍可能让新开发者或用户认为链上经济系统已启用。

建议：下一轮移除页面入口和旧文案；历史统计接口要么删除，要么明确改名为内部兼容接口并加访问边界。

## P1-2：旧客户端引擎仍保留大量过期协议注释和实现

证据：

- `frontend/src/games/ironfist/game/IronFistGame.js:15-301` 仍包含 `localStorage`、`ironfist_action`、`ironfist_replay`、Redis action stream 和客户端重放说明。
- `frontend/src/games/ironfist/game/resolve.js:3,71` 仍引用旧文档章节。
- `frontend/src/games/ironfist/IronFistPage.vue:383-384,672` 同时导入权威引擎和本地引擎。

判断：保留本地引擎作为明确的 `practice` 模式是正确的；风险在于旧注释和命名没有把“仅练习”边界写得足够醒目。

建议：在旧引擎文件顶部增加“practice-only / never trusted”硬性说明，删除 Redis/PvP 权威语义的过期注释；为模式路由增加一条集成测试，确保 `pve`、`pvp`、`friend` 永不实例化旧引擎。

## P1-3：服务端错误文案仍使用 `$FIST`

证据：`backend/internal/handler/ironfist.go:191` 在余额不足时返回 `insufficient $FIST balance`；队列和账本注释也大量使用 `$FIST`。

影响：不改变结算逻辑，但会把中国版积分误报成代币余额，造成前后端协议和运营文案不一致。

建议：对用户可见错误统一使用“积分”，内部数据库历史字段可暂时保留，但需在代码注释中标明 legacy alias。

## P1-4：文档与数据库迁移的部署顺序需要显式验收

当前规格已要求先应用 `021_ironfist_authority.sql`，但现有自动化验证主要是单元测试；尚未看到覆盖真实 MySQL 的默认部署 smoke test。

建议：加入迁移后 smoke test，验证新表、唯一键、旧开放房间退款、待领奖励失效和启动时 migration marker 幂等执行。

## P2-1：ESLint 现已可运行，但仍有 14 条 warning

`npm run lint` 通过，但存在未使用变量/异常变量 warning，包含 IronFist PvP lobby 的两个异常变量。建议把 IronFist 相关 warning 先清理，再逐步处理全项目 warning。

## P2-2：Node 测试仍提示模块类型警告

该问题已通过在 `frontend/package.json` 声明 ESM 解决。

建议：统一前端模块策略（为项目声明 ESM，或明确测试文件的模块边界），单独验证 Quasar 构建不受影响。

## P2-3：生产构建存在大 chunk 警告

Babylon.js 已改为动态导入，主包不再同步加载 3D 引擎；其独立 chunk 仍约 4MB，Vite 仍提示体积较大，但这不影响对局正确性。

## 已通过的验证

```text
backend:  go test ./...                 PASS
frontend: npm run test:ironfist         15 tests PASS
frontend: npm run lint                  PASS (14 warnings)
frontend: npm run build                 PASS (chunk-size warning)
```

已执行的 MySQL 集成验证：

```text
MYSQL_TEST_DSN=本机 MySQL
go test ./migrations -run TestAuthorityMigrationCreatesConstraints -count=1 -v  PASS
```

## 推荐后续顺序

1. 移除/隔离 `$FIST` 页面、旧入口和用户可见文案。
2. 清理旧引擎注释，补充 practice-only 模式路由集成测试。
3. 增加真实 MySQL 事务、迁移和并发 smoke test。
4. 清理 IronFist 相关 lint warning，再处理全项目 warning。
5. Babylon.js 拆包和 Node ESM 警告治理已完成；后续仅需按性能数据决定是否继续细分 3D chunk。

## TODO

- [ ] 在高延迟、丢包和重连事件乱序条件下，验证 PvP 重连倒计时不会跳变或倒退。
- [ ] 生产部署验收：MySQL 迁移幂等与回滚、Redis/WebSocket 多实例广播、HTTPS/WSS 证书与跨网络访问。

### 生产部署检查记录（2026-08-05）

- [x] 已核对 Compose 与 `build.sh` 的发布路径：远程部署目录使用 `./config.prod.yaml`，由脚本从 `backend/config.prod.yaml` 生成并上传。
- [x] Compose 已强制要求通过环境注入 `JWT_SECRET`、`MYSQL_DSN`、`TURN_SECRET`；不得依赖提交文件中的明文凭据。
- [x] 启动流程包含 `migrations.AutoMigrate`，Redis Pub/Sub 使用 `ironfist:events`，各实例可将事件投递到本地 WebSocket Hub。
- [ ] 在生产主机执行 `docker compose config --quiet`、双后端实例广播测试和真实迁移回滚演练。
- [ ] 轮换当前生产配置中已经存在过的敏感凭据，并将生产配置文件限制为部署机私有文件。
- [ ] 用真实域名、证书和外网设备验证 HTTPS/WSS、WebSocket 长连接、断线重连及跨网络 PvP。
