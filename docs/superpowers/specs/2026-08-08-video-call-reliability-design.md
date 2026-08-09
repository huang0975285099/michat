# Video Call Reliability Design

## Goal

Fix three confirmed frontend video-call defects without redesigning the existing WebRTC architecture:

1. Repeatedly accepting one incoming call can create multiple media streams and peer connections.
2. Leaving `MainLayout` can leave an active call and local camera or microphone running.
3. A `call_offer` received after WebSocket authentication but before call listeners mount is dropped.

## Constraints

- Preserve the user's existing uncommitted changes in `frontend/src/stores/call.js`.
- Do not change the backend signaling protocol or add dependencies.
- Leaving `MainLayout` must send `call_hangup` when signaling is available, then always release local media and close the peer connection.
- Buffer only an early `call_offer`; later signaling such as ICE, answers, and restart messages remains session-bound and must not be replayed without an active call.

## Design

### Accept-call mutual exclusion

`useCallStore` will expose a reactive `answering` flag. `answerCall()` will reject re-entry while the current accept attempt is in progress. An attempt generation token will ensure that completion of an old permission or TURN request cannot clear the flag belonging to a newer call.

The incoming-call answer button will use `answering` for loading and disabling. This is a user-facing guard in addition to the store-level correctness guard; programmatic duplicate calls remain safe.

`cleanup()` will invalidate the current accept attempt and reset `answering`. Existing session checks will continue stopping media returned after a call has already ended.

### Listener disposal owns call cleanup

The cleanup function returned by `startListening()` will hang up any non-idle call before unregistering its WebSocket callbacks. `MainLayout` already invokes this cleanup during unmount, so the responsibility stays at the call-listener lifecycle boundary instead of being duplicated in route-specific code.

`hangup()` will make a best-effort `call_hangup` send and then synchronously call the existing local `cleanup()`. This guarantees camera, microphone, timers, streams, and the peer connection are released even when signaling is unavailable.

### Early incoming-offer replay

`call_offer` will be added to the WebSocket service's bounded early-arrival buffer. If it arrives with no registered call listener, the existing `on(type, callback)` replay path will deliver it once `MainLayout` mounts.

Only `call_offer` is added. `call_answer`, `call_ice`, hangup, rejection, and ICE-restart messages require an already-created local session and will continue to be discarded when no listener exists.

## Testing

Node tests will exercise the real store and WebSocket modules with browser and network boundaries stubbed only where unavoidable.

- Two concurrent `answerCall()` invocations must request media once, create one peer connection, and send one answer.
- Disposing call listeners during an active call must send one hangup, stop every local track, close the peer connection, and return the store to `idle`.
- A `call_offer` received before listener registration must be replayed exactly once when the listener registers.
- Non-offer transient call signaling must not be replayed without a session.

The final verification set is the focused call tests, all existing Node tests, ESLint, and the production Quasar build.

## Out of Scope

- Replacing the call store with a new finite-state-machine framework.
- Persisting calls while the peer is offline.
- Changing TURN configuration, media constraints, or ICE-restart behavior.
- Fixing unrelated routing or account-deletion behavior.
