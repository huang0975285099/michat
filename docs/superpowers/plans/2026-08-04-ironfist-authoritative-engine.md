# IronFist Unified Server-Authoritative Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all trusted IronFist client-reported outcomes with a MySQL-backed authoritative engine, automatic settlement, safe account erasure, and an authoritative frontend protocol.

**Architecture:** Keep `IronFistService` as the application boundary but split new behavior across focused files: a pure `ironfistengine` package, SQL-backed authoritative commands, settlement, deadlines/outbox, rollout, and erasure helpers. HTTP carries commands and state queries; Redis Pub/Sub carries disposable post-commit notifications; MySQL remains authoritative. The Vue game page uses a new server-backed adapter for rewarded PvE and online PvP while retaining the current JavaScript resolver only for explicitly selected offline practice.

**Tech Stack:** Go 1.25, Gin, MySQL 8/InnoDB, go-redis, Gorilla WebSocket, Vue 3, Pinia, Quasar, Axios, Node test runner.

## Global Constraints

- MySQL is the only authoritative match and settlement store; Redis loss must not change outcomes.
- Rewarded PvE requires a server-issued session; one session per account; 30-minute inactivity expiry.
- Connected PvP deadline is 30 seconds and defaults to `defend`; disconnect deadline is 60 seconds.
- Accepted actions are immutable and hidden from the opponent until resolution.
- All online PvP is authoritative; casual friend PvP never changes balances.
- Terminal match state, projections, rewards, payouts, fees, and ledger rows commit atomically.
- Existing credited balances are preserved; pending legacy PvE claims are invalidated; open legacy PvP rooms are refunded once.
- Account deletion completely erases user-linked data and local recovery material is retained on any server failure.
- All game and daily-reward timestamps use UTC.
- Production code follows strict red-green-refactor: no production behavior is added before its failing test is observed.

---

### Task 1: Versioned pure Go rules engine and cross-language golden fixtures

**Files:**
- Create: `backend/internal/ironfistengine/types.go`
- Create: `backend/internal/ironfistengine/rules.go`
- Create: `backend/internal/ironfistengine/ai.go`
- Create: `backend/internal/ironfistengine/rules_test.go`
- Create: `backend/internal/ironfistengine/testdata/rules-v1.json`
- Create: `frontend/src/games/ironfist/game/authoritative-parity.test.mjs`
- Modify: `frontend/src/games/ironfist/game/resolve.js`

**Interfaces:**
- Produces: `ironfistengine.Action`, `Seat`, `State`, `RoundResult`, `Outcome`, `InitialState()`, `ResolveRound(Action, Action, State) (RoundResult, error)`, and `DecideAI([]byte, uint8, State) Action`.
- Consumed by: authoritative game commands, settlement facts, and deadline defaults in Tasks 3-6.

- [ ] **Step 1: Write failing engine tests with hand-derived outcomes**

```go
func TestResolveRoundAttackPairs(t *testing.T) {
	cases := []struct {
		name string
		a, b Action
		wantDamageA, wantDamageB int
	}{
		{"attack attack", Attack, Attack, 12, 12},
		{"attack defend", Attack, Defend, 0, 5},
		{"attack charge", Attack, Charge, 0, 18},
		{"attack counter", Attack, Counter, 20, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveRound(tc.a, tc.b, InitialState())
			if err != nil { t.Fatal(err) }
			if got.DamageA != tc.wantDamageA || got.DamageB != tc.wantDamageB {
				t.Fatalf("damage=(%d,%d), want=(%d,%d)", got.DamageA, got.DamageB, tc.wantDamageA, tc.wantDamageB)
			}
		})
	}
}
```

Extend the literal table with `{Defend,Attack,5,0}`, `{Defend,Defend,0,0}`, `{Defend,Charge,0,0}`, `{Defend,Counter,0,8}`, `{Charge,Attack,18,0}`, `{Charge,Defend,0,0}`, `{Charge,Charge,0,0}`, `{Charge,Counter,0,8}`, `{Counter,Attack,0,20}`, `{Counter,Defend,8,0}`, `{Counter,Charge,8,0}`, and `{Counter,Counter,8,8}`. Add named tests `TestResolveRoundConsumesChargedAttack`, `TestResolveRoundAgesChargeAfterTwoUnusedTurns`, `TestResolveRoundAppliesLowHPEnhancementBeforeShield`, `TestResolveRoundAppliesEscalatingEnvironmentalDamage`, `TestResolveRoundClearsBothChargesAfterStalemate`, `TestResolveRoundSimultaneousKnockoutDraws`, `TestResolveRoundMaximumRoundUsesRemainingHP`, `TestResolveRoundRejectsInvalidAction`, and `TestDecideAIIsDeterministic`. Each test supplies a literal `State` and literal expected damage/state/outcome.

- [ ] **Step 2: Run the focused Go test and verify RED**

Run: `cd backend && go test ./internal/ironfistengine -run TestResolveRound -count=1`

Expected: FAIL because the `ironfistengine` production package does not exist.

- [ ] **Step 3: Implement the versioned neutral-seat engine**

```go
const RulesVersion uint16 = 1

type State struct {
	HPA, HPB                         int  `json:"hp_a"`
	ChargedA, ChargedB               bool `json:"charged_a"`
	ChargeUnusedA, ChargeUnusedB     int  `json:"charge_unused_a"`
	ConsecutiveNoDamageRounds        int  `json:"consecutive_no_damage_rounds"`
	TotalRounds                      int  `json:"total_rounds"`
	BothChargedStalemate             int  `json:"both_charged_stalemate"`
	AIChargeInterrupted              int  `json:"ai_charge_interrupted"`
}

func InitialState() State { return State{HPA: 100, HPB: 100} }
func ResolveRound(a, b Action, before State) (RoundResult, error) {
	base, ok := damageTable[a][b]
	if !ok { return RoundResult{}, ErrInvalidAction }
	damageA, damageB := applyChargeAndLowHP(base, a, b, before)
	damageA, damageB = applyLowHPShields(damageA, damageB, before)
	after, envDamage := applyStateTransition(a, b, damageA, damageB, before)
	return RoundResult{ActionA: a, ActionB: b, DamageA: damageA, DamageB: damageB, EnvironmentDamage: envDamage, State: after, Outcome: outcome(after)}, nil
}
```

Use HMAC-SHA256 over `rules_version || round || canonical pre-round state` with the private 32-byte seed, reduce the first eight digest bytes into the hand-checked AI weight total, and never use `math/rand`.

- [ ] **Step 4: Run engine tests and verify GREEN**

Run: `cd backend && go test ./internal/ironfistengine -count=1`

Expected: PASS.

- [ ] **Step 5: Add shared literal golden fixtures and a failing JavaScript parity test**

