import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

import { selectUpdateUrl, validateUpdateUrl } from './native-update.mjs'

const versionInfo = {
  url: 'https://m.yzs88.com:8088',
  windows: 'https://m.yzs88.com:8088/download/yunChat.exe',
  apk: 'https://m.yzs88.com:8088/download/yunChat.apk'
}

test('selects a platform-specific installer while preserving the legacy fallback', () => {
  assert.equal(selectUpdateUrl(versionInfo, 'windows'), versionInfo.windows)
  assert.equal(selectUpdateUrl(versionInfo, 'apk'), versionInfo.apk)
  assert.equal(selectUpdateUrl(versionInfo, 'web'), versionInfo.url + '/')
  assert.equal(selectUpdateUrl({ url: versionInfo.url }, 'windows'), versionInfo.url + '/')
})

test('accepts only approved HTTPS download addresses', () => {
  assert.equal(validateUpdateUrl(versionInfo.windows), versionInfo.windows)
  assert.throws(() => validateUpdateUrl('http://example.com/yunChat.exe'), /HTTPS/)
  assert.throws(() => validateUpdateUrl('javascript:alert(1)'), /HTTPS/)
  assert.throws(() => validateUpdateUrl(''), TypeError)
})

test('rejects unapproved origins, credentials, paths and redirect parameters', () => {
  const rejected = [
    'https://example.com/download/yunChat.exe',
    'https://m.yzs88.com/download/yunChat.exe',
    'https://m.yzs88.com:8089/download/yunChat.exe',
    'https://m.yzs88.com.evil.test:8088/download/yunChat.exe',
    'https://user:password@m.yzs88.com:8088/download/yunChat.exe',
    'https://m.yzs88.com:8088/api/version',
    'https://m.yzs88.com:8088/download/',
    'https://m.yzs88.com:8088/download/../admin',
    'https://m.yzs88.com:8088/download/%2e%2e/admin',
    'https://m.yzs88.com:8088/download/%2fadmin',
    'https://m.yzs88.com:8088/download/%252e%252e/admin',
    'https://m.yzs88.com:8088/download//yunChat.exe',
    'https://m.yzs88.com:8088/download/yunChat.exe?redirect=https://evil.test',
    'https://m.yzs88.com:8088/download/yunChat.exe#fragment',
    ' ' + versionInfo.windows,
    versionInfo.windows + '\\n',
    'https://m.yzs88.com:8088/download/\\\\yunChat.exe'
  ]
  for (const url of rejected) assert.throws(() => validateUpdateUrl(url), TypeError, url)
})

test('homepage is allowed only explicitly and without query or fragment', () => {
  assert.throws(() => validateUpdateUrl(versionInfo.url), /download path/)
  assert.equal(validateUpdateUrl(versionInfo.url, { allowHomepage: true }), versionInfo.url + '/')
  for (const suffix of ['/?redirect=evil', '/#download', '/admin']) {
    assert.throws(() => validateUpdateUrl(versionInfo.url + suffix, { allowHomepage: true }), TypeError)
  }
})

test('invalid platform installers fail closed rather than falling back to the homepage', () => {
  assert.throws(() => selectUpdateUrl({ ...versionInfo, windows: versionInfo.url }, 'windows'), TypeError)
  assert.throws(() => selectUpdateUrl({ ...versionInfo, apk: 'https://evil.test/app.apk' }, 'apk'), TypeError)
  assert.equal(selectUpdateUrl({}, 'windows'), '')
  assert.equal(selectUpdateUrl({ apk: versionInfo.apk }, 'web'), versionInfo.apk)
})

test('web CSP authorizes existing inline scripts by hash, never unsafe script allowances', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const configs = [read('../../nginx.conf'), read('../../../nginx-vhost/m.yzs88.com.conf')]
  const scripts = [read('../../index.html'), read('../../../backend/internal/handler/admin.html'),
    read('../../../backend/internal/handler/company_admin.html')]
  if (existsSync(new URL('../../dist/spa/index.html', import.meta.url))) {
    scripts.push(read('../../dist/spa/index.html'))
  }
  for (const config of configs) {
    const policies = [...config.matchAll(/add_header Content-Security-Policy "([^"]+)" always;/g)]
    assert.ok(policies.length > 0)
    for (const [, policy] of policies) {
      const scriptPolicy = policy.match(/script-src ([^;]+)/)[1]
      assert.ok(!scriptPolicy.includes("'unsafe-inline'"))
      assert.ok(!scriptPolicy.includes("'unsafe-eval'"))
      for (const html of scripts) {
        for (const [, script] of html.replace(/\r\n/g, '\n').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
          if (!script.trim()) continue
          const hash = createHash('sha256').update(script).digest('base64')
          assert.ok(scriptPolicy.includes(`'sha256-${hash}'`), `CSP needs updated script hash: ${hash}`)
        }
      }
    }
  }
})
