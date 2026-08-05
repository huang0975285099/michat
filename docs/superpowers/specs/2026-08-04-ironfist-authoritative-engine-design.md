# IronFist Unified Server-Authoritative Engine Design

Date: 2026-08-04

Status: approved design, pending implementation plan

## Purpose

Replace IronFist's client-authoritative match and settlement paths with one server-authoritative engine for rewarded PvE, wagered PvP, and casual online PvP. The change must close three priority-one issues:

1. A losing PvP player can currently submit a false result, force a disagreement draw, and recover most of the stake.
2. A client can fabricate PvE victories and mint up to 6,000 in-app points per UTC day.
3. Account deletion fails when game rows reference the user, while the frontend still destroys local recovery material.

The currency called `$FIST` in legacy code is an in-app points balance. Offline play remains unrestricted practice and cannot affect trusted state.

## Agreed product rules

- MySQL is the authoritative store for trusted games and settlement.
- Rewarded PvE requires a server-issued online session. Offline PvE is practice only.
- Only one rewarded PvE session may be active per account.
- Rewarded PvE resumes after refresh or reconnect, expires after 30 minutes of inactivity, and is abandoned without reward when the player explicitly starts a new session.
- All online PvP, including casual friend games, uses the authoritative engine. Casual games affect trusted statistics and achievements but never balances.
- A PvP action is immutable after acceptance and hidden until the round resolves.
- A connected player who fails to act within 30 seconds defaults to `defend`.
- A disconnected player has 60 seconds to reconnect. Expiry is a forfeit and pays the connected opponent as a normal winner.
- If both players remain disconnected through their reconnect deadlines, the game is a draw with the normal draw fee.
- Resignation is an immediate forfeit.
- Match completion automatically settles all rewards and payouts. There is no client-triggered claim or result report.
- Rollout preserves already credited balances, invalidates pending legacy PvE rewards, and refunds open legacy PvP rooms. There are no clawbacks.
- Account deletion completely erases user-linked data, even when this decreases historical aggregates.

## Trust boundary

Clients submit intent only. For an action, the trusted input is:

```json
{
  "round": 4,
  "action": "counter",
  "request_id": "6e7060d4-0c83-49fc-815a-800ad3b84a2e",
  "expected_version": 8
}
```

Clients never submit authoritative HP, damage, opponent actions, results, rewards, settlement choices, or deadlines. Client timestamps are ignored.

The backend owns:

- match creation and participant seats;
- initial state and rules version;
- legal-action validation;
- turn and reconnect deadlines;
- private PvE AI decisions;
- deterministic round resolution;
- match outcome;
- statistics and achievements;
- balance, fee, daily-progress, and ledger settlement.

Redis may carry presence, notifications, rate limits, and disposable caches. Losing Redis data cannot change match state or settlement. Recovery always reads MySQL.

## Backend architecture

Create a pure Go IronFist rules package containing:

- action and state types;
- versioned constants and damage table;
- initial-state construction;
- deterministic round resolution;
- terminal-outcome calculation;
- deterministic PvE AI selection from server-only randomness;
- achievement facts derived from authoritative rounds.

The service layer surrounds the pure engine with authenticated commands and database transactions. Every state-changing command:

1. authenticates the user and resolves their seat;
2. locks the game row with `SELECT ... FOR UPDATE`;
3. advances any overdue deadline before accepting new input;
4. validates the current round and expected state version;
5. inserts the immutable action or returns the prior idempotent response;
6. resolves the round when all required actions exist;
7. persists the new state and audit rows;
8. atomically settles a terminal game;
9. writes notification events to a transactional outbox;
10. commits before publishing notifications.

A deadline worker scans due games and runs the same locked transition functions used by request handling. Normal requests also advance overdue games, so worker delay affects notification latency but not correctness.

## Persistence model

Add these authoritative tables:

### `ironfist_games`

Stores one row per trusted game:

- UUID primary key;
- mode: rewarded PvE, wagered PvP, or casual PvP;
- status: waiting, active, completed, abandoned, or cancelled;
- player A and optional player B user IDs;
- optional wager-room ID;
- immutable rules version;
- current round and monotonic state version;
- authoritative JSON state snapshot;
- server-only PvE AI seed and AI history when applicable;
- action and disconnect deadlines for each seat;
- last activity and expiry timestamps;
- authoritative result, winner, finish reason, and finished timestamp;
- settlement timestamp or unique settlement key.

The state snapshot contains HP, charge flags and ages, consecutive no-damage rounds, total rounds, both-charged stalemate state, and other versioned engine state. Frequently queried lifecycle fields remain typed columns rather than being buried in JSON.

### `ironfist_game_actions`

Stores locked actions with:

- game ID, round, and seat;
- action;
- source: player, deadline default, or AI;
- authenticated user ID when player-supplied;
- request ID and acceptance timestamp.

`(game_id, round, seat)` is unique. A user request ID is also unique within its game, allowing retries to return the original accepted result. Unresolved opponent actions are never returned to clients.