```json
[
  {
    "name": "attack-vs-defend",
    "before": {"hp_a":100,"hp_b":100,"charged_a":false,"charged_b":false,"charge_unused_a":0,"charge_unused_b":0,"consecutive_no_damage_rounds":0,"total_rounds":0,"both_charged_stalemate":0,"ai_charge_interrupted":0},
    "action_a": "attack",
    "action_b": "defend",
    "after": {"hp_a":100,"hp_b":95,"charged_a":false,"charged_b":false,"charge_unused_a":0,"charge_unused_b":0,"consecutive_no_damage_rounds":0,"total_rounds":1,"both_charged_stalemate":0,"ai_charge_interrupted":0},
    "damage_a": 0,
    "damage_b": 5,
    "outcome": ""
  }
]
```

The Node test reads this file, maps A/B fields to the practice resolver's player/opponent fields, and asserts the literal result.

- [ ] **Step 6: Run the Node parity test and verify RED, then make the smallest compatibility changes**

Run: `cd frontend && node --test src/games/ironfist/game/authoritative-parity.test.mjs`

Expected before compatibility changes: FAIL on state-key or `doubleLose` mapping differences. Keep gameplay arithmetic unchanged and add only explicit conversion helpers in the test or exported adapter functions.

- [ ] **Step 7: Run both rule suites and commit**

Run: `cd backend && go test ./internal/ironfistengine -count=1`

Run: `cd frontend && npm run test:ironfist`

```powershell
git add backend/internal/ironfistengine frontend/src/games/ironfist/game
git commit -m "feat: add authoritative IronFist rules engine"
```

### Task 2: Authoritative schema, migration registration, and SQL integration test

**Files:**
- Create: `backend/migrations/021_ironfist_authority.sql`
- Create: `backend/migrations/authority_integration_test.go`
- Modify: `backend/migrations/migrate.go`

**Interfaces:**
- Produces: `ironfist_games`, `ironfist_game_actions`, `ironfist_game_rounds`, `ironfist_active_pve`, `ironfist_outbox`, and `system_migration_markers`; `authoritative_game_id` history projection key; unique settlement reference constraint.
- Consumed by: every later backend task.

- [ ] **Step 1: Write a MySQL-backed failing migration test**

```go
func TestAuthorityMigrationCreatesConstraints(t *testing.T) {
	dsn := os.Getenv("MYSQL_TEST_DSN")
	if dsn == "" { t.Skip("MYSQL_TEST_DSN is required for MySQL integration") }
	db := openIsolatedTestDatabase(t, dsn)
	if err := AutoMigrate(db); err != nil { t.Fatal(err) }
	assertUniqueIndex(t, db, "ironfist_game_actions", "uq_ifga_round_seat")
	assertForeignKey(t, db, "ironfist_game_actions", "ironfist_games")
	assertUniqueIndex(t, db, "fist_transactions", "uq_ft_settlement_ref")
}
```

The helper creates a uniquely named database, switches the DSN to it, creates the prerequisite `users` tables through `AutoMigrate`, and drops only that verified test database in `t.Cleanup`.

- [ ] **Step 2: Start an isolated MySQL 8 test instance and verify RED**

Run: `docker run --rm -d --name michat-ironfist-mysql -e MYSQL_ROOT_PASSWORD=test -p 13316:3306 mysql:8.4`

Run after readiness: `$env:MYSQL_TEST_DSN='root:test@tcp(127.0.0.1:13316)/mysql?parseTime=true&multiStatements=true'; cd backend; go test ./migrations -run TestAuthorityMigrationCreatesConstraints -count=1`

Expected: FAIL because migration 021 and its embedded variable do not exist.

- [ ] **Step 3: Add the idempotent migration**

```sql
CREATE TABLE IF NOT EXISTS ironfist_games (
  game_id CHAR(36) NOT NULL PRIMARY KEY,
  mode ENUM('pve','pvp','friend') NOT NULL,
  status ENUM('waiting','active','completed','abandoned','cancelled') NOT NULL,
  player_a_user_id BIGINT UNSIGNED NOT NULL,
  player_b_user_id BIGINT UNSIGNED NULL,
  pvp_room_id BIGINT UNSIGNED NULL,
  rules_version SMALLINT UNSIGNED NOT NULL,
  current_round TINYINT UNSIGNED NOT NULL DEFAULT 1,
  state_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  state_json JSON NOT NULL,
  ai_seed BINARY(32) NULL,
  action_deadline_a DATETIME(3) NULL,
  action_deadline_b DATETIME(3) NULL,
  remaining_action_ms_a INT UNSIGNED NULL,
  remaining_action_ms_b INT UNSIGNED NULL,
  disconnect_deadline_a DATETIME(3) NULL,
  disconnect_deadline_b DATETIME(3) NULL,
  last_activity_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NULL,
  result VARCHAR(16) NULL,
  winner_user_id BIGINT UNSIGNED NULL,
  finish_reason VARCHAR(32) NULL,
  finished_at DATETIME(3) NULL,
  settled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ifg_pvp_room (pvp_room_id),
  KEY idx_ifg_due (status, action_deadline_a, action_deadline_b),
  CONSTRAINT fk_ifg_a FOREIGN KEY (player_a_user_id) REFERENCES users(id),
  CONSTRAINT fk_ifg_b FOREIGN KEY (player_b_user_id) REFERENCES users(id),
  CONSTRAINT fk_ifg_room FOREIGN KEY (pvp_room_id) REFERENCES ironfist_pvp_rooms(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Add child tables with `ON DELETE CASCADE`, unique `(game_id, round_num, seat)`, unique `(game_id, user_id, request_id)`, unique `(game_id, round_num)`, one active-PvE row per user, and an outbox index on `(published_at, id)`. Add nullable `authoritative_game_id` to `ironfist_matches` plus `(user_id, authoritative_game_id)` uniqueness. Add nullable `settlement_ref` to `fist_transactions` plus unique `(user_id, type, settlement_ref)`; authoritative base and bonus rewards use distinct non-null values.

Add `system_migration_markers(name VARCHAR(128) PRIMARY KEY, completed_at DATETIME(3) NOT NULL)` so the rollout in Task 11 can prove completion across restarts and multiple server instances.

- [ ] **Step 4: Embed migration 021 after migration 020 and verify GREEN**

```go
//go:embed 021_ironfist_authority.sql
var ironfistAuthoritySQL string
```

Run: `$env:MYSQL_TEST_DSN='root:test@tcp(127.0.0.1:13316)/mysql?parseTime=true&multiStatements=true'; cd backend; go test ./migrations -run TestAuthorityMigrationCreatesConstraints -count=1`

Expected: PASS.

- [ ] **Step 5: Run migration unit tests and commit**

Run: `cd backend && go test ./migrations -count=1`

```powershell
git add backend/migrations
git commit -m "feat: add authoritative IronFist schema"
```

### Task 3: Authoritative game views, PvE creation/resume, and action locking

**Files:**
- Create: `backend/internal/service/ironfist_authority.go`
- Create: `backend/internal/service/ironfist_authority_store.go`
- Create: `backend/internal/service/ironfist_authority_test.go`
- Modify: `backend/internal/service/ironfist.go`

**Interfaces:**
- Produces: `StartRewardedPVE`, `GetActiveRewardedPVE`, `CreateCasualAuthoritativeGame`, `GetAuthoritativeGame`, `SubmitAuthoritativeAction`, `ResignAuthoritativeGame`, `ActionCommand`, `GameView`, and stable `AuthorityError.Code` values.
- Consumes: Task 1 engine and Task 2 schema.

- [ ] **Step 1: Write failing service tests for lifecycle and visibility**

```go
func TestStartRewardedPVEReplacesExistingSession(t *testing.T) {
	svc, db := newAuthoritySQLTest(t, fixedTime)
	expectActivePVECreation(db, 7, "old-game")
	expectReplacement(db, "old-game", 7, "new-game")
	got, err := svc.StartRewardedPVE(context.Background(), 7, true)
	if err != nil { t.Fatal(err) }
	if got.GameID != "new-game" || got.Status != "active" { t.Fatalf("got %#v", got) }
}

