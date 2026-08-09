# Video Call Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate call acceptance, terminate active calls when call listeners are disposed, and replay an incoming offer that arrives before the UI listener mounts.

**Architecture:** Keep the existing Pinia/WebRTC architecture. Add a store-level accept-operation guard, make the call listener cleanup own active-call teardown, and extend the existing bounded WebSocket early buffer to cover only `call_offer`.

**Tech Stack:** Vue 3, Pinia, Quasar, WebRTC, native WebSocket, Vite, Node.js test runner.

## Global Constraints

- Preserve the user's existing uncommitted changes in `frontend/src/stores/call.js`.
- Do not change the backend signaling protocol or add dependencies.
- Leaving `MainLayout` must send `call_hangup` when signaling is available, then always release local media and close the peer connection.
- Buffer only an early `call_offer`; later signaling such as ICE, answers, and restart messages remains session-bound and must not be replayed without an active call.
- Do not stage or commit the user's pre-existing `frontend/src/stores/call.js` hunks with implementation work.

---

### Task 1: Make accepting an incoming call single-flight

**Files:**
- Create: `frontend/src/stores/call.test.mjs`
- Modify: `frontend/src/stores/call.js:37-60,291-331,393-427,553-558`
- Modify: `frontend/src/components/IncomingCallDialog.vue:17`

**Interfaces:**
- Consumes: existing `useCallStore().answerCall()` and WebSocket call events.
- Produces: reactive `useCallStore().answering: Ref<boolean>` and a single-flight `answerCall()` contract.

- [ ] **Step 1: Write the failing duplicate-accept test**

Create a Vite SSR test harness that imports the real call store while replacing only the WebSocket and TURN API boundaries. Install fake media streams and peer connections, deliver one valid `call_offer`, and invoke `answerCall()` twice concurrently:

```js
test('accepting one incoming call concurrently acquires media and answers once', async () => {
  const env = await createCallHarness()
  try {
    env.emit('call_offer', {
      from: 'peer-a',
      call_id: '11111111-1111-4111-8111-111111111111',
      sdp: { type: 'offer', sdp: 'v=0' },
      media: 'video',
    })

    await Promise.all([env.store.answerCall(), env.store.answerCall()])

    assert.equal(env.getUserMediaCalls(), 1)
    assert.equal(env.peerConnections.length, 1)
    assert.equal(env.sent.filter(({ type }) => type === 'call_answer').length, 1)
    assert.equal(env.store.answering, false)
  } finally {
    await env.dispose()
  }
})
```

The harness must return complete fake `MediaStream` and `RTCPeerConnection` behavior used by the store, track every created resource, and call `store.hangup()` before closing Vite so connection timers cannot outlive the test.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test src/stores/call.test.mjs
```

Expected: FAIL because the current store calls `getUserMedia()` twice and creates two peer connections.

- [ ] **Step 3: Implement the single-flight guard**

Add a reactive flag and generation counter:

```js
const answering = ref(false)
let answerAttemptGeneration = 0
```

Guard and bracket `answerCall()`:

```js
async function answerCall() {
  if (state.value !== 'ringing' || !pendingOffer || answering.value) return
  const answerAttempt = ++answerAttemptGeneration
  answering.value = true
  // existing answer flow
  try {
    // existing body
  } finally {
    if (answerAttemptGeneration === answerAttempt) answering.value = false
  }
}
```

Invalidate old attempts in `cleanup()` before resetting public state:

```js
answerAttemptGeneration++
answering.value = false
```

Return `answering` from the store. Bind the answer button with both `:loading="callStore.answering"` and `:disable="callStore.answering"` so UI and programmatic callers share the same state.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node --test src/stores/call.test.mjs
```

Expected: PASS with one media request, one peer connection, and one answer signal.

- [ ] **Step 5: Keep implementation changes unstaged until selective staging is verified**

Run:

```powershell
git diff -- frontend/src/stores/call.js frontend/src/components/IncomingCallDialog.vue frontend/src/stores/call.test.mjs
git status --short
```

Expected: the user's original `call.js` hunks remain present alongside the new changes; no production commit is created until those hunks can be excluded safely.

---

### Task 2: Tear down an active call when listeners are disposed

**Files:**
- Modify: `frontend/src/stores/call.test.mjs`
- Modify: `frontend/src/stores/call.js:532-550`

**Interfaces:**
- Consumes: `useCallStore().startListening(): () => void` and existing `hangup()` behavior.
- Produces: listener cleanup that sends `call_hangup` and synchronously releases the active call before unregistering callbacks.

- [ ] **Step 1: Write the failing listener-disposal test**

Use the Task 1 harness to answer one incoming video call, call the cleanup returned by `startListening()`, and assert consumer-visible resource state:

```js
test('disposing call listeners hangs up and releases active media', async () => {
  const env = await createCallHarness()
  try {
    env.emit('call_offer', {
      from: 'peer-a',
      call_id: '22222222-2222-4222-8222-222222222222',
      sdp: { type: 'offer', sdp: 'v=0' },
      media: 'video',
    })
    await env.store.answerCall()

    env.stopListening()

    assert.equal(env.store.state, 'idle')
    assert.equal(env.sent.filter(({ type }) => type === 'call_hangup').length, 1)
    assert.ok(env.streams.every(stream => stream.getTracks().every(track => track.stopped)))
    assert.ok(env.peerConnections.every(connection => connection.closed))
  } finally {
    await env.dispose()
  }
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test src/stores/call.test.mjs
```

