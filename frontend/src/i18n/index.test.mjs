import assert from 'node:assert/strict'
import test from 'node:test'

import { messages, setLocale, t } from './index.js'
import { ACTION } from '../games/ironfist/game/GameConstants.js'
import { getActionMeta } from '../games/ironfist/game/GameConstants.js'

function flattenKeys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return child && typeof child === 'object' ? flattenKeys(child, path) : path
  })
}

test('keeps the Chinese and English catalogs structurally identical', () => {
  assert.deepEqual(flattenKeys(messages['zh-CN']), flattenKeys(messages['en-US']))
})

test('switches application and game copy between Chinese and English', () => {
  setLocale('zh-CN')
  assert.equal(t('friends.add'), '添加好友')
  assert.equal(t('chat.messageTooLong', { count: 100 }), '消息过长，最多 100 个字符')
  assert.equal(getActionMeta(ACTION.ATTACK).name, '攻击')

  setLocale('en-US')
  assert.equal(t('friends.add'), 'Add friend')
  assert.equal(t('chat.messageTooLong', { count: 100 }), 'Message is too long. Maximum: 100 characters.')
  assert.equal(getActionMeta(ACTION.ATTACK).name, 'Attack')
})

test('ignores unsupported locales', () => {
  setLocale('zh-CN')
  setLocale('fr-FR')
  assert.equal(t('common.close'), '关闭')
  setLocale('en-US')
})