func TestGameViewHidesUnresolvedOpponentAction(t *testing.T) {
	view := gameViewForSeat(gameWithOnlySeatBAction(), ironfistengine.SeatA)
	if view.OpponentAction != nil || !view.OpponentLocked { t.Fatalf("leaked action: %#v", view) }
}
```

Add the following literal validation table so every rejection is an independently named subtest:

```go
func TestSubmitAuthoritativeActionValidation(t *testing.T) {
	cases := []struct{ name string; user uint64; cmd ActionCommand; wantCode string }{
		{"non participant", 99, validActionCommand(1, 1), "forbidden"},
		{"stale version", 7, validActionCommand(1, 0), "stale_state"},
		{"future round", 7, validActionCommand(2, 1), "stale_state"},
		{"invalid action", 7, ActionCommand{Round: 1, Action: "heal", RequestID: requestID1, ExpectedVersion: 1}, "invalid_action"},
	}
	for _, tc := range cases { t.Run(tc.name, func(t *testing.T) { assertAuthorityCode(t, submitFixture(t, tc.user, tc.cmd), tc.wantCode) }) }
}

func TestSubmitAuthoritativeActionSameRequestReturnsOriginalView(t *testing.T) { assertIdempotentRequest(t, requestID1) }
func TestSubmitAuthoritativeActionCannotReplaceLockedAction(t *testing.T) { assertConflictingActionCode(t, requestID1, requestID2, "action_locked") }
func TestExpiredPVESessionReturnsGone(t *testing.T) { assertExpiredSessionCode(t, "session_expired") }
func TestPVEActionStoresPrivateAIActionAndResolvedRound(t *testing.T) { assertResolvedPVESources(t, "player", "ai") }
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd backend && go test ./internal/service -run 'Test(StartRewardedPVE|GameView|SubmitAuthoritative)' -count=1`

Expected: FAIL because the authority methods and types are missing.

- [ ] **Step 3: Add service types and injected deterministic dependencies**

```go
type ActionCommand struct {
	Round           int                    `json:"round"`
	Action          ironfistengine.Action `json:"action"`
	RequestID       string                 `json:"request_id"`
	ExpectedVersion uint64                 `json:"expected_version"`
}

type AuthorityError struct { Code string; Err error }

func (s *IronFistService) StartRewardedPVE(ctx context.Context, userID uint64, replace bool) (*GameView, error)
func (s *IronFistService) GetActiveRewardedPVE(ctx context.Context, userID uint64) (*GameView, error)
func (s *IronFistService) CreateCasualAuthoritativeGame(ctx context.Context, inviterUserID, inviteeUserID uint64) (*GameView, error)
func (s *IronFistService) GetAuthoritativeGame(ctx context.Context, userID uint64, gameID string) (*GameView, error)
func (s *IronFistService) SubmitAuthoritativeAction(ctx context.Context, userID uint64, gameID string, cmd ActionCommand) (*GameView, error)
func (s *IronFistService) ResignAuthoritativeGame(ctx context.Context, userID uint64, gameID string) (*GameView, error)
```

Add `now func() time.Time`, `random io.Reader`, and `newGameID func() string` dependencies to `IronFistService`, with production defaults in `NewIronFistService` and deterministic test overrides.

- [ ] **Step 4: Implement transaction locking and sanitized views**

Use strict JSON decoding for state, `SELECT ... FOR UPDATE`, `advanceDueGameTx` before command validation, UUID request validation, action enum validation, and database uniqueness for action lock/idempotency. The view exposes `my_action` and `opponent_locked`, never an unresolved opponent action or AI seed.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `cd backend && go test ./internal/service -run 'Test(StartRewardedPVE|GameView|SubmitAuthoritative)' -count=1`

Expected: PASS.

- [ ] **Step 6: Run service and engine suites and commit**

Run: `cd backend && go test ./internal/service ./internal/ironfistengine -count=1`

```powershell
git add backend/internal/service backend/internal/ironfistengine
git commit -m "feat: add authoritative PvE sessions and actions"
```

### Task 4: Atomic history, statistics, achievements, and PvE reward settlement

**Files:**
- Create: `backend/internal/service/ironfist_settlement.go`
- Create: `backend/internal/service/ironfist_settlement_test.go`
- Modify: `backend/internal/service/ironfist_authority.go`
- Modify: `backend/internal/service/fist.go`

**Interfaces:**
- Produces: `settleCompletedGameTx(ctx, tx, lockedGame)`, `writeAuthoritativeMatchTx`, `updateAuthoritativeStatsTx`, and uniquely keyed reward writes.
- Consumed by: PvE terminal actions, PvP terminal actions, deadlines, resignation, and deletion.

- [ ] **Step 1: Write failing settlement tests**

```go
func TestPVETenthWinAwardsBaseAndBonusOnce(t *testing.T) {
	svc, db := newAuthoritySQLTest(t, fixedTime)
	expectDailyProgressLocked(db, 42, fixedUTCDate, 9, 4500)
	expectBalanceIncrease(db, 42, 1500)
	expectSettlementLedger(db, 42, 500, "game:g-10:pve-base")
	expectSettlementLedger(db, 42, 1000, "game:g-10:pve-bonus")
	if err := svc.settleCompletedGame(context.Background(), completedPVEWin("g-10", 42)); err != nil { t.Fatal(err) }
}
```

Add this hand-derived reward table plus named projection tests:

```go
func TestPVEDailyRewardSchedule(t *testing.T) {
	cases := []struct{ priorWins int; result string; wantPoints, wantWins int }{
		{0, "win_a", 500, 1}, {8, "win_a", 500, 9}, {9, "win_a", 1500, 10},
		{10, "win_a", 0, 10}, {0, "win_b", 0, 0}, {0, "draw", 0, 0},
	}
	for _, tc := range cases { assertPVESettlement(t, tc.priorWins, tc.result, tc.wantPoints, tc.wantWins) }
}

