# Session, migration and lock-time signaling fixes

## Session validation and authentication feedback

WebSocket messages no longer query Redis for session validity individually.
Binding validates a new connection before it can serve traffic. Active
connections retain the five-second monitor and process-local revocation
notifications. Explicitly expired, replaced, malformed or revoked sessions
are rejected immediately when detected.

A Redis or network error is distinct from an invalid session. An active
connection whose last successful check was less than 30 seconds ago remains
connected during that temporary error. The monitor closes it on a failed
check after that grace window. This is a bounded availability tradeoff; the
monitor interval and validation duration determine the precise close time.
Explicit revocation still takes effect during the grace window. Notifications
are local to a server process; other processes detect invalidation by polling.

New connections do not receive this grace. Binding failure unsubscribes and
stops the client without closing the socket until the handler has written
`auth_result(false)`. Temporary failures include `retryable: true`; updated
clients retry with their existing backoff. Definitive authentication failures
stop automatic retries. The session token and reliable outbox are preserved.

## Database migration versions

`schema_migrations` records each completed migration by its existing file
version. One dedicated connection holds a database-scoped MySQL advisory lock
while applying migrations, preventing simultaneous startup migrations.

On the first upgrade from an installation without this table, the existing
idempotent migrations run once and are recorded. Later startups skip them.
For 035, table creation precedes a transaction containing the delivery backfill
and its version record. The 036 updates and version record also commit together.
A failure rolls back those DML changes and leaves the version available for
retry. Older migrations contain MySQL DDL with implicit commits, so interrupted
older migrations may still need their existing idempotent retry behavior.

## Missing keys and lock-time hangup

Read and recall signing rejects missing private keys with an explicit error
instead of dereferencing a missing key record.

Before an outgoing call sends its offer, and while preparing an incoming call,
the unlocked client signs a hangup envelope for that exact account, peer and
random call ID. It retains the signed envelope, not the private key. Hangup
can send this envelope synchronously after locking, while cleanup immediately
stops media and discards call state.

Only a signed `call_hangup` with `prepared: true` for the receiver's currently
active call may outlive the ordinary 60-second signaling freshness window.
Signature, peer/account binding, future-time checks and replay protection
remain enforced. Prepared envelopes for ended or unrelated calls are rejected;
offers, ICE and other controls retain normal freshness checks. Both clients
need this update for prepared hangups on long calls; older receivers retain
their existing disconnection fallback.

## Tests

- Session tests cover normal revocation, temporary Redis errors, recovery,
  grace expiry and the absence of per-message validation calls.
- A real WebSocket test checks that binding failures arrive as authentication
  frames before socket close, including a revocation during binding.
- A recording SQL driver checks that second startup skips backfills, failed
  version recording is retried, and updates cannot run outside their transaction.
- Frontend regressions cover unavailable keys, retryable authentication,
  lock-time hangup without loading keys, long calls and prepared-envelope replay.

MySQL integration tests require `MYSQL_TEST_DSN`; driver-level tests do not
replace a real MySQL upgrade rehearsal.
