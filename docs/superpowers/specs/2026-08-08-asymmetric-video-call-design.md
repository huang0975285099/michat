# Asymmetric Video Call Design

## Goal

Allow a requested video call to continue when either participant has no usable camera. Audio remains mandatory, while each participant independently sends video when a camera track is available and can begin sending video later without restarting the call.

## User Experience

- Selecting video call always means “request a call with video capability,” not “require both cameras.”
- Camera absence, denial, or temporary occupation automatically falls back to audio transmission without a confirmation dialog.
- The user receives a non-blocking notice that the camera is unavailable and the call is continuing with audio.
- A participant without a local camera can still receive and watch the other participant's video.
- When the remote participant is not sending video, the remote video area displays “The other party is currently using voice only” instead of an indefinite spinner.
- The local preview displays a camera-off state when no local video track is being sent.
- The camera button remains available. Pressing it retries camera acquisition and shows a loading state while acquisition is in progress.
- If a local camera disconnects during a call, the call continues with audio and both participants' camera-state UI updates.
- If the microphone cannot be acquired or disconnects during the call, the call ends as it does today.

## Media Acquisition

Audio and video acquisition will be separated for video calls:

1. Acquire audio with `getUserMedia({ audio: true, video: false })`.
2. If audio acquisition fails, abort or reject the call using a microphone-specific error.
3. Attempt video with `getUserMedia({ audio: false, video: VIDEO_CONSTRAINTS })`.
4. If video acquisition fails, keep the audio stream, set local video state to off, and continue call setup.
5. Combine available tracks into the store's local `MediaStream` for preview, cleanup, mute, and device lifecycle handling.

Voice calls retain their existing audio-only flow.

An audio track ending remains fatal. A video track ending removes that track from the local stream, sets local video state to off, sends the new media state, and leaves audio connected.

## WebRTC Negotiation

Every video call pre-negotiates one bidirectional video transceiver, even if the initiating participant has no camera track.

- The initiator adds the audio track and a `sendrecv` video transceiver before creating the offer.
- If a local video track exists, it is attached to the video transceiver's sender; otherwise the sender starts with a null track.
- The receiver applies the remote offer, adds the mandatory audio track, finds the offered video transceiver, and attaches its optional local video track before creating the answer.
- Replacing a null or stopped video sender track with a newly acquired camera track does not require a new Offer/Answer because the transceiver and codecs were negotiated at call establishment.
- Turning the camera off disables the current track and sends state immediately. A later retry may reuse a live disabled track or acquire and replace a missing/stopped track.
- Audio calls do not add a video transceiver.

## State Model

The call store will expose:

- `localVideoOn`: true only when a live local video track is enabled and intended for transmission.
- `remoteVideoOn`: `true`, `false`, or `null` when the remote state is not yet known.
- `cameraStarting`: true while a camera acquisition or replacement attempt is running.

The existing `cameraOn` state will be replaced by `localVideoOn` so UI state reflects an actual usable track rather than only the last button choice.

Session cleanup resets `localVideoOn` to false, `remoteVideoOn` to null, and `cameraStarting` to false. Late camera-acquisition results are session-checked and stopped rather than attached to a newer call.

## Signaling

Initial camera state is carried in both session descriptions:

- `call_offer`: adds `video_enabled`.
- `call_answer`: adds `video_enabled`.

Dynamic changes use a new transient message:

```json
{
  "type": "call_media_state",
  "payload": {
    "to": "peer-chat-id",
    "call_id": "uuid",
    "video_enabled": true
  }
}
```

The frontend accepts media-state messages only for the current call and peer. The backend validates the recipient, UUID call ID, boolean state, and friendship before relaying it. `call_media_state` is never stored for offline delivery and is not added to the frontend early-arrival buffer because it is meaningful only after a session exists.

Initial `video_enabled` fields make the first rendered state deterministic. Dynamic state is sent after answer processing and after every local camera transition.

## UI Behavior

The video call view uses the following priority:

1. Reconnecting: show the reconnect countdown.
2. Calling or connecting: show the existing connection status.
3. Connected and `remoteVideoOn === false`: show “The other party is currently using voice only.”
4. Connected and remote video is expected but the track has not arrived: show “Waiting for the other party's video...”
5. Remote video track available: show the video.

The local preview shows the video only when `localVideoOn` is true. Otherwise it shows a camera-off indicator. The camera button uses `cameraStarting` for loading/disable and toggles or retries the camera asynchronously.

## Error Handling

- Microphone errors retain fatal call behavior and use microphone-specific text.
- Camera errors are non-fatal and use a warning notification with the reason when available.
- A failed retry leaves the existing audio call and remote video untouched.
- A camera track that ends unexpectedly produces one warning, transitions local state to off, and notifies the peer without recursively hanging up.
- Signaling failure while publishing a media-state update does not end an otherwise healthy media connection; the next explicit camera transition sends the latest state again.

## Backend Changes

The WebSocket call-offer and call-relay payload structs will accept `video_enabled`. The relay allowlist will add `call_media_state`. Tests will verify:

- `video_enabled` is preserved on offers and answers.
- `call_media_state` is relayed only between friends with a valid call ID and boolean state.
- The new message remains transient and is excluded from offline storage.

No database or HTTP API changes are required.

## Testing

Frontend store tests will cover:

- Initiator without a camera and receiver with a camera.
- Initiator with a camera and receiver without a camera.
- Both participants without cameras.
- Camera permission denial with successful audio.
- Fatal microphone acquisition failure.
- Camera track disconnection while audio continues.
- Retrying camera acquisition and attaching the new track to the negotiated sender.
- Camera-state signaling and rejection of stale-session state.
- Existing duplicate-accept and listener-disposal regressions.

WebSocket service tests will preserve early-offer behavior while proving `call_media_state` is not early-buffered. Backend Go tests will cover payload validation, friend authorization, and forwarding. Final verification includes all frontend Node tests, ESLint, production frontend build, and the relevant backend Go test suite.

## Compatibility and Scope

- The frontend and backend changes should be deployed together for deterministic camera-state UI.
- SDP interoperability still permits one-way media if a media-state message is lost; the explicit UI state may remain unknown until the next state update.
- This work does not add screen sharing, camera selection, group calls, or text-only calling.
- TURN configuration and ICE-restart behavior remain unchanged.