func TestAuthoritativeProjectionUnlocksCounterMasterFromStoredRounds(t *testing.T) { assertStoredCounterAchievement(t, 3) }
func TestAuthoritativeProjectionUsesStoredFinalHPForLowHPWin(t *testing.T) { assertStoredHPAchievement(t, 8, "low_hp_comeback") }
func TestCasualFriendSettlementChangesStatsButNotLedger(t *testing.T) { assertCasualProjectionWithoutLedger(t) }
func TestCompletedGameSettlementIsIdempotent(t *testing.T) { assertOneSettlementMutation(t, "game-duplicate") }
```

- [ ] **Step 2: Run focused settlement tests and verify RED**

Run: `cd backend && go test ./internal/service -run 'Test(PVE|AuthoritativeStats|Casual)' -count=1`

Expected: FAIL because authoritative settlement does not exist.

- [ ] **Step 3: Implement terminal settlement inside the game transaction**

```go
func (s *IronFistService) settleCompletedGameTx(ctx context.Context, tx *sql.Tx, g *lockedGame) error {
	if g.SettledAt.Valid { return nil }
	if err := s.writeMatchProjectionsTx(ctx, tx, g); err != nil { return err }
	if err := s.updateStatsAndAchievementsTx(ctx, tx, g); err != nil { return err }
	if g.Mode == "pve" && g.Result == "win_a" {
		if err := s.awardPVEDailyTx(ctx, tx, g.PlayerAUserID, g.GameID); err != nil { return err }
	}
	_, err := tx.ExecContext(ctx, `UPDATE ironfist_games SET settled_at = UTC_TIMESTAMP(3) WHERE game_id = ? AND settled_at IS NULL`, g.GameID)
	return err
}
```

Derive counter successes, low-HP wins, final HP, round count, opponent names, and history detail solely from stored authoritative rounds. Use `settlement_ref` values `game:<id>:pve-base` and `game:<id>:pve-bonus`.

- [ ] **Step 4: Remove the claim method from active behavior**

Keep read-only account and transaction APIs. Mark `ClaimPvEReward` as legacy-inaccessible and remove frontend reliance in later tasks; no authoritative code calls it.

- [ ] **Step 5: Run settlement tests and verify GREEN**

Run: `cd backend && go test ./internal/service -run 'Test(PVE|AuthoritativeStats|Casual)' -count=1`

Expected: PASS.

- [ ] **Step 6: Commit atomic PvE settlement**

```powershell
git add backend/internal/service
git commit -m "feat: settle authoritative IronFist rewards atomically"
```

### Task 5: Authoritative wagered PvP creation and payout

**Files:**
- Modify: `backend/internal/service/ironfist.go`
- Modify: `backend/internal/service/ironfist_authority.go`
- Modify: `backend/internal/service/ironfist_settlement.go`
- Create: `backend/internal/service/ironfist_pvp_authority_test.go`

**Interfaces:**
- Produces: `PVPMatchResult.GameID`, authoritative game creation within matchmaking, and payout from `lockedGame.Result` only.
- Consumes: Tasks 2-4.

- [ ] **Step 1: Write failing matchmaking and payout tests**

```go
func TestSecondQueuePlayerCreatesAuthoritativeGameInMatchTransaction(t *testing.T) {
	svc, db := newAuthoritySQLTest(t, fixedTime)
	expectWaitingRoomMatchAndGameInsert(db, 10, 20, "game-pvp-1")
	got, err := svc.EnqueuePVP(context.Background(), 20, "2222-BBBB", "gold")
	if err != nil { t.Fatal(err) }
	if got.GameID != "game-pvp-1" { t.Fatalf("game_id=%q", got.GameID) }
}

func TestLosingPlayerCannotInfluenceAuthoritativePayout(t *testing.T) {
	game := completedWageredGame("game-pvp-1", 10, 20, "win_a")
	assertWinnerPayoutFromStoredOutcome(t, game, 195)
}
```

Use a literal payout table independent of production arithmetic:

```go
func TestWageredPayoutTable(t *testing.T) {
	cases := []struct{ result string; winner, refundA, refundB, burn, treasury int64 }{
		{"win_a", 190, 0, 0, 5, 5},
		{"win_b", 190, 0, 0, 5, 5},
		{"draw", 0, 97, 97, 3, 3},
		{"doubleLose", 0, 97, 97, 3, 3},
	}
	for _, tc := range cases { assertWagerSettlement(t, 100, tc) }
}

func TestForfeitPaysNonForfeitingPlayer(t *testing.T) { assertForfeitPayout(t, "forfeit_a", "win_b") }
func TestWagerSettlementIgnoresLegacyReportColumns(t *testing.T) { assertStoredOutcomeWinsOverReports(t, "win_b", "win_a", "win_a") }
func TestWagerSettlementIsIdempotent(t *testing.T) { assertOneWagerPayout(t, "game-pvp-duplicate") }
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd backend && go test ./internal/service -run 'Test(SecondQueue|LosingPlayer|Wagered)' -count=1`

Expected: FAIL because queue results do not contain `game_id` and payout still uses client reports.

- [ ] **Step 3: Create the game in `enqueuePVPOnce` before commit**

```go
type PVPMatchResult struct {
	Status string `json:"status"`
	RoomID uint64 `json:"room_id,omitempty"`
	GameID string `json:"game_id,omitempty"`
	// existing tier, stake, waiting, and opponent fields remain
}
```

Insert an active PvP game with both user IDs, room ID, initial state, rules version, version 1, and both 30-second deadlines in the same transaction that marks the room matched and escrows the second stake.

Return `game_id` from immediate matchmaking and queue-status polling. Include the same `game_id` in `NotifyPVPMatched` for the waiting player; add handler assertions that both players receive the identical authoritative ID.

- [ ] **Step 4: Settle wager rooms from stored outcome only**

Refactor the existing fee arithmetic into `settleWagerRoomTx(ctx, tx, g)` and remove `callerResult`, `report_a`, and `report_b` from its signature. Remarks must not embed a deleted opponent chat ID; use tier and authoritative game ID only.

- [ ] **Step 5: Run focused and existing service tests and verify GREEN**

Run: `cd backend && go test ./internal/service -count=1`

Expected: PASS.

- [ ] **Step 6: Commit authoritative wager settlement**

```powershell
git add backend/internal/service
git commit -m "feat: settle wagered PvP from server outcomes"
```

### Task 6: Deadlines, presence transitions, reconnect, and transactional outbox

**Files:**
- Create: `backend/internal/service/ironfist_deadlines.go`
- Create: `backend/internal/service/ironfist_deadlines_test.go`
- Create: `backend/internal/service/ironfist_outbox.go`
- Create: `backend/internal/service/ironfist_outbox_test.go`
- Modify: `backend/pkg/redis/redis.go`
- Modify: `backend/internal/ws/hub.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Produces: `SetIronFistPresence(ctx, userID, connected)`, `SweepDueAuthoritativeGames(ctx)`, `PublishIronFistOutbox(ctx)`, Redis channel `ironfist:events`, and hub event delivery.
- Consumes: the locked transition and settlement functions from Tasks 3-5.

