import test from 'node:test'
import assert from 'node:assert/strict'
import { robotMediaUrl, resolveRobotContentMedia } from './robot-media.js'

const image = '/api/robot/media/0123456789abcdef0123456789abcdef.png'
const video = '/api/robot/media/abcdef0123456789abcdef0123456789.mp4'
const productionApi = 'https://m.yzs88.com:8088/api'

test('article media resolves against the API server in the native app', () => {
  assert.equal(robotMediaUrl(image, productionApi), `https://m.yzs88.com:8088${image}`)
  assert.equal(resolveRobotContentMedia(`<p><img src="${image}"></p><video src="${video}" controls></video>`, productionApi),
    `<p><img src="https://m.yzs88.com:8088${image}"></p><video src="https://m.yzs88.com:8088${video}" controls></video>`)
})

test('development paths and unrelated URLs stay unchanged', () => {
  assert.equal(robotMediaUrl(image, '/api'), image)
  assert.equal(robotMediaUrl('https://example.com/x.png', productionApi), 'https://example.com/x.png')
  assert.equal(resolveRobotContentMedia(`<img src="${image}">`, '/api'), `<img src="${image}">`)
})