Expected: FAIL because the current cleanup only unregisters callbacks and leaves store state `active`.

- [ ] **Step 3: Make listener disposal own call teardown**

Update the function returned by `startListening()`:

```js
return () => {
  if (state.value !== 'idle') hangup()
  off('call_offer', onCallOffer)
  // existing off(...) calls
}
```

Call `hangup()` before unregistering listeners so the local session is ended and the peer receives a best-effort hangup signal. Do not add route-specific cleanup to `MainLayout`; its existing `stopCallListening?.()` call is the lifecycle integration point.

- [ ] **Step 4: Run both store tests and verify GREEN**

Run:

```powershell
node --test src/stores/call.test.mjs
```

Expected: both duplicate-accept and listener-disposal tests PASS without timers or open handles.

- [ ] **Step 5: Inspect the combined call-store diff**

Run:

```powershell
git diff --check
git diff -- frontend/src/stores/call.js frontend/src/components/IncomingCallDialog.vue frontend/src/stores/call.test.mjs
```

Expected: only the approved behavior changes and the pre-existing user hunks are present.

---

### Task 3: Replay an offer received before listener registration

**Files:**
- Create: `frontend/src/services/websocket-call-offer.test.mjs`
- Modify: `frontend/src/services/websocket.js:22-42`
- Modify: `frontend/package.json:6-17`

**Interfaces:**
- Consumes: `connect()`, `on(type, callback)`, `off(type, callback)`, and `disconnect()` from `src/services/websocket.js`.
- Produces: exact-once early replay for `call_offer`; no early replay for `call_ice`.

- [ ] **Step 1: Write the failing early-offer replay test**

Install a complete fake WebSocket at the browser boundary, authenticate the real singleton service, deliver an offer before registering its listener, and assert replay:

```js
test('replays an incoming call offer that arrived before listener registration', async () => {
  const env = await createWebSocketHarness()
  try {
    await env.websocket.connect()
    env.socket.emit('call_offer', { from: 'peer-a', call_id: 'call-1' })

    const received = []
    env.websocket.on('call_offer', payload => received.push(payload))

    assert.deepEqual(received, [{ from: 'peer-a', call_id: 'call-1' }])
  } finally {
    env.websocket.disconnect()
    env.restore()
  }
})
```

Use a cache-busting module query per harness so each test gets fresh module-level WebSocket state.

- [ ] **Step 2: Write the non-offer transient-signal test**

```js
test('does not replay session-bound ICE received without a call listener', async () => {
  const env = await createWebSocketHarness()
  try {
    await env.websocket.connect()
    env.socket.emit('call_ice', { from: 'peer-a', call_id: 'call-1', ice: { candidate: 'x' } })

    const received = []
    env.websocket.on('call_ice', payload => received.push(payload))

    assert.deepEqual(received, [])
  } finally {
    env.websocket.disconnect()
    env.restore()
  }
})
```

- [ ] **Step 3: Run the WebSocket tests and verify RED**

Run:

```powershell
node --test src/services/websocket-call-offer.test.mjs
```

Expected: the offer replay test FAILS with an empty received array, while the ICE test already passes.

- [ ] **Step 4: Add only `call_offer` to the bounded early buffer**

Change the production set to:

```js
const BUFFERED_TYPES = new Set([
  'message', 'read_receipt', 'read_ack', 'ack', 'recall', 'file_done', 'call_offer',
])
```

Update the adjacent comment to distinguish cold-start listener replay from backend offline persistence. Do not add other call signaling types.

- [ ] **Step 5: Add and run the focused package test script**

Add:

```json
"test:call": "node --test src/stores/call.test.mjs src/services/websocket-call-offer.test.mjs"
```

Run:

```powershell
pnpm run test:call
```

Expected: all call reliability tests PASS.

---

### Task 4: Full verification and handoff

**Files:**
- Verify: `frontend/src/stores/call.js`
- Verify: `frontend/src/components/IncomingCallDialog.vue`
- Verify: `frontend/src/services/websocket.js`
- Verify: `frontend/src/stores/call.test.mjs`
- Verify: `frontend/src/services/websocket-call-offer.test.mjs`
- Verify: `frontend/package.json`

**Interfaces:**
- Consumes: all deliverables from Tasks 1-3.
- Produces: verified source changes with the user's original `call.js` edits preserved and unstaged from any selective commit.

- [ ] **Step 1: Run every existing Node test**

Run:

```powershell
node --test src/**/*.test.mjs
```

Expected: zero failed tests.

- [ ] **Step 2: Run lint**

Run:

```powershell
pnpm run lint
```

Expected: exit code 0 with no ESLint errors.

- [ ] **Step 3: Run the production build**

Run:

```powershell
pnpm run build
```

Expected: exit code 0 and `Build succeeded`.

- [ ] **Step 4: Audit the final diff and workspace**

Run:

```powershell
git diff --check
git status --short
git diff -- frontend/src/stores/call.js frontend/src/components/IncomingCallDialog.vue frontend/src/services/websocket.js frontend/src/stores/call.test.mjs frontend/src/services/websocket-call-offer.test.mjs frontend/package.json
```

Expected: no whitespace errors, no generated artifacts, and the original user changes in `call.js` remain intact.

- [ ] **Step 5: Report exact verification evidence**

Report the number of call tests and total Node tests passed, lint/build exit status, modified files, retained user changes, and any environment limitation affecting real-camera end-to-end testing.
