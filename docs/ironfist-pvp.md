# IronFist PvP operations

PvP matchmaking escrows both stakes and creates one `ironfist_games.game_id` in the same database transaction. Both clients receive that identical ID and must use the authoritative HTTP action endpoint. A room ID is never sufficient authority to play or settle a match.

MySQL owns actions, resolved rounds, deadlines, presence transitions, outcomes and settlement. The transactional outbox publishes disposable notifications on `ironfist:events`; clients refetch the game view after gaps. Client-reported outcomes and raw WebSocket action/replay messages are rejected.

At rollout, `MigrateLegacyIronFist` takes the advisory lock `ironfist-authority-rollout-v1`, invalidates old unclaimed PvE flags, fully refunds unmatched rooms, applies the normal draw fee to matched rooms, and writes the durable marker only after commit. Redis cleanup uses bounded `SCAN` operations for `ironfist:actions:*` and `ironfist:action-once:*`.

Account deletion is transactional. Active wagered games first settle as a resignation by the deleting player; shared game rows and identifying projections are then erased before the user row. The client retains its private key, token and messages unless the server deletion succeeds.
