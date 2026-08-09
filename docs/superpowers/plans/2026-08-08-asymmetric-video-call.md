# Asymmetric Video Call Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep requested video calls connected when either camera is unavailable, allow either participant to begin sending video later, and show explicit local and remote camera state.

**Architecture:** Separate mandatory audio acquisition from optional video acquisition, then pre-negotiate a bidirectional video transceiver for every video call. Carry initial camera state in offer/answer messages and dynamic changes in a transient `call_media_state` relay so the UI never mistakes voice-only participation for a stalled video connection.

**Tech Stack:** Vue 3, Pinia, Quasar, WebRTC, native WebSocket, Vite, Node.js test runner, Go WebSocket backend.

## Global Constraints

- Preserve all existing uncommitted frontend video-call fixes and tests.
- Do not add frontend or backend dependencies.
- Audio is mandatory; camera acquisition, denial, occupation, and disconnection are non-fatal.
- Video calls always pre-negotiate one bidirectional video transceiver; audio calls remain audio-only.
- `call_media_state` is authenticated, friend-authorized, session-bound, transient, and never early-buffered or stored offline.
- Late media-acquisition results must be session-checked and stopped rather than attached to a newer call.
- Keep implementation changes uncommitted in the working tree unless the user separately authorizes implementation commits.

---

### Task 1: Separate mandatory audio from optional camera acquisition

**Files:**
- Create: `frontend/src/stores/call-media.mjs`
- Create: `frontend/src/stores/call-media.test.mjs`

**Interfaces:**
- Produces: `acquireCallMedia(mediaDevices, { video, facingMode, videoConstraints }): Promise<{ stream: MediaStream, videoError: Error|null }>`.
- Contract: audio failure rejects; video failure resolves with the live audio stream and the camera error.

- [ ] **Step 1: Write the failing optional-camera tests**

Use complete fake streams whose tracks record `stop()` and support `addTrack()`:

```js
test('keeps mandatory audio when camera acquisition fails', async () => {
  const audio = fakeStream(['audio'])
  const cameraError = Object.assign(new Error('no camera'), { name: 'NotFoundError' })
  const mediaDevices = {
    async getUserMedia(constraints) {
      if (constraints.audio) return audio
      throw cameraError
    },
  }

  const result = await acquireCallMedia(mediaDevices, {
    video: true,
    facingMode: 'user',
    videoConstraints: { width: { ideal: 1280 }, height: { ideal: 720 } },
  })

  assert.equal(result.stream, audio)
  assert.equal(result.stream.getAudioTracks().length, 1)
  assert.equal(result.stream.getVideoTracks().length, 0)
  assert.equal(result.videoError, cameraError)
})

test('rejects when mandatory audio acquisition fails', async () => {
  const microphoneError = Object.assign(new Error('no microphone'), { name: 'NotFoundError' })
  await assert.rejects(
    () => acquireCallMedia({ getUserMedia: async () => { throw microphoneError } }, {
      video: true,
      facingMode: 'user',
      videoConstraints: {},
    }),
    microphoneError,
  )
})

test('stops every camera-stream track when no video track is returned', async () => {
  const audio = fakeStream(['audio'])
  const strayCameraAudio = fakeTrack('audio')
  const camera = fakeStream([], [strayCameraAudio])
  const mediaDevices = {
    async getUserMedia(constraints) {
      return constraints.audio ? audio : camera
    },
  }

  const result = await acquireCallMedia(mediaDevices, {
    video: true,
    facingMode: 'user',
    videoConstraints: {},
  })

  assert.equal(result.videoError.name, 'NotFoundError')
  assert.equal(strayCameraAudio.stopped, true)
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
node --test src/stores/call-media.test.mjs
```

Expected: FAIL because `call-media.mjs` and `acquireCallMedia` do not exist.

- [ ] **Step 3: Implement the acquisition helper**

Implement audio-first acquisition and attach the first live camera track to the audio stream:

