import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref, watch, nextTick } from 'vue'
import { signControlProof, verifyControlProof } from './control-proof.mjs'
import { invalidPendingContent } from './pending-storage.mjs'

const chatSource = await readFile(new URL('../stores/chat.js', import.meta.url), 'utf8')
const identitySource = await readFile(new URL('../stores/identity.js', import.meta.url), 'utf8')
const layoutSource = await readFile(new URL('../layouts/MainLayout.vue', import.meta.url), 'utf8')

function compile(source, startMarker, endMarker, dependencies, name) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start)
  return new Function(...Object.keys(dependencies), `${source.slice(start, end)}; return ${name}`)(...Object.values(dependencies))
}

function attachmentStatusHarness() {
  const transfers = ref({})
  const cleanup = []
  const persisted = []
  const dependencies = {
    fileTransfers: transfers,
    scheduleTransferCleanup: (...args) => cleanup.push(args),
    dbUpdateMessageAttachmentStatus: async (...args) => persisted.push(args),
  }
  const handlers = compile(chatSource, '  async function setMessageAttachmentStatus(', '\n  async function maybeAutoCleanReceivedAttachment(', dependencies,
    '({ setMessageAttachmentStatus, completeAcknowledgedOfflineTransfer })')
  return { ...handlers, transfers, cleanup, persisted }
}

test('received attachments clear matching stale send progress and never regress to waiting', async () => {
  const state = attachmentStatusHarness()
  const msg = { id: 'file-message-id', mine: true, offlineAttachment: { attachmentId: 'attachment-one' }, attachmentStatus: 'preparing' }
  state.transfers.value['attachment-one'] = { msgId: msg.id, direction: 'send', status: 'pending', progress: 0 }
  await state.setMessageAttachmentStatus(msg, 'received')
  assert.equal(state.transfers.value['attachment-one'].status, 'done')
  assert.equal(state.transfers.value['attachment-one'].progress, 100)
  assert.deepEqual(state.cleanup, [['attachment-one', 1000]])
  await state.setMessageAttachmentStatus(msg, 'waiting')
  assert.equal(msg.attachmentStatus, 'received')
  assert.deepEqual(state.persisted, [[msg.id, 'received', undefined]])
  state.completeAcknowledgedOfflineTransfer(msg)
  assert.equal(state.cleanup.length, 1)
})

test('server acknowledgment finishes upload progress without pretending the recipient has received it', async () => {
  const state = attachmentStatusHarness()
  const msg = { id: 'file-message-id', mine: true, type: 'file', offlineAttachment: { attachmentId: 'attachment-one' }, attachmentStatus: 'preparing' }
  state.transfers.value['attachment-one'] = { msgId: msg.id, direction: 'send', status: 'pending', progress: 0 }
  const dependencies = {
    validateMsgId: () => true,
    ackTimers: new Map(),
    findLocalMessage: () => msg,
    confirmPendingMessage() {},
    dbUpdateMessageDelivery: async () => {},
    completeAcknowledgedOfflineTransfer: state.completeAcknowledgedOfflineTransfer,
    setMessageAttachmentStatus: state.setMessageAttachmentStatus,
  }
  const onAck = compile(chatSource, '    async function onAck(payload)', '\n    async function onReadReceipt(', dependencies, 'onAck')
  await onAck({ msg_id: msg.id, status: 'accepted', ts: 123 })
  assert.equal(msg.status, 'sent')
  assert.equal(msg.attachmentStatus, 'waiting')
  assert.equal(state.transfers.value['attachment-one'].status, 'done')
})

test('attachment completion cannot clear a different message or a receive transfer', () => {
  const state = attachmentStatusHarness()
  const msg = { id: 'file-message-id', mine: true, offlineAttachment: { attachmentId: 'attachment-one' } }
  state.transfers.value['attachment-one'] = { msgId: 'another-message-id', direction: 'send', status: 'pending' }
  state.completeAcknowledgedOfflineTransfer(msg)
  assert.equal(state.transfers.value['attachment-one'].status, 'pending')
  state.transfers.value['attachment-one'] = { msgId: msg.id, direction: 'receive', status: 'transferring' }
  state.completeAcknowledgedOfflineTransfer(msg)
  assert.equal(state.transfers.value['attachment-one'].status, 'transferring')
  assert.deepEqual(state.cleanup, [])
})

