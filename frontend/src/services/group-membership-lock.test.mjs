import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../pages/GroupChatPage.vue', import.meta.url), 'utf8')
const preparation = source.slice(source.indexOf('async function addSelectedImages('), source.indexOf('async function onImagesSelected('))
const preview = source.slice(source.indexOf('async function loadGroupImagePreview('), source.indexOf('const autoPreviewAttempted'))
const cleanup = source.slice(source.indexOf('watch(() => identity.isLocked'), source.indexOf('async function loadGroupFile('))
const ref = value => ({ value })

function scopeForTest() {
  let cleanupCallback
  const revoked = []
  let created = 0
  const scope = {
    sensitiveGeneration: 0, identity: { isLocked: false }, pageUnmounted: false,
    selectedImages: ref([]), imageProcessing: ref({ active: false }), imageSending: ref({ active: false }), canInput: ref(true),
    imagePreview: ref({ show: true, startId: 'image' }), previewUrls: new Map(), messages: ref([]), fileBusy: ref({ image: true }),
    fileInput: ref({ value: 'file' }), imageInput: ref({ value: 'image' }), inputText: ref('secret'), replyTarget: ref({ preview: 'secret' }), morePanelOpen: ref(true), sending: ref(true),
    watch: (getter, callback) => { cleanupCallback = callback },
    URL: { revokeObjectURL: url => revoked.push(url), createObjectURL: () => { created += 1; return 'new-url' } },
    imageSelectionKey: file => file.name, normalizedImageFile: file => file,
    mergeImageSelection: (existing, files) => ({ files, rejected: [] }),
    chatStore: { validateFile: () => {} }, MAX_IMAGE_FILE_BYTES: 100,
    crypto, notifyImageRejections: () => {}, t: key => key,
    $q: { notify: () => {} }, nextTick: async () => {},
    openImagePreview: () => { scope.imagePreview.value.show = true },
  }
  scope.sensitiveTaskValid = generation => generation === scope.sensitiveGeneration && !scope.identity.isLocked && !scope.pageUnmounted
  scope.disposeSelectedImage = item => scope.URL.revokeObjectURL(item.previewUrl)
  new Function('scope', `with(scope) { ${cleanup} }`)(scope)
  return { scope, revoked, created: () => created, lock: () => { scope.identity.isLocked = true; cleanupCallback(true) } }
}

test('lock clears preview, files, URLs, busy and plaintext buffers synchronously', () => {
  const context = scopeForTest()
  const { scope } = context
  const message = { objectUrl: 'message-url' }
  scope.messages.value = [message]
  scope.selectedImages.value = [{ originalFile: {}, preparedFile: {}, previewUrl: 'selection-url' }]
  scope.previewUrls.set(message, 'message-url')
  context.lock()
  assert.deepEqual(scope.imagePreview.value, { show: false, startId: '' })
  assert.deepEqual(scope.selectedImages.value, [])
  assert.equal(message.objectUrl, null)
  assert.equal(scope.previewUrls.size, 0)
  assert.deepEqual(scope.fileBusy.value, {})
  assert.equal(scope.fileInput.value.value, '')
  assert.equal(scope.imageInput.value.value, '')
  assert.equal(scope.inputText.value, '')
  assert.equal(scope.replyTarget.value, null)
  assert.deepEqual(context.revoked, ['selection-url', 'message-url'])
})

test('pending compression cannot recreate selections or URLs even after unlock', async () => {
  const context = scopeForTest()
  let resolve
  context.scope.compressImageForSending = () => new Promise(done => { resolve = done })
  const prepare = new Function('scope', `with(scope) { ${preparation}; return addSelectedImages }`)(context.scope)
  const pending = prepare([{ name: 'secret.png', size: 1 }])
  context.lock()
  context.scope.identity.isLocked = false
  resolve({ file: { name: 'secret.png', size: 1 } })
  await pending
  assert.equal(context.created(), 0)
  assert.deepEqual(context.scope.selectedImages.value, [])
})

test('pending preview download cannot cache, reopen, recreate URLs or restore busy state after lock', async () => {
  const context = scopeForTest()
  context.scope.fileBusy.value = {}
  let resolve
  let cached = false
  context.scope.loadGroupFile = () => new Promise(done => { resolve = done })
  context.scope.chatStore.cacheGroupAttachment = async () => { cached = true }
  const load = new Function('scope', `with(scope) { ${preview}; return loadGroupImagePreview }`)(context.scope)
  const message = { id: 'image', objectUrl: null }
  const pending = load(message, true)
  context.lock()
  context.scope.identity.isLocked = false
  resolve(new Blob(['secret']))
  await pending
  assert.equal(cached, false)
  assert.equal(context.created(), 0)
  assert.equal(message.objectUrl, null)
  assert.equal(context.scope.imagePreview.value.show, false)
  assert.deepEqual(context.scope.fileBusy.value, {})
})
