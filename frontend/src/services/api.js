import axios from 'axios'
import { Notify } from 'quasar'

const isDev = process.env.DEV

const api = axios.create({
  baseURL: isDev ? '/api' : 'https://yb.yzs88.com/api',
  timeout: 10000
})

// 自动附加 session token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('session_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// 401 → 清除本地状态，跳回登录页
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && localStorage.getItem('session_token')) {
      localStorage.removeItem('session_token')
      Notify.create({ type: 'warning', message: '您已在其他设备登录，当前会话已失效' })
      // 延迟跳转，让 notify 先显示
      setTimeout(() => { window.location.href = '/#/init' }, 1500)
    }
    return Promise.reject(err)
  }
)

// 身份相关
export const identityApi = {
  init: (inviteCode = '') => api.post('/identity/init', inviteCode ? { invite_code: inviteCode } : {}),
  challenge: (publicKey) => api.get('/identity/reauth/challenge', { params: { public_key: publicKey } }),
  reauth: (publicKey, signature, nonce) => api.post('/identity/reauth', { public_key: publicKey, signature, nonce }),
  uploadPubkey: (publicKey) => api.put('/identity/pubkey', { public_key: publicKey }),
  me: () => api.get('/identity/me'),
  logout: () => api.delete('/identity/logout'),
  deleteAccount: () => api.delete('/identity/me'),
  updateNickname: (nickname) => api.put('/identity/nickname', { nickname })
}

// 用户搜索
export const userApi = {
  search: (id) => api.get('/users/search', { params: { id } })
}

// 好友相关
export const friendApi = {
  sendRequest: (toChatId) => api.post('/friends/request', { to_chat_id: toChatId }),
  getRequests: () => api.get('/friends/requests'),
  getOutgoing: () => api.get('/friends/outgoing'),
  handleRequest: (id, accept) => api.put(`/friends/request/${id}`, { accept }),
  cancelRequest: (id) => api.delete(`/friends/request/${id}`),
  getFriends: () => api.get('/friends'),
  getReadReceipts: (peerChatId) => api.get(`/friends/${peerChatId}/read-receipts`)
}

// 通话 TURN 凭证
export const callApi = {
  getTurnCredentials: () => api.get('/turn-credentials')
}

// 邀请相关
export const inviteApi = {
  generate: () => api.post('/invite/generate'),
  validate: (code) => api.get('/invite/validate', { params: { code } })
}

// 设备推送 token（极光 Registration ID）
export const deviceApi = {
  save: (regId) => api.post('/device/token', { reg_id: regId }),
  remove: () => api.delete('/device/token')
}

// $FIST 代币
export const fistApi = {
  getAccount: () => api.get('/fist/account'),
  claimPvEReward: () => api.post('/fist/pve-reward'),
  getTransactions: (beforeId, limit = 20) =>
    api.get('/fist/transactions', { params: { before_id: beforeId || undefined, limit } })
}

// 铁拳对战统计与成就
export const ironfistApi = {
  getStats: () => api.get('/games/ironfist/stats'),
  reportMatch: (payload) => api.post('/games/ironfist/stats', payload),
  listMatches: (beforeId, limit = 20) =>
    api.get('/games/ironfist/matches', { params: { before_id: beforeId || undefined, limit } }),
  // 加入 PVP 撮合队列 → 返回 {status:'queued'|'matched', room_id, opponent, tier, stake}
  joinPVPQueue: (tier) => api.post('/games/ironfist/pvp/queue', { tier }),
  // 主动取消撮合（全额退回质押）
  cancelPVPQueue: () => api.delete('/games/ironfist/pvp/queue'),
  // 查询当前撮合队列状态 → {status:'idle'|'queued'|'matched', ...}（WS 通知丢失时轮询兜底）
  getPVPQueueStatus: () => api.get('/games/ironfist/pvp/queue'),
}

// 版本信息（公开接口，返回线上最新版本）
export const versionApi = {
  get: () => api.get('/version')
}

// 九州征途（SLG）多人世界
export const slgApi = {
  // 加入世界 → 返回 { world_id, seed, season, spawn_x, spawn_y, is_new_player, state, territories, players }
  // 满员时返回 403 {error:'world_full'}
  join: () => api.post('/games/slg/join'),
  // 获取世界快照（领地列表 + 在线玩家）
  getWorld: () => api.get('/games/slg/world'),
  // 查询世界状态 { player_count, max_players, full }
  getStatus: () => api.get('/games/slg/status'),
  // 保存玩家状态
  saveState: (state) => api.put('/games/slg/state', { state }),
  // 更新领地归属 { x, y, is_city, action: 'claim'|'abandon' }
  updateTerritory: (payload) => api.post('/games/slg/territory', payload),
  // 出征/行军开始上报 { march_uid, intent, from, to, path, depart_at_ms, arrive_at_ms, units }
  marchStart: (payload) => api.post('/games/slg/march', payload),
  // 行军结束上报（到达/驻扎/召回/被消灭后清理）{ march_uid }
  marchEnd: (marchUid) => api.post('/games/slg/march/end', { march_uid: marchUid }),
  // 玩家部队碰撞遭遇战结果上报 { march_uid, units, status, other_march_uid, other_units, other_status, seed }
  reportMarchBattle: (payload) => api.post('/games/slg/march/battle', payload),
  // 管理员重置当前世界（清空所有玩家与领地，下次 Join 创建新世界）
  resetWorld: () => api.post('/games/slg/reset'),
}

export default api