test('upload completion is reactive and late upload work cannot overwrite a received receipt', async () => {
  const state = attachmentStatusHarness()
  const metadata = { attachmentId: 'attachment-one' }
  const msg = { id: 'file-message-id', mine: true, status: 'pending', offlineAttachment: metadata }
  const statuses = []
  const deliveries = []
  let stopWatching
  let timers = 0
  const dependencies = {
    localKeyGeneration: 0,
    useIdentityStore: () => ({ isLocked: false, cacheFriendPubKey: async () => 'public-key' }),
    offlineUploadOperations: new Map(),
    fileTransfers: state.transfers,
    createOfflineTransfer: () => ({ msgId: msg.id, direction: 'send', status: 'pending', progress: 0 }),
    waitForOfflineUploadResume: async () => {},
    assertTransferActive() {},
    setMessageAttachmentStatus: state.setMessageAttachmentStatus,
    dbUpdateMessageDelivery: async (...args) => deliveries.push(args),
    uploadOfflineAttachment: async () => {
      stopWatching = watch(() => state.transfers.value['attachment-one'].status, status => statuses.push(status), { flush: 'sync' })
    },
    attachmentApi: {},
    sealOutgoingContent: async () => 'signed',
    serializeOfflineAttachmentContent: () => 'metadata',
    encryptMessage: async () => ({}),
    send: () => { msg.status = 'sent'; msg.attachmentStatus = 'received'; return true },
    hasPendingMessage: () => false,
    armMessageAckTimer: () => { timers++ },
    scheduleTransferCleanup: (...args) => state.cleanup.push(args),
    watchOutgoingAttachment() {},
  }
  const upload = compile(chatSource, '  async function runOfflineUpload(', '\n  /**', dependencies, 'runOfflineUpload')
  try {
    await upload('1234-ABCD', 'public-key', {}, msg, metadata)
    assert.deepEqual(statuses, ['processing', 'done'])
    assert.equal(msg.status, 'sent')
    assert.equal(msg.attachmentStatus, 'received')
    assert.equal(deliveries.at(-1)[1], 'sent')
    assert.equal(timers, 0)
  } finally {
    stopWatching?.()
  }
})

test('message persistence ignores same-sender replays without overwriting read state and rejects cross-thread ID collisions', async () => {
  const record = { id: 'a-b-c', chatId: 'group-one', from: '1234-ABCD', mine: false, read: true, text: 'original ciphertext' }
  const records = new Map([[record.id, record]])
  const dependencies = {
    STORE_NAME: 'messages',
    openMessagesDB: async () => ({
      transaction() {
        const transaction = { pending: 0, aborted: false }
        transaction.abort = () => {
          transaction.aborted = true
          queueMicrotask(() => transaction.onabort?.({ target: transaction }))
        }
        const operation = execute => {
          const request = {}
          transaction.pending++
          queueMicrotask(() => {
            if (transaction.aborted) return
            request.result = execute()
            request.onsuccess?.()
            transaction.pending--
            queueMicrotask(() => {
              if (!transaction.pending && !transaction.aborted) transaction.oncomplete?.()
            })
          })
          return request
        }
        transaction.objectStore = () => ({
          get: id => operation(() => records.get(id)),
          add: message => operation(() => {
            assert.equal(records.has(message.id), false)
            records.set(message.id, structuredClone(message))
          }),
        })
        return transaction
      },
    }),
  }
  const persist = compile(chatSource, 'async function dbAddMessage(', '\nasync function dbHasMessage(', dependencies, 'dbAddMessage')
  await persist({ ...record, read: false, text: 'replayed ciphertext' })
  assert.equal(records.get(record.id), record)
  assert.equal(records.get(record.id).read, true)
  await assert.rejects(persist({ ...record, chatId: 'group-two' }), /different sender or conversation/)
  await assert.rejects(persist({ ...record, from: '5678-EFGH' }), /different sender or conversation/)
  await persist({ ...record, id: 'd-e-f' })
  assert.equal(records.size, 2)
})

