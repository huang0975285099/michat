import { defineStore } from 'pinia'
import { ref } from 'vue'
import { groupApi } from '../services/api.js'
import { on, off } from '../services/websocket.js'
import { loadKeyPair, hasSecurityCode, isUnlocked } from '../services/crypto.js'
import { canonicalPublicKey, rosterContent, approvalContent, fingerprint, signApproval, verifyApproval, approvalStorageKey, createMembershipGate } from '../services/group-membership.mjs'

export const useGroupStore = defineStore('group', () => {
  const groups = ref([]) // [{group_id, name, member_count, last_message_at}]
  const membersByGroup = ref({}) // { [groupId]: [{chat_id, nickname, public_key, muted_until, state}] }
  const groupDetails = ref({}) // { [groupId]: { group_id, name, created_at, members } }
  const dissolvedGroups = ref(new Set()) // group_ids that received 'dissolved' event
  const removedFromGroups = ref(new Set()) // group_ids where self was removed

  let myChatId = ''
  const membershipStatus = ref({})
  const gates = new Map()
  const rosterLoads = new Map()
  let accountGeneration = 0

  function gateFor(groupId) {
    if (!gates.has(groupId)) gates.set(groupId, createMembershipGate())
    return gates.get(groupId)
  }

  function invalidateMembership(groupId) {
    const token = gateFor(groupId).invalidate()
    const previous = membershipStatus.value[groupId]
    membershipStatus.value[groupId] = previous?.snapshot ? { ...previous, status: 'unapproved' } : { status: 'unapproved', snapshot: null }
    return token
  }

  function isMembershipTrusted(groupId) {
    const status = membershipStatus.value[groupId]
    try {
      return Boolean(myChatId && status?.accountId === myChatId && status?.status === 'trusted' && gateFor(groupId).trusted && gateFor(groupId).content === status.snapshot && !isDissolved(groupId) && !isRemoved(groupId) && status.snapshot === rosterContent(groupId, getMembers(groupId)))
    } catch { return false }
  }

  function isRosterAvailable(groupId) {
    const status = membershipStatus.value[groupId]
    try {
      return Boolean(myChatId && status?.accountId === myChatId && status?.snapshot && !isDissolved(groupId) && !isRemoved(groupId) && status.snapshot === rosterContent(groupId, getMembers(groupId)))
    } catch { return false }
  }

  async function assertRosterAvailable(groupId) {
    const accountId = myChatId
    const generation = accountGeneration
    if (!isRosterAvailable(groupId) && myChatId && !isDissolved(groupId) && !isRemoved(groupId)) {
      if (!rosterLoads.has(groupId)) {
        const task = loadGroupDetail(groupId).finally(() => {
          if (rosterLoads.get(groupId) === task) rosterLoads.delete(groupId)
        })
        rosterLoads.set(groupId, task)
      }
      await rosterLoads.get(groupId)
    }
    if (accountId !== myChatId || generation !== accountGeneration) throw new Error('Group account changed during authentication')
    if (!isRosterAvailable(groupId)) throw new Error('Group roster unavailable')
    const status = membershipStatus.value[groupId]
    const keys = await loadKeyPair()
    const ownKey = await canonicalPublicKey(keys.pubKeyB64)
    if (ownKey !== status.ownKey) throw new Error('Own identity key changed')
    if (accountId !== myChatId || generation !== accountGeneration || !isRosterAvailable(groupId) || membershipStatus.value[groupId].snapshot !== status.snapshot) throw new Error('Group roster changed during authentication')
  }

  function getCurrentMemberPubKeys(groupId) {
    if (!isRosterAvailable(groupId)) throw new Error('Group roster unavailable')
    return getMembers(groupId).filter(member => member.state === 'active').map(member => ({ chat_id: member.chat_id, public_key: member.public_key }))
  }

  async function assertMembershipTrusted(groupId) {
    return assertRosterAvailable(groupId)
  }

  function getTrustedMemberPubKeys(groupId) {
    return getCurrentMemberPubKeys(groupId)
  }

  async function approveMembership(groupId, displayedSnapshot, reviewStillCurrent = () => true) {
    const accountId = myChatId
    const generation = accountGeneration
    if (!displayedSnapshot || !reviewStillCurrent() || (await hasSecurityCode() && !isUnlocked())) throw new Error('Unlock before approving')
    await loadGroupDetail(groupId)
    const gate = gateFor(groupId)
    const token = gate.revision
    const status = membershipStatus.value[groupId]
    if (!status?.snapshot || status.pinError || status.snapshot !== displayedSnapshot || accountId !== myChatId || generation !== accountGeneration) throw new Error('Roster changed or identity pin conflict; review again')
    const keys = await loadKeyPair()
    const ownKey = await canonicalPublicKey(keys.pubKeyB64)
    const content = approvalContent(accountId, ownKey, displayedSnapshot)
    const record = await signApproval(content, keys.privateKey)
    if (!reviewStillCurrent() || accountId !== myChatId || generation !== accountGeneration || !gate.matches(token, displayedSnapshot) || rosterContent(groupId, getMembers(groupId)) !== displayedSnapshot || (await hasSecurityCode() && !isUnlocked())) throw new Error('Approval interrupted')
    const latestKeys = await loadKeyPair()
    if (latestKeys.pubKeyB64 !== keys.pubKeyB64 || accountId !== myChatId || generation !== accountGeneration || !gate.matches(token, displayedSnapshot) || (await hasSecurityCode() && !isUnlocked())) throw new Error('Approval interrupted')
    if (!reviewStillCurrent() || !gate.matches(token, displayedSnapshot) || rosterContent(groupId, getMembers(groupId)) !== displayedSnapshot) throw new Error('Approval interrupted')
    localStorage.setItem(approvalStorageKey(accountId, groupId), JSON.stringify(record))
    gate.trust(token, displayedSnapshot)
    membershipStatus.value[groupId] = { ...status, status: 'trusted' }
  }

  function setMyChatId(chatId) {
    if (chatId !== myChatId) clear()
    myChatId = chatId
  }

  async function loadGroups() {
    try {
      const res = await groupApi.list()
      groups.value = res.data || []
      // filter out dissolved/removed groups
      groups.value = groups.value.filter(g => !dissolvedGroups.value.has(g.group_id) && !removedFromGroups.value.has(g.group_id))
    } catch (e) {
      console.warn('[group] loadGroups failed', e)
    }
  }

  async function loadGroupDetail(groupId) {
    const gate = gateFor(groupId)
    const token = invalidateMembership(groupId)
    const generation = accountGeneration
    const accountId = myChatId
    try {
      const res = await groupApi.detail(groupId)
      const detail = res.data || null
      if (detail && detail.group_id === groupId && !isDissolved(groupId) && !isRemoved(groupId)) {
        const previousMembers = membersByGroup.value[groupId] || []
        const previousKeys = new Map(previousMembers.map(member => [member.chat_id, member.public_key]))
        const keys = await loadKeyPair()
        const ownKey = await canonicalPublicKey(keys.pubKeyB64)
        for (const member of detail.members || []) {
          if (member.public_key) member.public_key = await canonicalPublicKey(member.public_key)
        }
        const changedMemberIds = (detail.members || [])
          .filter(member => member.state === 'active' && previousKeys.has(member.chat_id) && previousKeys.get(member.chat_id) !== member.public_key)
          .map(member => member.chat_id)
        const snapshot = rosterContent(groupId, detail.members)
        let content = null
        try { content = approvalContent(accountId, ownKey, snapshot) } catch { content = null }
        const number = await fingerprint(snapshot)
        const fingerprints = Object.fromEntries(await Promise.all(detail.members.filter(member => member.state === 'active').map(async member => [member.chat_id, await fingerprint(JSON.stringify(['yunmi.group-member.v1', member.chat_id, member.public_key]))])))
        let approved = false
        try { approved = await verifyApproval(JSON.parse(localStorage.getItem(approvalStorageKey(accountId, groupId))), content, ownKey) } catch { approved = false }
        const pinError = !content
        approved = approved && !pinError
        if (generation !== accountGeneration || accountId !== myChatId || !gate.publish(token, snapshot, approved)) return null
        groupDetails.value[groupId] = detail
        membersByGroup.value[groupId] = detail.members || []
        membershipStatus.value[groupId] = { status: approved ? 'trusted' : 'unapproved', snapshot, number, fingerprints, changedMemberIds, accountId, ownKey, pinError }
      } else {
        throw new Error('Group roster unavailable')
      }
      return detail
    } catch (e) {
      console.warn('[group] loadGroupDetail failed', e)
      return null
    }
  }

  function getMemberPubKeys(groupId) {
    if (!isRosterAvailable(groupId)) throw new Error('Group roster unavailable')
    const members = membersByGroup.value[groupId] || []
    return members
      .filter(m => m.state === 'active' && m.chat_id !== myChatId)
      .map(m => ({ chat_id: m.chat_id, public_key: m.public_key }))
  }

  function getGroupName(groupId) {
    const g = groups.value.find(g => g.group_id === groupId)
    return g?.name || groupId
  }

  function getMembers(groupId) {
    return membersByGroup.value[groupId] || []
  }

  function getGroupDetail(groupId) {
    return groupDetails.value[groupId] || null
  }

  function amIMuted(groupId) {
    const members = membersByGroup.value[groupId] || []
    const me = members.find(m => m.chat_id === myChatId)
    if (!me || !me.muted_until) return false
    return true
  }

  function isDissolved(groupId) {
    return dissolvedGroups.value.has(groupId)
  }

  function isRemoved(groupId) {
    return removedFromGroups.value.has(groupId)
  }

  function isGroupVisible(groupId) {
    return groups.value.some(g => g.group_id === groupId)
  }

  function handleGroupEvent(payload) {
    if (!payload || !payload.group_id) return
    const { group_id, event, member } = payload
    invalidateMembership(group_id)

    if (event === 'dissolved') {
      dissolvedGroups.value.add(group_id)
      groups.value = groups.value.filter(g => g.group_id !== group_id)
      return
    }

    if (event === 'member_removed' && member === myChatId) {
      removedFromGroups.value.add(group_id)
      groups.value = groups.value.filter(g => g.group_id !== group_id)
      return
    }

    // For other events, refresh the group list and detail if cached
    loadGroups()
    if (membersByGroup.value[group_id]) {
      loadGroupDetail(group_id)
    }
  }

  function startListening() {
    on('group_event', handleGroupEvent)
    return () => {
      off('group_event', handleGroupEvent)
    }
  }

  function clear() {
    accountGeneration += 1
    for (const gate of gates.values()) gate.invalidate()
    gates.clear()
    rosterLoads.clear()
    membershipStatus.value = {}
    groups.value = []
    membersByGroup.value = {}
    groupDetails.value = {}
    dissolvedGroups.value = new Set()
    removedFromGroups.value = new Set()
    myChatId = ''
  }

  return {
    membershipStatus,
    approveMembership,
    getTrustedMemberPubKeys,
    getCurrentMemberPubKeys,
    isMembershipTrusted,
    isRosterAvailable,
    assertMembershipTrusted,
    assertRosterAvailable,
    groups,
    membersByGroup,
    groupDetails,
    dissolvedGroups,
    removedFromGroups,
    setMyChatId,
    loadGroups,
    loadGroupDetail,
    getMemberPubKeys,
    getGroupName,
    getMembers,
    getGroupDetail,
    amIMuted,
    isDissolved,
    isRemoved,
    isGroupVisible,
    startListening,
    clear,
  }
})
