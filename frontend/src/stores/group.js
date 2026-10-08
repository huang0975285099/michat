import { defineStore } from 'pinia'
import { ref } from 'vue'
import { groupApi } from '../services/api.js'
import { on, off } from '../services/websocket.js'

export const useGroupStore = defineStore('group', () => {
  const groups = ref([]) // [{group_id, name, member_count, last_message_at}]
  const membersByGroup = ref({}) // { [groupId]: [{chat_id, nickname, public_key, muted_until, state}] }
  const dissolvedGroups = ref(new Set()) // group_ids that received 'dissolved' event
  const removedFromGroups = ref(new Set()) // group_ids where self was removed

  let myChatId = ''

  function setMyChatId(chatId) {
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
    try {
      const res = await groupApi.detail(groupId)
      membersByGroup.value[groupId] = res.data?.members || []
      return res.data
    } catch (e) {
      console.warn('[group] loadGroupDetail failed', e)
      return null
    }
  }

  function getMemberPubKeys(groupId) {
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

  function amIMuted(groupId) {
    const members = membersByGroup.value[groupId] || []
    const me = members.find(m => m.chat_id === myChatId)
    if (!me || !me.muted_until) return false
    return new Date(me.muted_until) > new Date()
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
    groups.value = []
    membersByGroup.value = {}
    dissolvedGroups.value = new Set()
    removedFromGroups.value = new Set()
    myChatId = ''
  }

  return {
    groups,
    membersByGroup,
    dissolvedGroups,
    removedFromGroups,
    setMyChatId,
    loadGroups,
    loadGroupDetail,
    getMemberPubKeys,
    getGroupName,
    getMembers,
    amIMuted,
    isDissolved,
    isRemoved,
    isGroupVisible,
    startListening,
    clear,
  }
})