test('real calibrated clock produces integer timestamps accepted by every control signer', async () => {
  const source = await readFile(new URL('./websocket.js', import.meta.url), 'utf8')
  const start = source.indexOf('export function getServerNow()')
  const end = source.indexOf('\nfunction mergeReadProof', start)
  const getNow = new Function('performance', 'serverClock', `${source.slice(start, end).replaceAll('export function', 'function')}; return getServerNow`)(
    { now: () => 100.25 }, { epochMs: 1700000000000, monotonicMs: 100 },
  )
  assert.equal(getNow(), 1700000000000)
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicKey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))))
  for (const kind of ['read', 'recall', 'group-recall']) {
    const context = { from: '1234-ABCD', to: '5678-EFGH', msgId: 'a-b-c', kind, at: getNow() }
    const proof = await signControlProof(context, keys.privateKey)
    assert.equal(await verifyControlProof({ ...context, proof }, publicKey), context.at)
  }
})

function messageHarness({ failure = false } = {}) {
  const messages = { value: {} }
  const records = new Map()
  let fail = failure
  const dependencies = {
    messages,
    useIdentityStore: () => ({ isLocked: false }),
    isMsgIdExists: id => Object.values(messages.value).some(thread => thread.some(message => message.id === id)),
    applyEarlyReadReceipt: () => null,
    ensureThread: id => { messages.value[id] ||= [] },
    ensureMessageKey: async () => {},
    encryptMessageText: async () => 'encrypted',
    serializeChatMessageContent: text => text,
    messageEncryptKey: {},
    dbAddMessage: async record => { if (fail) throw new Error('QuotaExceededError'); records.set(record.id, record) },
    dbDeleteFile: async () => {},
    releaseFileObjectUrl() {},
    rememberEarlyReadReceipt() {},
    confirmReadReceiptsApplied() {},
    maybeAutoCleanReceivedAttachment: async () => {},
    console: { error() {}, warn() {} },
  }
  return {
    messages, records,
    setFailure: value => { fail = value },
    add: compile(chatSource, '  async function addMessage(', '\n  /**', dependencies, 'addMessage'),
    addFile: compile(chatSource, '  async function addFileMessage(', '\n  /**', dependencies, 'addFileMessage'),
  }
}

test('fresh text and file messages carry the same chat identity as their database records', async () => {
  const state = messageHarness()
  const message = { id: 'a-b-c', from: 'me', mine: true, text: 'hello' }
  await state.add('1234-ABCD', message)
  await state.addFile('group-one', { id: 'd-e-f', from: 'me', mine: true, filename: 'image.png' })
  assert.equal(message.chatId, '1234-ABCD')
  assert.equal(state.messages.value['group-one'][0].chatId, 'group-one')
  assert.equal(state.records.get('a-b-c').chatId, message.chatId)
})

test('local deletion permits received messages but remote recall still requires the sender and matching chat', async () => {
  const state = messageHarness()
  const sends = []
  const dependencies = {
    ...state,
    findLocalMessage: id => Object.values(state.messages.value).flat().find(message => message.id === id),
    dbGetMessage: async id => state.records.get(id),
    outgoingControl: async () => 'signed-proof',
    confirmPendingMessage() {},
    ackTimers: new Map(),
    stopOfflineUploadOperation() {},
    attachmentApi: { cancel: async () => {} },
    dbDeleteMessage: async id => state.records.delete(id),
    deleteFileArtifacts: async () => {},
    send: (...args) => sends.push(args),
  }
  const recall = compile(chatSource, '  async function recallMessage(', '\n  // ── Security verification constants', dependencies, 'recallMessage')
  await state.add('1234-ABCD', { id: 'a-b-c', from: '1234-ABCD', mine: false, text: 'received' })
  await assert.rejects(recall('1234-ABCD', 'a-b-c', '1234-ABCD'), /another sender/)
  await assert.rejects(recall('5678-EFGH', 'a-b-c', null), /this chat/)
  await recall('1234-ABCD', 'a-b-c', null)
  assert.deepEqual(sends, [])
  await state.add('1234-ABCD', { id: 'd-e-f', from: 'me', mine: true, text: 'sent' })
  await recall('1234-ABCD', 'd-e-f', '1234-ABCD')
  assert.deepEqual(sends, [['recall', { to: '1234-ABCD', msg_id: 'd-e-f', proof: 'signed-proof' }]])
})