- [ ] **Step 1: Write failing deadline tests**

```go
func TestConnectedDeadlineInsertsDefend(t *testing.T) {
	got := runDeadlineScenario(t, deadlineScenario{DueActionA: true})
	assertAction(t, got.ActionA, "defend", "deadline")
}
func TestSingleDisconnectExpiryForfeits(t *testing.T) {
	got := runDeadlineScenario(t, deadlineScenario{DisconnectAExpired: true, BConnected: true})
	assertResult(t, got, "win_b", "disconnect_forfeit_a")
}
func TestBothDisconnectExpiriesDraw(t *testing.T) {
	got := runDeadlineScenario(t, deadlineScenario{DisconnectAExpired: true, DisconnectBExpired: true})
	assertResult(t, got, "draw", "both_disconnected")
}
func TestReconnectRestoresRemainingActionTime(t *testing.T) {
	got := runReconnectScenario(t, 17*time.Second)
	if got.ActionDeadlineA.Sub(fixedTime) != 17*time.Second { t.Fatalf("deadline=%v", got.ActionDeadlineA) }
}
```

Add a test proving the outbox row and game state commit together and repeated publication only marks one event published.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd backend && go test ./internal/service -run 'Test(ConnectedDeadline|SingleDisconnect|BothDisconnect|Reconnect|Outbox)' -count=1`

Expected: FAIL because deadline/presence/outbox methods are missing.

- [ ] **Step 3: Implement one locked transition path for requests and sweepers**

```go
func (s *IronFistService) advanceDueGameTx(ctx context.Context, tx *sql.Tx, g *lockedGame, now time.Time) error
func (s *IronFistService) SetIronFistPresence(ctx context.Context, userID uint64, connected bool) error
func (s *IronFistService) SweepDueAuthoritativeGames(ctx context.Context) (int, error)
func (s *IronFistService) PublishIronFistOutbox(ctx context.Context, limit int) (int, error)
```

Lock due games in ascending game ID order. When the final authenticated connection closes, persist the remaining action milliseconds before clearing that seat's action deadline and setting its disconnect deadline. On reconnect, clear the disconnect deadline and restore `now + remaining`.

- [ ] **Step 4: Implement outbox publication and Redis fan-out**

After commit, a background loop selects unpublished rows in ID order, publishes the payload to `ironfist:events`, and sets `published_at`. Every server hub subscribes and sends only to locally connected recipient chat IDs. HTTP state fetch remains the recovery mechanism after gaps.

- [ ] **Step 5: Wire presence across connection replacement without false disconnects**

The current hub intentionally keeps one active WebSocket per chat ID and preempts the older socket. Capture `wasOnline` before replacement: call `SetIronFistPresence(..., true)` only when there was no prior socket, and call `SetIronFistPresence(..., false)` only when `Unregister` removes the currently registered socket. A preempted socket's later `Unregister` must not start a disconnect deadline. Call the service outside `h.mu`.

- [ ] **Step 6: Remove raw client-authoritative action and replay messages**

Delete the `ironfist_action` and `ironfist_reconnect` dispatch cases, Redis append/replay handlers, rate-limit fields used only by them, and opponent raw-action forwarding. Add a WS test sending both legacy message types and assert neither a Redis action list nor an opponent message is produced. Authoritative HTTP commands and outbox events are the only trusted online-game path.

- [ ] **Step 7: Run tests and verify GREEN**

Run: `cd backend && go test ./internal/service ./internal/ws ./pkg/redis -count=1`

Expected: PASS.

- [ ] **Step 8: Commit deadline and outbox behavior**

```powershell
git add backend/internal/service backend/internal/ws backend/pkg/redis backend/cmd/server/main.go
git commit -m "feat: enforce authoritative IronFist deadlines"
```

### Task 7: HTTP command/query contract and legacy endpoint retirement

**Files:**
- Modify: `backend/internal/handler/ironfist.go`
- Modify: `backend/internal/handler/fist.go`
- Create: `backend/internal/handler/ironfist_authority_test.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Produces: the approved session/game/action/resign routes and stable HTTP error mapping.
- Consumes: authoritative service methods from Tasks 3-6.

- [ ] **Step 1: Write failing Gin handler tests**

```go
func TestSubmitActionRejectsUnknownJSONFields(t *testing.T) {
	body := `{"round":1,"action":"attack","request_id":"6e7060d4-0c83-49fc-815a-800ad3b84a2e","expected_version":1,"player_hp":100}`
	res := performAuthenticatedRequest(t, router, http.MethodPost, "/api/games/ironfist/games/g/actions", body, 7)
	if res.Code != http.StatusBadRequest { t.Fatalf("status=%d", res.Code) }
}
```

Add this exact status mapping table and dedicated command tests:

```go
func TestAuthorityErrorHTTPMapping(t *testing.T) {
	cases := []struct{ code string; status int }{
		{"invalid_action", 400}, {"forbidden", 403}, {"not_found", 404},
		{"action_locked", 409}, {"stale_state", 409}, {"game_finished", 409}, {"session_expired", 410},
	}
	for _, tc := range cases { assertAuthorityHTTPStatus(t, tc.code, tc.status) }
}
func TestStartPVESessionPassesExplicitReplaceFlag(t *testing.T) { assertStartReplaceBody(t, true) }
func TestGetActiveSessionReturnsAuthoritativeView(t *testing.T) { assertActiveSessionView(t, "game-pve-1") }
func TestResignReturnsTerminalView(t *testing.T) { assertResignResult(t, "abandoned") }
func TestLegacyReportAndClaimRequireUpgrade(t *testing.T) { assertLegacyRoutes(t, 426, "upgrade_required") }
```

- [ ] **Step 2: Run handler tests and verify RED**

