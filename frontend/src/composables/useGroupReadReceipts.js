import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useIdentityStore } from 'src/stores/identity'
import { useChatStore } from 'src/stores/chat'
import { useGroupStore } from 'src/stores/group'
import { groupApi } from 'src/services/api'
import { loadKeyPair, getPinnedPeerPublicKey } from 'src/services/crypto'
import { signControlProof, verifyControlProof } from 'src/services/control-proof.mjs'
import { getServerNow } from 'src/services/websocket'

export function useGroupReadReceipts(groupId, active, visibleMessages) {
  const identity = useIdentityStore()
  const chat = useChatStore()
  const group = useGroupStore()
  const receipts = ref({})
  const selectedMessage = ref(null)
  const showDialog = ref(false)
  const acknowledged = new Set()
  const proofs = new Map()
  const foreground = ref(!document.hidden)
  let disposed = false
  let running = false
  let generation = 0
  let controller = null
  let timer = null
  const enabled = () => !disposed && active.value && foreground.value && !identity.isLocked && !identity.restoringLocalData
  const rows = msgId => receipts.value[msgId] || []
  const selectedRows = computed(() => rows(selectedMessage.value?.id))
  const readCount = msgId => rows(msgId).filter(receipt => receipt.verified).length

  async function synchronize() {
    if (running || !enabled()) return
    running = true
    const taskGeneration = generation
    const accountId = identity.chatId
    const current = () => enabled() && generation === taskGeneration && identity.chatId === accountId
    controller = new AbortController()
    const signal = controller.signal
    try {
      const pending = (chat.messages[groupId] || []).filter(message => !message.mine && message.read && !acknowledged.has(message.id))
      if (pending.length) {
        const keys = await loadKeyPair()
        if (!keys?.privateKey || !current()) return
        for (let offset = 0; offset < pending.length; offset += 100) {
          const batch = pending.slice(offset, offset + 100)
          const records = []
          for (const message of batch) {
            if (!current()) return
            if (!proofs.has(message.id)) {
              proofs.set(message.id, await signControlProof({ from: accountId, to: groupId, msgId: message.id, kind: 'group-read', at: getServerNow() }, keys.privateKey))
            }
            records.push({ msg_id: message.id, proof: proofs.get(message.id) })
          }
          if (!current()) return
          const { data } = await groupApi.recordGroupReads(groupId, records, signal)
          if (!current()) return
          const submitted = new Set(batch.map(message => message.id))
          for (const msgId of data.msg_ids || []) {
            if (!submitted.has(msgId)) continue
            acknowledged.add(msgId)
            proofs.delete(msgId)
          }
        }
      }
      const ownIds = [...new Set([...visibleMessages.value.filter(message => message.mine && message.status === 'sent').map(message => message.id), selectedMessage.value?.id].filter(Boolean))]
      for (let offset = 0; offset < ownIds.length; offset += 100) {
        if (!current()) return
        const batch = ownIds.slice(offset, offset + 100)
        const { data } = await groupApi.groupReads(groupId, batch, signal)
        const updates = Object.fromEntries(batch.map(msgId => [msgId, []]))
        for (const receipt of data.receipts || []) {
          if (!updates[receipt.msg_id]) continue
          let verified = false
          let readAt = null
          if (receipt.proof) {
            const keys = new Set([
              group.getMembers(groupId).find(member => member.chat_id === receipt.chat_id)?.public_key,
              await getPinnedPeerPublicKey(accountId, receipt.chat_id),
            ].filter(Boolean))
            for (const publicKey of keys) {
              try {
                readAt = await verifyControlProof({ from: receipt.chat_id, to: groupId, msgId: receipt.msg_id, kind: 'group-read', proof: receipt.proof }, publicKey)
                verified = true
                break
              } catch { continue }
            }
          }
          updates[receipt.msg_id].push({ ...receipt, verified, readAt })
        }
        if (!current()) return
        receipts.value = { ...receipts.value, ...updates }
      }
    } catch (error) {
      if (!signal.aborted && current()) console.warn('[group] read synchronization failed', error)
    } finally {
      running = false
      controller = null
    }
  }

  function invalidate() {
    generation += 1
    controller?.abort()
    if (identity.isLocked || !identity.chatId || !active.value) {
      showDialog.value = false
      selectedMessage.value = null
      receipts.value = {}
    }
  }

  function onVisibility() {
    foreground.value = !document.hidden
    invalidate()
    synchronize()
  }

  watch(() => [identity.chatId, identity.isLocked, identity.restoringLocalData, active.value], (value, previous) => {
    invalidate()
    if (previous && value[0] !== previous[0]) { acknowledged.clear(); proofs.clear(); receipts.value = {} }
    synchronize()
  })
  watch(() => (chat.messages[groupId] || []).filter(message => message.read).length, synchronize)
  watch(() => visibleMessages.value.map(message => `${message.id}:${message.status}`).join(','), synchronize)
  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibility)
    timer = setInterval(synchronize, 5000)
    synchronize()
  })
  onUnmounted(() => {
    disposed = true
    invalidate()
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisibility)
    proofs.clear()
  })

  function openReaders(message) {
    if (!message.mine || identity.isLocked) return
    selectedMessage.value = message
    showDialog.value = true
    synchronize()
  }

  return { rows, readCount, selectedRows, showDialog, openReaders }
}