```js
export async function acquireCallMedia(mediaDevices, options) {
  const stream = await mediaDevices.getUserMedia({ audio: true, video: false })
  if (!options.video) return { stream, videoError: null }

  try {
    const cameraStream = await mediaDevices.getUserMedia({
      audio: false,
      video: { ...options.videoConstraints, facingMode: options.facingMode },
    })
    const videoTrack = cameraStream.getVideoTracks()[0]
    if (!videoTrack) {
      cameraStream.getTracks().forEach(track => track.stop())
      throw Object.assign(new Error('camera returned no video track'), { name: 'NotFoundError' })
    }
    stream.addTrack(videoTrack)
    cameraStream.getTracks().filter(track => track !== videoTrack).forEach(track => track.stop())
    return { stream, videoError: null }
  } catch (videoError) {
    return { stream, videoError }
  }
}
```

If the camera stream contains no video track, stop all tracks from that camera stream before returning the error.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```powershell
node --test src/stores/call-media.test.mjs
```

Expected: all media-acquisition tests PASS with no open handles.

---

### Task 2: Pre-negotiate asymmetric video for caller and receiver

**Files:**
- Modify: `frontend/src/stores/call.js:21-35,114-123,181-208,219-335,397-435,560-568`
- Modify: `frontend/src/stores/call.test.mjs`

**Interfaces:**
- Consumes: `acquireCallMedia(...)` from Task 1.
- Produces: `localVideoOn: Ref<boolean>`, `remoteVideoOn: Ref<boolean|null>`, and WebRTC sessions that contain one audio sender plus one negotiated video transceiver for video calls.

- [ ] **Step 1: Extend the real-store test harness**

Make the media-device fake queue independent audio/video outcomes and make `FakeRTCPeerConnection` implement:

```js
addTransceiver(trackOrKind, init)
getTransceivers()
getSenders()
createOffer()
setLocalDescription(description)
setRemoteDescription(description)
```

Each fake transceiver must expose `{ direction, sender: { track, replaceTrack() }, receiver: { track: { kind: 'video' } } }`. The assertions must inspect the real store's resulting state and the fake connection's sender/transceiver state, not merely whether the fake methods were called.

- [ ] **Step 2: Write the failing initiator-without-camera test**

```js
test('a video caller without a camera still offers receive-capable video', async () => {
  const env = await createCallHarness({ camera: new DOMException('missing', 'NotFoundError') })
  try {
    await env.store.startCall('peer-a', 'Peer A', 'video')

    assert.equal(env.store.state, 'calling')
    assert.equal(env.store.localVideoOn, false)
    assert.equal(env.store.localStream.getAudioTracks().length, 1)
    assert.equal(env.store.localStream.getVideoTracks().length, 0)
    assert.equal(env.peerConnections[0].videoTransceiver.direction, 'sendrecv')
    assert.equal(env.peerConnections[0].videoTransceiver.sender.track, null)
    assert.equal(env.sent.find(({ type }) => type === 'call_offer').payload.media, 'video')
  } finally {
    await env.dispose()
  }
})
```

- [ ] **Step 3: Write the failing receiver-without-camera test**

Deliver a video offer whose fake remote description creates a video transceiver, then answer with camera acquisition rejected:

```js
assert.equal(env.store.state, 'active')
assert.equal(env.store.localVideoOn, false)
assert.equal(env.sent.filter(({ type }) => type === 'call_answer').length, 1)
assert.equal(env.sent.filter(({ type }) => type === 'call_reject').length, 0)
assert.equal(env.peerConnections[0].videoTransceiver.sender.track, null)
```

- [ ] **Step 4: Run the store tests and verify RED**

Run:

```powershell
node --test src/stores/call.test.mjs
```

Expected: new tests FAIL because combined audio/video acquisition aborts and no video transceiver is reserved without a camera.

- [ ] **Step 5: Integrate optional camera acquisition and transceivers**

Replace `cameraOn` with:

```js
const localVideoOn = ref(false)
const remoteVideoOn = ref(null)
const cameraStarting = ref(false)
```

For both `startCall()` and `answerCall()`:

```js
const { stream, videoError } = await acquireCallMedia(
  navigator.mediaDevices,
  { video: isVideo(), facingMode, videoConstraints: VIDEO_CONSTRAINTS },
)
localStream.value = stream
localVideoOn.value = stream.getVideoTracks().some(track => track.readyState !== 'ended')
if (videoError) notifyCameraFallback(videoError)
```

For the initiator, add audio tracks normally and create exactly one video transceiver:

```js
const videoTrack = stream.getVideoTracks()[0]
connection.addTransceiver(videoTrack || 'video', {
  direction: 'sendrecv',
  streams: [stream],
})
```

