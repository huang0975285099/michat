import assert from 'node:assert/strict'
import test from 'node:test'

import { videoCallStatusText } from './video-call-status.mjs'

test('shows an explicit voice-only state when the remote camera is off', () => {
  assert.equal(videoCallStatusText({
    state: 'active',
    connectionStatus: 'connected',
    reconnectSeconds: 0,
    peerName: 'Peer A',
    remoteVideoOn: false,
    hasRemoteVideoTrack: false,
  }), 'The other party is currently using voice only')
})

test('connection recovery state takes priority over remote camera state', () => {
  assert.equal(videoCallStatusText({
    state: 'active',
    connectionStatus: 'reconnecting',
    reconnectSeconds: 7,
    peerName: 'Peer A',
    remoteVideoOn: false,
    hasRemoteVideoTrack: false,
  }), 'Network outage，Recovering（7seconds）')
})

test('returns no placeholder text when connected remote video is available', () => {
  assert.equal(videoCallStatusText({
    state: 'active',
    connectionStatus: 'connected',
    reconnectSeconds: 0,
    peerName: 'Peer A',
    remoteVideoOn: true,
    hasRemoteVideoTrack: true,
  }), '')
})