### `ironfist_game_rounds`

Stores the resolved audit trail:

- game ID and round;
- both resolved actions;
- damage to each player and environmental damage;
- post-round authoritative state;
- resolution reason and timestamp.

`(game_id, round)` is unique.

### `ironfist_active_pve`

Maps each user to at most one active rewarded PvE game. Starting a replacement locks this row, abandons the previous game without reward, and installs the new game atomically. Finishing, resigning, or expiring removes the mapping.

### Transactional outbox

Stores post-commit game events with a unique event ID, game ID, state version, payload, and delivery status. A publisher retries delivery. Clients can always recover missed events by fetching authoritative state.

### Existing tables

- `ironfist_pvp_rooms` remains responsible for matchmaking and stake escrow. A matched room links one-to-one to an authoritative game; reports no longer influence settlement.
- `ironfist_matches` becomes a per-user history projection written only by authoritative settlement. Add an authoritative game ID and uniqueness per user/game.
- `ironfist_stats`, `ironfist_achievements`, `fist_accounts`, `fist_transactions`, and `pve_daily_progress` remain projections or settlement records updated inside the terminal-game transaction.
- `pvp_matches` and `pvp_rounds` are deprecated legacy prototype tables and receive no new writes.
- `report_a`, `report_b`, `pve_reward_eligible`, and `pve_reward_claimed_at` no longer participate in trusted decisions.

All game timestamps and daily reward boundaries use UTC. Settlement ledger rows have a database uniqueness constraint covering user, settlement type, and authoritative reference so retries cannot pay twice.

## Rewarded PvE lifecycle

1. The authenticated player requests a server-issued rewarded session.
2. An explicit new-game request abandons the previous active session. A resume query returns it instead.
3. The server generates and stores a cryptographically random private seed and initial authoritative state.
4. For each accepted player action, the server derives the AI action deterministically from the private seed, rules version, round, and pre-round state.
5. The server records both actions, resolves the round, persists state, and returns the resolved view.
6. Thirty minutes without activity abandons the session without a reward.
7. A completed win updates trusted history, statistics, and achievements.
8. In the same transaction, the first ten wins per UTC day each add 500 points. The tenth adds the existing 1,000-point bonus. Later wins update trusted records but add no points.

The AI seed is not disclosed while the game is active. The client cannot choose the seed, AI action, session ID, or result.

## PvP lifecycle

### Match creation

Wager matchmaking escrows stakes using the existing tier rules. When two players match, the same transaction creates the authoritative game and links it to the room. Casual friend acceptance creates an authoritative game without an escrow room.

### Turns

- Both clients receive the same public state, current round, state version, server time, and deadline.
- The first valid action per seat is immutable.
- Acceptance may publish a `player_locked` notification but never reveals the action.
- Once both actions are present, the service resolves immediately and publishes the authoritative round.
- A connected player missing the 30-second deadline receives a server-generated `defend` action.

### Presence and reconnect

A player is connected while at least one authenticated WebSocket connection for that account is present. On last-connection loss, the service records the remaining action time, pauses that seat's action deadline, and starts a 60-second disconnect deadline. Reconnect clears the disconnect deadline and resumes the remaining action time.

- If only one disconnect deadline expires, that player forfeits.
- If both players are still disconnected when both deadlines expire, the result is a draw.
- If one player reconnects before the other expires, the disconnected player forfeits when their deadline expires.
- Resignation immediately produces a forfeit.

Presence messages are hints that trigger persisted transitions; Redis presence alone is never match authority.

### Settlement

Terminal settlement writes, in one database transaction:

- authoritative game outcome;
- per-user match history;
- statistics and achievements;
- wager-room outcome;
- winner payout, draw refunds, and fees;
- balance updates and uniquely keyed ledger entries;
- terminal outbox events.

Client reports and report disagreement have no role. Simultaneous retries serialize on the game row and observe the already settled state.

## HTTP API and WebSocket contract

Use authenticated HTTP for commands and queries:

- `POST /games/ironfist/pve/sessions` starts or explicitly replaces a rewarded session.
- `GET /games/ironfist/sessions/active` resumes the caller's active session.
- `GET /games/ironfist/games/:id` returns the caller-visible authoritative state.
- `POST /games/ironfist/games/:id/actions` accepts one action command.
- `POST /games/ironfist/games/:id/resign` resigns PvP or abandons PvE.
- Existing PvP queue endpoints continue to manage matchmaking and return a `game_id` when matched.
- Friend invitation acceptance creates and returns a casual authoritative `game_id`.

Use WebSocket for notifications:

- `ironfist_game_ready`;
- `ironfist_player_locked`;
- `ironfist_round_resolved`;
- `ironfist_presence_changed`;
- `ironfist_game_finished`.

Every event includes game ID, state version, server time, and applicable deadlines. Clients discard older versions and refetch on a version gap.

Expected command errors:

- `400` for malformed actions or request IDs;
- `403` for a non-participant;
- `404` for an unknown game;
- `409 action_locked` when an action is already immutable;
- `409 stale_state` for an old round or expected version;
- `409 game_finished` after terminal state;
- `410 session_expired` for an expired rewarded PvE session.

Repeating an accepted request ID returns the original authoritative response.

## Frontend behavior

- Trusted PvE and online PvP do not use the JavaScript resolver to decide state.
- The renderer animates server-provided actions, damage, and post-round state.
- The JavaScript resolver remains for offline practice only.
- Input locks only after server acceptance and unlocks from authoritative state.
- Refresh and reconnect fetch the current game; local storage is not authoritative.
- Opponent actions remain hidden until the resolved-round event.
- Remove client calls that report results, settle PvP, or claim PvE rewards.
- Keep shared golden fixtures that run through both Go authoritative rules and the JavaScript practice resolver to detect drift.

## Legacy rollout

Use a short maintenance gate for game entry:

1. Add the new schema and deploy the authoritative backend while new game entry is disabled.
2. Preserve existing account balances and all already-posted transactions.
3. Mark pending legacy client-reported PvE rewards ineligible.
4. Cancel and refund every legacy `matching` or `matched` wager room.
5. Delete legacy Redis IronFist action streams.
6. Disable result-report and reward-claim endpoints with an explicit upgrade-required response.
7. Deploy the new frontend and enable authoritative game creation.

There are no reward clawbacks, and no legacy match is allowed to cross the trust-model boundary.

## Complete account erasure

Account deletion is a single database transaction. It first locks the user and active shared games in stable order.

- Deletion during wagered PvP counts as immediate resignation. The opponent receives the normal authoritative win payout before erasure.
- Active casual PvP and rewarded PvE are abandoned without rewards.
- Delete outbox rows, active-session mappings, actions, rounds, authoritative games, shared match projections, wager rooms, and legacy PvP records involving the user.
- Delete the user's match history, achievements, statistics, daily progress, ledger entries, and points account.
- Delete device tokens, message receipts in both directions, message deliveries, friend requests, and friendships.
- Delete the user row last.

Any error rolls back settlement and deletion. After commit, the backend invalidates sessions, presence, rate-limit/cache keys, queued notifications, and game action keys in Redis. Redis cleanup failure does not resurrect access because the user no longer exists.

Shared match erasure may reduce historical aggregates and remove that match from the opponent's history. An opponent payout that was already created during resignation remains, but contains no deleted-user identity.

The frontend clears the private key, token, messages, and local identity only after the server confirms deletion. On any timeout or error it retains all recovery material and presents a retry path. Device-token deletion is part of the server transaction rather than a client prerequisite.

## Testing and acceptance criteria

### Rules engine

- Cover all 16 action pairs and symmetry expectations.
- Cover charged attacks, charge aging, interrupted charge, low-HP enhancement, low-HP shield, environmental damage, both-charged reset, simultaneous knockout, and maximum-round decisions.
- Run common golden fixtures through Go and JavaScript practice resolution.

### Transaction and concurrency behavior

- Concurrent duplicate action requests store one action.
- Conflicting requests for the same seat cannot replace a locked action.
- Simultaneous second actions resolve a round once.
- Concurrent terminal commands settle balances and ledger rows once.
- Outbox retries do not duplicate state transitions or settlement.

### Adversarial behavior

- Reject user-supplied HP, damage, result, reward, opponent action, and deadline fields.
- Reject access to another user's game and stale/future rounds.
- Confirm an unresolved opponent action cannot be observed through HTTP, WebSocket, logs returned to the client, or reconnect state.
- Confirm no server-issued rewarded PvE game means no reward path.

### Lifecycle behavior

- Test PvE creation, resume, explicit replacement, inactivity expiry, AI determinism, daily cap, automatic 500-point rewards, and the 1,000-point tenth-win bonus.
- Test PvP action hiding, deadline defense, reconnect with remaining time, one-sided forfeit, simultaneous-disconnect draw, resignation, casual no-stake settlement, and exact wager accounting.

### Deletion and migration

- Populate every legacy and new user-linked table, delete the account, and verify no references or identifying rows remain.
- Delete a user during wagered PvP and verify the opponent receives exactly one normal payout.
- Force a deletion failure and verify the database transaction rolls back and the frontend retains all local recovery material.
- Verify legacy open-room refunds, pending reward invalidation, Redis cleanup, and preservation of already credited balances.

### Completion gate

- Backend unit, integration, migration, and race tests pass.
- Frontend unit tests and rules parity fixtures pass.
- Frontend lint and production build pass.
- No trusted frontend path invokes client result reporting, PvP settlement reporting, or PvE reward claiming.

## Explicit non-goals

- Offline practice does not receive trusted persistence, rewards, rankings, or achievements.
- Previously credited suspicious rewards are not clawed back.
- The design does not introduce blockchain settlement or make points withdrawable.
- Redis is not promoted to authoritative match storage.