Run: `cd backend && go test ./internal/handler -run 'Test(StartPVE|SubmitAction|LegacyIronFist)' -count=1`

Expected: FAIL because routes and strict decoding are absent.

- [ ] **Step 3: Add strict request handlers**

```go
func (h *IronFistHandler) StartPVESession(c *gin.Context)
func (h *IronFistHandler) GetActiveSession(c *gin.Context)
func (h *IronFistHandler) GetGame(c *gin.Context)
func (h *IronFistHandler) SubmitAction(c *gin.Context)
func (h *IronFistHandler) Resign(c *gin.Context)
```

Use `json.Decoder.DisallowUnknownFields`, reject trailing JSON, and map `AuthorityError.Code` to the approved status/code response. Register:

```go
auth.POST("/games/ironfist/pve/sessions", ironFistHandler.StartPVESession)
auth.GET("/games/ironfist/sessions/active", ironFistHandler.GetActiveSession)
auth.GET("/games/ironfist/games/:id", ironFistHandler.GetGame)
auth.POST("/games/ironfist/games/:id/actions", ironFistHandler.SubmitAction)
auth.POST("/games/ironfist/games/:id/resign", ironFistHandler.Resign)
```

- [ ] **Step 4: Retire client-report and claim routes**

Keep the URLs temporarily registered for old clients but return:

```json
{"error":"upgrade_required","message":"server-authoritative IronFist is required"}
```

with HTTP 426. Do not call `ReportMatch`, `SettlePVP`, or `ClaimPvEReward`.

- [ ] **Step 5: Run handler and backend tests and commit**

Run: `cd backend && go test ./... -count=1`

Expected: PASS.

```powershell
git add backend/internal/handler backend/cmd/server/main.go
git commit -m "feat: expose authoritative IronFist API"
```

### Task 8: Server-validated friend acceptance and authoritative game notifications

**Files:**
- Modify: `backend/internal/ws/hub.go`
- Modify: `backend/internal/ws/ironfist_validation_test.go`
- Modify: `backend/pkg/redis/redis.go`
- Modify: `frontend/src/stores/game.js`
- Create: `frontend/src/stores/ironfist-invite.mjs`
- Create: `frontend/src/stores/ironfist-invite.test.mjs`

**Interfaces:**
- Produces: a Redis TTL invitation record for IronFist only, authoritative casual game creation on authenticated acceptance, and `game_ready` carrying `game_id`.
- Consumes: existing generic invite UI and Task 3 `CreateCasualAuthoritativeGame` helper.

- [ ] **Step 1: Write failing backend tests for invitation authorization**

```go
func TestIronFistInviteAcceptanceAuthorization(t *testing.T) {
	h := newInviteHubTest(t)
	h.invite(10, "1111-AAAA", 20, "2222-BBBB", "room-1")
	assertInviteTTL(t, h.redis, "room-1", 30*time.Second)
	assertAcceptRejected(t, h, 30, "room-1")
	assertAcceptCreatesGame(t, h, 20, "room-1", "casual-game-1")
	assertAcceptRejected(t, h, 20, "room-1")
	assertAcceptRejected(t, h, 20, "guessed-room")
}

func TestIronFistInviteAcceptanceRechecksFriendship(t *testing.T) {
	h := newInviteHubTest(t)
	h.invite(10, "1111-AAAA", 20, "2222-BBBB", "room-2")
	h.removeFriendship(10, 20)
	assertAcceptRejected(t, h, 20, "room-2")
}
```

- [ ] **Step 2: Run WS tests and verify RED**

Run: `cd backend && go test ./internal/ws -run TestIronFistInvite -count=1`

Expected: FAIL because generic relay currently treats a random room ID as sufficient.

- [ ] **Step 3: Implement the narrow IronFist invitation path**

Preserve generic relay for other games. For `game == "ironfist"`, persist a signed server-side invite record in Redis. On `game_accept`, verify and consume it atomically, create the casual MySQL game, and send `game_ready` to both players with `game_id`, opponent profile, and seat. Never accept a client seed for IronFist.

- [ ] **Step 4: Write and verify a failing frontend invite test**

```js
test('IronFist navigation waits for server game_ready', async () => {
  const state = createInviteState()
  state.accept({ room_id: 'r1', game: 'ironfist' })
  assert.equal(state.route, null)
  state.ready({ room_id: 'r1', game_id: 'g1' })
  assert.equal(state.route.query.game_id, 'g1')
})
```

Run: `cd frontend && node --test src/stores/ironfist-invite.test.mjs`

Expected: FAIL because the store navigates immediately on `game_accept` and uses a client seed.

- [ ] **Step 5: Update the game store and verify GREEN**

For IronFist, accept sends no seed and sets a waiting state; both peers navigate only after `game_ready`. Bomberman retains its existing seed behavior.

Run: `cd frontend && node --test src/stores/ironfist-invite.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit friend authority**

```powershell
git add backend/internal/ws backend/pkg/redis frontend/src/stores
git commit -m "feat: authorize IronFist friend matches"
```

### Task 9: Authoritative frontend client adapter and API bindings

**Files:**
- Create: `frontend/src/games/ironfist/game/AuthoritativeIronFistGame.js`
- Create: `frontend/src/games/ironfist/game/authoritative-client-core.mjs`
- Create: `frontend/src/games/ironfist/game/authoritative-client-core.test.mjs`
- Modify: `frontend/src/services/api.js`
- Modify: `frontend/src/services/websocket.js`

**Interfaces:**
- Produces: a page-facing adapter with `startPVE`, `resume(gameID)`, `selectAction`, `resign`, `destroy`, and current event names (`round-start`, `locked`, `resolved`, `gameover`, `opponent-disconnected`, `round-resume`).
- Consumes: Task 7 API and Task 6 outbox WebSocket events.

- [ ] **Step 1: Write failing client-core tests**

```js
test('discards old events and refetches on a version gap', async () => {
  const calls = []
  const core = createAuthoritativeClientCore({ version: 4, refetch: async () => calls.push('refetch') })
  await core.onEvent({ state_version: 3 })
  await core.onEvent({ state_version: 6 })
  assert.deepEqual(calls, ['refetch'])
})
```

```js
test('locks only after HTTP acceptance and reuses the request id on retry', async () => {
  const sent = []
  const core = createAuthoritativeClientCore({ submit: async body => { sent.push(body); return acceptedView(2) } })
  const pending = core.submit('attack')
  assert.equal(core.locked, false)
  await pending
  assert.equal(core.locked, true)
  await core.retry()
  assert.equal(sent[0].request_id, sent[1].request_id)
})
test('never exposes an unresolved opponent action', () => assert.equal(toPageState({ opponent_locked: true }).opponentAction, null))
test('uses server time to derive deadline countdown', () => assert.equal(secondsRemaining(serverView('00:00:10Z', '00:00:25Z')), 15))
test('translates resolved round and terminal reward literally', () => assert.deepEqual(toResolvedEvent(resolvedFixture), expectedResolvedEvent))
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd frontend && node --test src/games/ironfist/game/authoritative-client-core.test.mjs`

Expected: FAIL because the authoritative client does not exist.

- [ ] **Step 3: Add API bindings and pure version/event core**

```js
startPVESession: (replace = false) => api.post('/games/ironfist/pve/sessions', { replace }),
getActiveIronFistSession: () => api.get('/games/ironfist/sessions/active'),
getIronFistGame: (id) => api.get(`/games/ironfist/games/${encodeURIComponent(id)}`),
submitIronFistAction: (id, body) => api.post(`/games/ironfist/games/${encodeURIComponent(id)}/actions`, body),
resignIronFistGame: (id) => api.post(`/games/ironfist/games/${encodeURIComponent(id)}/resign`),
```

Generate UUID request IDs with `crypto.randomUUID()`. The pure core rejects older versions and invokes a single guarded refetch on gaps.

- [ ] **Step 4: Implement adapter event translation and verify GREEN**

The adapter never imports `resolve.js` or `GameAI.js`. It converts server public state and resolved rounds into the current page event shape so renderer code remains unchanged.

Run: `cd frontend && node --test src/games/ironfist/game/authoritative-client-core.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the frontend client**

