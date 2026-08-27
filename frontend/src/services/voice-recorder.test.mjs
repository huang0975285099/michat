import assert from 'node:assert/strict'
import test from 'node:test'

import { chooseVoiceFormat, createVoiceFilename, formatVoiceDuration } from './voice-recorder.mjs'

test('selects the first voice format supported by the browser', () => {
  class FakeMediaRecorder {
    static isTypeSupported(type) { return type === 'audio/ogg;codecs=opus' }
  }
  assert.deepEqual(chooseVoiceFormat(FakeMediaRecorder), {
    mimeType: 'audio/ogg;codecs=opus',
    extension: 'ogg',
  })
})

test('formats voice duration and creates a safe filename', () => {
  assert.equal(formatVoiceDuration(1201), '0:02')
  assert.equal(formatVoiceDuration(61000), '1:01')
  assert.equal(createVoiceFilename('mp4', 123), 'voice-123.mp4')
  assert.equal(createVoiceFilename('exe', 123), 'voice-123.webm')
})