test('failed incoming file persistence rolls back memory so a later retry can succeed', async () => {
  const state = messageHarness({ failure: true })
  const message = { id: 'a-b-c', from: '1234-ABCD', mine: false, filename: 'image.png' }
  assert.equal(await state.addFile('group-one', message, true), false)
  assert.deepEqual(state.messages.value['group-one'], [])
  state.setFailure(false)
  assert.equal(await state.addFile('group-one', message, true), true)
  assert.ok(state.records.has(message.id))
})

test('freshly received group text can be recalled without refreshing history', async () => {
  const state = messageHarness()
  const message = { id: 'a-b-c', from: '1234-ABCD', mine: false, groupId: 'group-one', text: 'hello' }
  await state.add('group-one', message)
  const acknowledgments = []
  const dependencies = {
    ...state,
    deferControl: () => false,
    incomingControl: async () => 123,
    findLocalMessage: id => Object.values(state.messages.value).flat().find(item => item.id === id),
    dbGetMessage: async id => state.records.get(id),
    dbGetPending: async () => null,
    dbDeleteMessage: async id => state.records.delete(id),
    dbDeletePending: async () => {},
    send: (...args) => acknowledgments.push(args),
    console,
  }
  const recall = compile(chatSource, '    async function onGroupRecall(', '\n    async function onGroupDelete', dependencies, 'onGroupRecall')
  await recall({ from: message.from, group_id: message.groupId, msg_id: message.id, proof: 'verified' })
  assert.deepEqual(state.messages.value['group-one'], [])
  assert.equal(state.records.has(message.id), false)
  assert.equal(acknowledgments[0][0], 'group_recall_received_ack')
})

function pendingHarness(getPending = null, overrides = {}) {
  const pending = new Map([['a-b-c', { msg_id: 'a-b-c', group: true, group_id: 'group-one', from: '1234-ABCD', key_envelope: {} }]])
  let persist = false
  const acknowledgments = []
  const dependencies = {
    localKeyGeneration: 0,
    invalidPendingContent,
    assertTransferActive() {},
    retryPendingControls: async () => {},
    dbGetAllPending: getPending || (async () => [...pending.values()]),
    dbHasMessage: async () => false,
    loadKeyPair: async () => ({ privateKey: {} }),
    decryptGroupMessageContent: async () => 'metadata',
    openIncomingContent: async value => value,
    parseOfflineAttachmentContent: () => ({ filename: 'image.png', fileSize: 12, filetype: 'image/png', attachmentId: 'attachment' }),
    addFileMessage: async (chatId, message, rollback) => {
      assert.equal(rollback, true)
      assert.equal(message.localFileAvailable, false)
      return persist
    },
    dbDeletePending: async id => pending.delete(id),
    send: (...args) => acknowledgments.push(args),
    getServerNow: () => 123,
    useIdentityStore: () => ({ isLocked: false }),
    console: { error() {}, warn() {} },
    ...overrides,
  }
  const start = chatSource.indexOf('  let pendingProcessingPromise = null')
  const end = chatSource.indexOf('\n  return {', start)
  const body = chatSource.slice(start, end).replace("const { loadKeyPair } = await import('src/services/crypto')", '')
  const process = new Function(...Object.keys(dependencies), `${body}; return processPendingMessages`)(...Object.values(dependencies))
  return { process, pending, acknowledgments, allowPersistence: () => { persist = true } }
}

test('pending group attachment ciphertext and ACK remain untouched on failed save, then retry succeeds', async () => {
  const state = pendingHarness()
  await state.process()
  assert.equal(state.pending.size, 1)
  assert.deepEqual(state.acknowledgments, [])
  state.allowPersistence()
  await state.process()
  assert.equal(state.pending.size, 0)
  assert.equal(state.acknowledgments[0][0], 'group_message_received_ack')
})

test('overlapping pending retries are serialized and a request during processing schedules another pass', async () => {
  let release
  let reads = 0
  const state = pendingHarness(async () => {
    reads++
    if (reads === 1) await new Promise(resolve => { release = resolve })
    return []
  })
  const first = state.process()
  await nextTick()
  const second = state.process()
  assert.equal(first, second)
  assert.equal(reads, 1)
  release()
  await first
  assert.equal(reads, 2)
})

test('invalid pending signatures and corrupt ciphertext are deleted after unlocking', async () => {
  for (const error of [new Error('Message sender signature is invalid'), new DOMException('Bad ciphertext', 'OperationError')]) {
    const state = pendingHarness(null, { openIncomingContent: async () => { throw error } })
    await state.process()
    assert.equal(state.pending.size, 0)
    assert.deepEqual(state.acknowledgments, [])
  }
})