```powershell
git add frontend/src/games/ironfist/game frontend/src/services
git commit -m "feat: add authoritative IronFist web client"
```

### Task 10: Integrate rewarded PvE, online PvP, offline practice, and automatic settlement UI

**Files:**
- Modify: `frontend/src/games/ironfist/IronFistPage.vue`
- Modify: `frontend/src/games/ironfist/components/IronFistLobby.vue`
- Modify: `frontend/src/games/ironfist/components/IronFistPvpLobby.vue`
- Modify: `frontend/src/stores/fist.js`
- Create: `frontend/src/games/ironfist/game/mode-routing.mjs`
- Create: `frontend/src/games/ironfist/game/mode-routing.test.mjs`

**Interfaces:**
- Produces: rewarded online PvE through the authoritative adapter, explicit offline practice through `IronFistGame`, and all online PvP through `game_id`.
- Consumes: Tasks 8-9.

- [ ] **Step 1: Write failing mode-routing tests**

```js
test('trusted modes require a server game id while practice stays local', () => {
  assert.equal(selectEngine({ mode: 'practice' }), 'local')
  assert.equal(selectEngine({ mode: 'pve', gameId: 'g1' }), 'authoritative')
  assert.throws(() => selectEngine({ mode: 'pvp', gameId: '' }), /game_id/)
})
```

```js
test('matched queue payload preserves game id', () => {
  assert.equal(routeFromMatch({ room_id: 4, game_id: 'g-pvp' }).query.game_id, 'g-pvp')
})
test('friend ready payload preserves game id', () => {
  assert.equal(routeFromFriendReady({ room_id: 'r', game_id: 'g-friend' }).query.game_id, 'g-friend')
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd frontend && node --test src/games/ironfist/game/mode-routing.test.mjs`

Expected: FAIL because mode routing still trusts room IDs and local resolution.

- [ ] **Step 3: Replace trusted engine construction**

Make `startPve` await `startPVESession(true)`, use its game ID, and build `AuthoritativeIronFistGame`. Make PvP require `route.query.game_id`. Queue and friend routing must pass the returned game ID. Keep `new IronFistGame({mode:'pve'})` only in `startPractice`.

- [ ] **Step 4: Remove reports and claims from gameover**

Delete `reportMatchResult`, `pollPvpSettle`, and calls to `fistStore.claimPvEReward`. Read `reward`, `settlement`, `new_achievements`, and terminal result from the authoritative game-finished payload, show them, and refresh the account read model.

- [ ] **Step 5: Add explicit offline practice UI**

Add a separate lobby card labeled “Offline practice” that emits `start-practice`, explains that it has no rewards/statistics/achievements, and uses the local resolver without API writes.

- [ ] **Step 6: Run frontend tests and verify GREEN**

Run: `cd frontend && npm run test:ironfist`

Expected: PASS.

- [ ] **Step 7: Run lint, fix only introduced findings, and commit**

Run: `cd frontend && npm run lint`

```powershell
git add frontend/src/games/ironfist frontend/src/stores/fist.js
git commit -m "feat: use server authority for trusted IronFist modes"
```

### Task 11: Idempotent legacy rollout and open-room refund

**Files:**
- Create: `backend/internal/service/ironfist_rollout.go`
- Create: `backend/internal/service/ironfist_rollout_test.go`
- Modify: `backend/cmd/server/main.go`
- Modify: `backend/pkg/redis/redis.go`

**Interfaces:**
- Produces: `MigrateLegacyIronFist(ctx)` guarded by a MySQL advisory lock and durable marker.
- Consumes: existing refund arithmetic and Task 2 settlement uniqueness.

- [ ] **Step 1: Write failing rollout tests**