For the receiver, call `setRemoteDescription(offer)` before attaching tracks. Add the audio track, then call `addTrack(videoTrack, stream)` only when a video track exists; WebRTC will reuse the offered video transceiver. Create the answer afterward.

Update `ontrack` to build a fallback `MediaStream` when `event.streams[0]` is absent and set `remoteVideoOn` true when a live remote video track arrives.

- [ ] **Step 6: Reset all new state during cleanup and verify GREEN**

Reset `localVideoOn`, `remoteVideoOn`, and `cameraStarting`, then run:

```powershell
node --test src/stores/call.test.mjs src/stores/call-media.test.mjs
```

Expected: asymmetric setup tests and the existing duplicate-accept/listener-disposal tests all PASS.

---

### Task 3: Synchronize initial and dynamic camera state in the frontend

**Files:**
- Modify: `frontend/src/stores/call.js:219-335,435-568`
- Modify: `frontend/src/stores/call.test.mjs`
- Modify: `frontend/src/services/websocket-call-offer.test.mjs`

**Interfaces:**
- Produces outbound fields `video_enabled: boolean` on `call_offer` and `call_answer`.
- Produces/consumes `call_media_state` payload `{ to, call_id, video_enabled }`.
- `remoteVideoOn` changes only for the current call ID and peer.

- [ ] **Step 1: Write failing initial-state signaling tests**

Assert a camera-less initiator sends:

```js
assert.deepEqual(offer.payload.video_enabled, false)
```

Assert a camera-equipped receiver sends:

```js
assert.deepEqual(answer.payload.video_enabled, true)
```

Assert receiving offer/answer fields sets `remoteVideoOn` to the literal boolean, including `false`.

- [ ] **Step 2: Write failing dynamic-state session tests**

Register call listeners and deliver:

```js
env.emit('call_media_state', {
  from: 'peer-a',
  call_id: currentCallId,
  video_enabled: false,
})
assert.equal(env.store.remoteVideoOn, false)
```

Then deliver the same event with a different call ID and assert the current state is unchanged.

- [ ] **Step 3: Verify RED**

Run:

```powershell
node --test src/stores/call.test.mjs
```

Expected: FAIL because camera state is neither sent nor handled.

- [ ] **Step 4: Implement frontend camera-state signaling**

Add `video_enabled: localVideoOn.value` to video offer and answer payloads. Extend incoming handler signatures to accept initial state with strict boolean normalization:

```js
remoteVideoOn.value = typeof videoEnabled === 'boolean' ? videoEnabled : null
```

Add:

```js
function sendMediaState() {
  if (media.value !== 'video' || !isCurrentSession(currentCallId)) return false
  return send('call_media_state', {
    to: peerId.value,
    call_id: currentCallId,
    video_enabled: localVideoOn.value,
  })
}

function onCallMediaState(payload) {
  if (typeof payload?.video_enabled !== 'boolean' ||
      !isCurrentSession(payload.call_id, payload.from)) return
  remoteVideoOn.value = payload.video_enabled
}
```

Register/unregister `call_media_state` in `startListening()`.

- [ ] **Step 5: Preserve transient buffering semantics**

Add a WebSocket service regression test that emits `call_media_state` before listener registration and expects no replay. Do not add it to `BUFFERED_TYPES`.

- [ ] **Step 6: Verify GREEN**

Run:

```powershell
pnpm run test:call
```

Expected: all call store and WebSocket buffering tests PASS.

---

### Task 4: Support camera retry, camera disconnection, and explicit UI states

**Files:**
- Modify: `frontend/src/stores/call.js:114-123,351-397,397-435,560-568`
- Modify: `frontend/src/stores/call.test.mjs`
- Modify: `frontend/src/components/VideoCallView.vue:2-158,161-215`

**Interfaces:**
- Produces: `setCameraEnabled(enabled): Promise<void>` and `cameraStarting: Ref<boolean>`.
- Camera-off transitions keep audio and PC active and call `sendMediaState()`.

- [ ] **Step 1: Write the failing camera-disconnection test**

After an active video call, invoke the local video track's `onended` handler and assert:

```js
assert.equal(env.store.state, 'active')
assert.equal(env.store.localVideoOn, false)
assert.equal(env.store.localStream.getAudioTracks().length, 1)
assert.equal(env.sent.at(-1).type, 'call_media_state')
assert.equal(env.sent.at(-1).payload.video_enabled, false)
```

Also keep an existing/fresh test proving an ended audio track still hangs up.

- [ ] **Step 2: Write the failing camera-retry test**

Start a video call with camera acquisition failing, switch the media-device fake to return a video track, and call:

```js
await env.store.setCameraEnabled(true)
```

Assert the negotiated video sender now owns that track, the local stream contains it, `localVideoOn` is true, `cameraStarting` returns to false, and the last media-state signal is true.

- [ ] **Step 3: Verify RED**

Run:

```powershell
node --test src/stores/call.test.mjs
```

Expected: the call currently hangs up on video end and cannot acquire a missing camera during the call.

- [ ] **Step 4: Implement non-fatal video lifecycle**

Split track-end handling by kind. Audio retains the existing fatal path. For the current video track:

```js
track.onended = () => {
  if (!isCurrentSession(callId, targetPeerId)) return
  localStream.value?.removeTrack(track)
  localVideoOn.value = false
  sendMediaState()
  Notify.create({ type: 'warning', message: 'Camera disconnected; continuing with voice', timeout: 3000 })
}
```

Implement async `setCameraEnabled(true)` with a camera-attempt generation token, `cameraStarting` guard, camera-only `getUserMedia`, session checks, `replaceTrack`, local-stream insertion, end-handler binding, and state publication. When a live disabled track already exists, re-enable it without reacquiring. `setCameraEnabled(false)` disables the live track and publishes false.

- [ ] **Step 5: Update the video call UI**

Replace `cameraOn` bindings with `localVideoOn`, bind button loading/disable to `cameraStarting`, and await `setCameraEnabled()` in `toggleCamera()`.

Add computed `hasRemoteVideoTrack` and render placeholder text by priority:

```js
if (callStore.connectionStatus === 'reconnecting') return reconnectText
if (callStore.state === 'calling') return callingText
if (callStore.connectionStatus === 'connecting') return connectingText
if (callStore.remoteVideoOn === false) return 'The other party is currently using voice only'
return 'Waiting for the other party video...'
```

Show a camera-off overlay in the local preview when `localVideoOn` is false. Do not hide the camera retry button.

- [ ] **Step 6: Verify GREEN**

Run:

```powershell
pnpm run test:call
pnpm run lint
```

Expected: camera lifecycle tests PASS and the Vue component has no lint errors.

---

### Task 5: Validate and relay camera state in the backend

**Files:**
- Create: `backend/internal/ws/call_relay_test.go`
- Modify: `backend/internal/ws/hub.go:133-177,560-593,1362-1469`
- Modify: `backend/internal/ws/message_relay_test.go`

**Interfaces:**
- Accepts `video_enabled *bool` in call offers and relay payloads so literal false is preserved.
- Routes `call_media_state` through the existing friend-authorized call relay.
- Rejects `call_media_state` when `video_enabled` is missing or not a JSON boolean.

- [ ] **Step 1: Write failing payload-validation tests**

Extract production parsing behind:

```go
func parseCallRelayPayload(msgType string, payload json.RawMessage) (callRelayPayload, bool)
```

Write table tests with literal expected validity:

```go
tests := []struct {
    name string
    kind string
    body string
    ok   bool
}{
    {"media true", "call_media_state", `{"to":"2222-BBBB","call_id":"11111111-1111-4111-8111-111111111111","video_enabled":true}`, true},
    {"media false", "call_media_state", `{"to":"2222-BBBB","call_id":"11111111-1111-4111-8111-111111111111","video_enabled":false}`, true},
    {"media missing state", "call_media_state", `{"to":"2222-BBBB","call_id":"11111111-1111-4111-8111-111111111111"}`, false},
    {"media string state", "call_media_state", `{"to":"2222-BBBB","call_id":"11111111-1111-4111-8111-111111111111","video_enabled":"false"}`, false},
}
```

- [ ] **Step 2: Write failing forwarding-shape tests**

Extract the authorized inner payload construction behind:

```go
func buildCallRelayPayload(from string, msgType string, p callRelayPayload) map[string]any
```