test('pending direct messages use an available private key and discard corrupt transport ciphertext', async () => {
  const state = pendingHarness(null, {
    decryptMessageWithPrivateKey: async (payload, privateKey) => {
      assert.ok(privateKey)
      assert.equal(payload.ciphertext, 'invalid')
      throw new DOMException('Bad ciphertext', 'OperationError')
    },
  })
  state.pending.set('a-b-c', { msg_id: 'a-b-c', from: '1234-ABCD', ciphertext: 'invalid' })
  await state.process()
  assert.equal(state.pending.size, 0)
})

test('pending recovery preserves unavailable roster, keys, network failures and storage failures', async () => {
  for (const message of ['Group roster unavailable', 'Sender identity is unavailable', 'Private key is locked', 'Network Error', 'QuotaExceededError']) {
    const state = pendingHarness(null, { openIncomingContent: async () => { throw new Error(message) } })
    await state.process()
    assert.equal(state.pending.size, 1)
  }
  const noKeys = pendingHarness(null, { loadKeyPair: async () => null })
  await noKeys.process()
  assert.equal(noKeys.pending.size, 1)
  const brokenVault = pendingHarness(null, { loadKeyPair: async () => { throw new DOMException('Local vault unavailable', 'OperationError') } })
  await brokenVault.process()
  assert.equal(brokenVault.pending.size, 1)
  const locked = pendingHarness(null, {
    useIdentityStore: () => ({ isLocked: true }),
    openIncomingContent: async () => { throw new DOMException('Bad ciphertext', 'OperationError') },
  })
  await locked.process()
  assert.equal(locked.pending.size, 1)
})

test('unlock recovery waits for cleanup and restored history while the lock overlay remains visible', async () => {
  const isLocked = ref(true)
  const restoringLocalData = ref(false)
  const serverReady = ref(false)
  let finishCleanup
  const cleanup = new Promise(resolve => { finishCleanup = resolve })
  const events = []
  const state = { waitForSecurityCleanup: () => cleanup, protectLocalData: async () => events.push('protect'), loadAllMessages: async () => events.push('history') }
  const stop = watch(() => isLocked.value || restoringLocalData.value, (locked, wasLocked) => {
    if (wasLocked && !locked) events.push('recover')
  })
  const dependencies = { unlock: async () => true, isLocked, restoringLocalData, serverReady, useChatStore: () => state, lock() {}, onLocked() {}, sessionStorage: { setItem() {} }, connect: async () => {}, loadFriendPubKeys: async () => {}, autoLockCleanup: null, startAutoLock: () => () => {}, console }
  const unlock = compile(identitySource, '  async function unlockWithCode(', '\n  /**', dependencies, 'unlockWithCode')
  const task = unlock('passphrase')
  await nextTick()
  await nextTick()
  assert.equal(isLocked.value || restoringLocalData.value, true)
  assert.deepEqual(events, [])
  finishCleanup()
  await task
  await nextTick()
  assert.deepEqual(events, ['protect', 'history', 'recover'])
  assert.ok(layoutSource.includes('() => identity.isLocked || identity.restoringLocalData'))
  stop()
})

test('restoring a trusted group roster schedules pending decryption without reopening or unlocking', async () => {
  const membershipStatus = ref({})
  let retries = 0
  const dependencies = {
    watch,
    groupStore: { get membershipStatus() { return membershipStatus.value }, isMembershipTrusted: id => membershipStatus.value[id]?.status === 'trusted' },
    identity: { isLocked: false, restoringLocalData: false },
    chatStore: { processPendingMessages: async () => { retries++ } },
    console,
  }
  const start = layoutSource.indexOf('watch(\n    () => Object.keys(groupStore.membershipStatus)')
  const end = layoutSource.indexOf('\nonUnmounted', start)
  assert.ok(start >= 0 && end > start)
  const stop = new Function(...Object.keys(dependencies), `return ${layoutSource.slice(start, end)}`)(...Object.values(dependencies))
  membershipStatus.value = { group: { status: 'unapproved' } }
  await nextTick()
  assert.equal(retries, 0)
  membershipStatus.value.group.status = 'trusted'
  await nextTick()
  assert.equal(retries, 1)
  stop()
})