Test preservation of existing balances, invalidation of unclaimed eligible flags, full refund of `matching` rooms, normal draw refund of `matched` rooms, one ledger write per refund, a durable completion marker, and a second invocation performing no balance changes.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd backend && go test ./internal/service -run TestMigrateLegacyIronFist -count=1`

Expected: FAIL because rollout migration does not exist.

- [ ] **Step 3: Implement an idempotent startup migration**

Use `GET_LOCK('ironfist-authority-rollout-v1', 30)`, a `system_migration_markers` table, row locks on candidate rooms, conditional status changes, and unique settlement references. Mark completion only after all rooms and reward flags are processed. Release the advisory lock in `defer`.

- [ ] **Step 4: Clear disposable legacy Redis keys after database success**

Use `SCAN` with the exact prefixes `ironfist:actions:` and `ironfist:action-once:` and bounded batches. Never use `KEYS` in production. Redis cleanup failure logs and retries at next startup but cannot change completed database results.

- [ ] **Step 5: Run tests and commit**

Run: `cd backend && go test ./internal/service ./pkg/redis -count=1`

```powershell
git add backend/internal/service backend/pkg/redis backend/cmd/server/main.go
git commit -m "feat: migrate legacy IronFist matches safely"
```

### Task 12: Complete transactional account erasure and frontend recovery safety

**Files:**
- Create: `backend/internal/service/ironfist_erasure.go`
- Create: `backend/internal/service/identity_delete_test.go`
- Modify: `backend/internal/service/identity.go`
- Modify: `backend/internal/handler/identity.go`
- Create: `frontend/src/stores/account-deletion.mjs`
- Create: `frontend/src/stores/account-deletion.test.mjs`
- Modify: `frontend/src/stores/identity.js`
- Modify: `frontend/src/pages/ProfilePage.vue`
- Modify: `frontend/src/components/LockScreen.vue`

**Interfaces:**
- Produces: complete FK-safe erasure, active wager resignation payout, Redis trace cleanup, and `deleteAccountThenClear(deleteRemote, clearLocal)`.
- Consumes: authoritative settlement from Task 5 and schema from Task 2.

- [ ] **Step 1: Write a failing backend deletion integration test**

Populate a user with rows in `device_tokens`, both-direction `message_reads`, `message_deliveries`, friendships, requests, all FIST tables, all legacy IronFist tables, every new authority table, an opponent ledger remark containing the deleted chat ID, and an active wagered game. Delete the account and assert zero identifying rows remain—including counterparty ledger/history rows linked to shared legacy rooms—while the opponent has exactly one new normal win payout whose remark contains only the tier and authoritative game ID.

- [ ] **Step 2: Run deletion test and verify RED**

Run: `$env:MYSQL_TEST_DSN='root:test@tcp(127.0.0.1:13316)/mysql?parseTime=true&multiStatements=true'; cd backend; go test ./internal/service -run TestDeleteAccountErasesGameData -count=1`

Expected: FAIL with the current restrictive game foreign keys.

- [ ] **Step 3: Implement stable-order settlement and erasure**

Within the existing identity transaction: lock the user, select active game IDs ordered lexically, settle deletion as PvP resignation when wagered, abandon PvE/casual, delete shared child/game/projection/room rows, delete counterparty legacy ledger rows whose room/game references or remarks identify the user, delete user-owned ledger/account/stat/history rows, delete both-direction messages and device tokens, then delete friendships, requests, and user. Any error returns before commit.

- [ ] **Step 4: Verify backend GREEN and rollback behavior**

Add a forced mid-transaction failure test and assert the user, balance, key game row, and friendships all remain.

Run: `$env:MYSQL_TEST_DSN='root:test@tcp(127.0.0.1:13316)/mysql?parseTime=true&multiStatements=true'; cd backend; go test ./internal/service -run TestDeleteAccount -count=1`

Expected: PASS.

- [ ] **Step 5: Write a failing Redis erasure test and remove ephemeral identity traces**

Use miniredis to populate `online:<chat_id>`, `offline:<chat_id>`, session-generation, legacy IronFist action keys, friend invite keys, and another user's offline list containing a message from the deleted chat ID. After database commit, `eraseAccountRedisData` deletes direct keys and scans bounded `offline:*`, `ironfist:*`, and invite prefixes to remove payloads identifying the deleted user. The test asserts unrelated messages and keys remain. Redis failure is logged and retried with bounded backoff; database deletion remains final and authentication cannot succeed for the absent user.

- [ ] **Step 6: Write a failing frontend recovery-material test**

```js
test('server deletion failure preserves all local material', async () => {
  const local = { key: true, token: true, messages: true }
  await assert.rejects(() => deleteAccountThenClear(
    async () => { throw new Error('500') },
    async () => { local.key = local.token = local.messages = false }
  ))
  assert.deepEqual(local, { key: true, token: true, messages: true })
})
```

- [ ] **Step 7: Run frontend test and verify RED, then implement ordering**

Run: `cd frontend && node --test src/stores/account-deletion.test.mjs`

Expected: FAIL because `identity.clear` swallows the server error and clears local state.

Call `identityApi.deleteAccount()` before any local mutation. On success, run the existing local cleanup; on failure, rethrow. Remove the preliminary device-token request because device rows are deleted in the server transaction.

- [ ] **Step 8: Handle UI failure without navigation**

Wrap both confirmation call sites in `try/catch`; on failure show a negative notification stating the account was not deleted and recovery data was retained. Call `router.replace` only after `identity.clear()` resolves.

- [ ] **Step 9: Run frontend tests/lint and commit**

Run: `cd frontend && node --test src/stores/account-deletion.test.mjs && npm run lint`

```powershell
git add backend/internal/service backend/internal/handler/identity.go frontend/src/stores frontend/src/pages/ProfilePage.vue frontend/src/components/LockScreen.vue
git commit -m "fix: erase accounts transactionally without losing recovery data"
```

### Task 13: Documentation, security scan, and full verification

**Files:**
- Modify: `docs/ironfist.md`
- Modify: `docs/ironfist-pvp.md`
- Modify: `docs/superpowers/specs/2026-08-04-ironfist-authoritative-engine-design.md`

**Interfaces:**
- Produces: deployment/runbook instructions and final acceptance evidence.
- Consumes: all prior tasks.

- [ ] **Step 1: Update operational documentation**

Document authoritative routes/events, UTC deadlines, explicit offline-practice trust boundary, rollout lock/marker, required migration order, Redis outbox channel, and the removal of report/claim settlement.

- [ ] **Step 2: Scan for remaining trusted client-report paths**

Run: `rg -n "reportMatch|claimPvEReward|SettlePVP\(|ironfist_action|ironfist_replay" frontend/src backend/internal backend/cmd`

Expected: no frontend trusted-mode call to report/claim, no WS raw action relay/replay handler, and no registered handler that calls report-based settlement. Any retained legacy service method is unreachable and explicitly marked deprecated.

- [ ] **Step 3: Run fresh backend verification**

Run: `cd backend && gofmt -w internal/ironfistengine internal/service internal/handler internal/ws pkg/redis migrations cmd/server`

Run: `cd backend && go test ./... -count=1`

Run: `cd backend && go test -race ./... -count=1`

Expected: all packages PASS with zero race reports.

- [ ] **Step 4: Run fresh MySQL integration verification**

Run: `$env:MYSQL_TEST_DSN='root:test@tcp(127.0.0.1:13316)/mysql?parseTime=true&multiStatements=true'; cd backend; go test ./migrations ./internal/service -count=1`

Expected: PASS with migration, concurrency, rollout, and deletion integration tests executed rather than skipped.

- [ ] **Step 5: Run fresh frontend verification**

Run: `cd frontend && npm run test:ironfist`

Run: `cd frontend && npm run test:version`

Run: `cd frontend && node --test src/stores/*.test.mjs`

Run: `cd frontend && npm run lint`

Run: `cd frontend && npm run build`

Expected: all tests pass, ESLint exits zero, and Quasar production build exits zero.

- [ ] **Step 6: Review the diff against every spec section**

Check trust boundary, persistence, PvE, PvP, presence, settlement, API, frontend, rollout, complete erasure, testing, and non-goals. Record any unmet requirement as an incomplete task rather than declaring completion.

- [ ] **Step 7: Commit documentation and verification-ready state**

```powershell
git add docs backend frontend
git commit -m "docs: document authoritative IronFist operations"
```
