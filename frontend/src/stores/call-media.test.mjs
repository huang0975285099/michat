import assert from 'node:assert/strict'
import test from 'node:test'

import { acquireCallMedia } from './call-media.mjs'

function fakeTrack(kind) {
  return {
    kind,
    readyState: 'live',
    stopped: false,
    stop() {
      this.stopped = true
      this.readyState = 'ended'
    },
  }
}

function fakeStream(kinds = [], tracks = kinds.map(fakeTrack)) {
  return {
    tracks,
    addTrack(track) {
      this.tracks.push(track)
    },
    getTracks() {
      return [...this.tracks]
    },
    getAudioTracks() {
      return this.tracks.filter((track) => track.kind === 'audio')
    },
    getVideoTracks() {
      return this.tracks.filter((track) => track.kind === 'video')
    },
  }
}

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
