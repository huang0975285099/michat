import assert from 'node:assert/strict'
import test from 'node:test'

import { createChatWatermark, formatWatermarkTime } from './chat-watermark.mjs'

test('watermark contains the full viewer Chat ID and a fixed UTC minute', () => {
  const timestamp = Date.UTC(2026, 7, 30, 8, 5, 59, 999)
  assert.equal(
    createChatWatermark('1234-ABCD', timestamp),
    'Yunmi · 1234-ABCD · 2026-08-30 08:05 UTC',
  )
})

test('watermark does not use a device-time fallback before server calibration', () => {
  assert.equal(formatWatermarkTime(null), '-- UTC')
})