Assert `call_answer` and `call_media_state` preserve both literal `true` and literal `false` in their serialized forwarded payload. Add an offer helper test or direct offer-building test proving `video_enabled:false` is not omitted.

- [ ] **Step 3: Write failing authorization tests**

Introduce a narrow test seam for the existing friend checks without changing `NewHub` callers:

```go
type friendChecker interface {
    GetFriendChatIDs(context.Context, uint64) ([]string, error)
    AreFriends(context.Context, uint64, string) (bool, error)
}
```

Change only `Hub.friendSvc` from `*service.FriendService` to `friendChecker`; keep `NewHub` accepting `*service.FriendService`. In `call_relay_test.go`, provide a fake implementing both methods and create sender/recipient clients with buffered send channels.

Add two direct `handleCallRelay` tests for `call_media_state`:

- `AreFriends == true`: the recipient receives exactly one forwarded message containing the sender chat ID, current call ID, and literal `video_enabled:false`.
- `AreFriends == false`: the recipient channel remains empty after the synchronous handler returns.

This test must exercise `handleCallRelay`, not just the extracted parser/builder, so the authorization boundary is covered.

- [ ] **Step 4: Verify RED**

Run:

```powershell
go test ./internal/ws
```

Expected: FAIL because the parser/builder and media-state support do not exist.

- [ ] **Step 5: Implement validated relay support**

Add `call_media_state` to the dispatch allowlist. Define:

```go
type callRelayPayload struct {
    To           string          `json:"to"`
    CallID       string          `json:"call_id"`
    SDP          json.RawMessage `json:"sdp,omitempty"`
    ICE          json.RawMessage `json:"ice,omitempty"`
    Reason       string          `json:"reason,omitempty"`
    VideoEnabled *bool           `json:"video_enabled,omitempty"`
}
```

`parseCallRelayPayload` keeps current SDP/ICE validation and requires non-nil `VideoEnabled` for `call_media_state`. `buildCallRelayPayload` includes `video_enabled` whenever the pointer is non-nil. `handleCallRelay` continues using its existing `AreFriends` check before forwarding. The `friendChecker` field substitution exists only to inject the authorization result in tests; production construction and behavior remain unchanged.

Extend `handleCallOffer` with `VideoEnabled *bool` and include the field in the forwarded offer whenever provided.

- [ ] **Step 6: Prove media state remains transient**

Add `call_media_state` to the negative cases in `TestOfflineStorableIncludesDeliveryAck`.

- [ ] **Step 7: Verify backend GREEN**

Run:

```powershell
go test ./internal/ws
```

Expected: all WebSocket backend tests PASS.

---

### Task 6: Full verification and review

**Files:**
- Verify all files changed in Tasks 1-5.

**Interfaces:**
- Produces a release-ready asymmetric video-call implementation with prior uncommitted fixes preserved.

- [ ] **Step 1: Run all frontend Node tests**

```powershell
$tests = @(rg --files -g '*.test.mjs')
node --test $tests
```

Expected: zero failures and no open handles.

- [ ] **Step 2: Run frontend lint and production build**

```powershell
pnpm run lint
pnpm run build
```

Expected: both commands exit 0 and the build reports `Build succeeded`.

- [ ] **Step 3: Run backend tests**

```powershell
go test ./...
```

Expected: all backend packages PASS.

- [ ] **Step 4: Audit diffs and protect prior work**

```powershell
git diff --check
git status --short
git diff -- frontend/src/stores/call.js frontend/src/components/VideoCallView.vue frontend/src/components/IncomingCallDialog.vue frontend/src/services/websocket.js frontend/package.json backend/internal/ws/hub.go backend/internal/ws/message_relay_test.go
```

Expected: no generated artifacts or whitespace errors; the earlier answering guard, listener-disposal hangup, early `call_offer` buffer, and user-owned `call.js` diagnostics remain present.

- [ ] **Step 5: Request read-only code review**

Ask the reviewer to inspect media acquisition cleanup, transceiver direction/sender reuse, late async camera attempts, state-message session binding, backend boolean validation, and tests. Fix every Critical or Important issue, then rerun Steps 1-4.

- [ ] **Step 6: Report verification evidence and remaining environment limits**

Report focused/asymmetric test counts, total frontend and backend test results, lint/build status, modified files, preserved uncommitted work, and whether real two-device camera testing was available.
