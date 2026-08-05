import axios from 'axios'
import { Notify } from 'quasar'

const isDev = process.env.DEV

const api = axios.create({
  baseURL: isDev ? '/api' : 'https://yb.yzs88.com/api',
  timeout: 10000
})

// Automatically attach session token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('session_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// 401 → Clear local status and jump back to login page
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && localStorage.getItem('session_token')) {
      localStorage.removeItem('session_token')
      Notify.create({ type: 'warning', message: 'You are already logged in on another device，The current session has expired' })
      // Delay the jump and let notify display first
      setTimeout(() => { window.location.href = '/#/init' }, 1500)
    }
    return Promise.reject(err)
  }
)

// Identity related
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

// User search
export const userApi = {
  search: (id) => api.get('/users/search', { params: { id } })
}

// Friends related
export const friendApi = {
  sendRequest: (toChatId) => api.post('/friends/request', { to_chat_id: toChatId }),
  getRequests: () => api.get('/friends/requests'),
  getOutgoing: () => api.get('/friends/outgoing'),
  handleRequest: (id, accept) => api.put(`/friends/request/${id}`, { accept }),
  cancelRequest: (id) => api.delete(`/friends/request/${id}`),
  getFriends: () => api.get('/friends'),
  getReadReceipts: (peerChatId) => api.get(`/friends/${peerChatId}/read-receipts`)
}

// Call TURN Credentials
export const callApi = {
  getTurnCredentials: () => api.get('/turn-credentials')
}

// Invitation related
export const inviteApi = {
  generate: () => api.post('/invite/generate'),
  validate: (code) => api.get('/invite/validate', { params: { code } })
}

// Device push token (Aurora Registration ID)
export const deviceApi = {
  save: (regId) => api.post('/device/token', { reg_id: regId }),
  remove: () => api.delete('/device/token')
}

// $FIST Token
export const fistApi = {
  getAccount: () => api.get('/fist/account'),
  getTransactions: (beforeId, limit = 20) =>
    api.get('/fist/transactions', { params: { before_id: beforeId || undefined, limit } })
}

// Tekken Battle Statistics and Achievements
export const ironfistApi = {
  getStats: () => api.get('/games/ironfist/stats'),
  listMatches: (beforeId, limit = 20) =>
    api.get('/games/ironfist/matches', { params: { before_id: beforeId || undefined, limit } }),
  // Join the PVP matching queue → return {status:'queued'|'matched', room_id, opponent, tier, stake}
  joinPVPQueue: (tier) => api.post('/games/ironfist/pvp/queue', { tier }),
  // Take the initiative to cancel the matching (refund the pledge in full)
  cancelPVPQueue: () => api.delete('/games/ironfist/pvp/queue'),
  // Query the current matching queue status → {status:'idle'|'queued'|'matched', ...} (Polling when WS notification is lost)
  getPVPQueueStatus: () => api.get('/games/ironfist/pvp/queue'),
  startPVESession: (replace = false) => api.post('/games/ironfist/pve/sessions', { replace }),
  getActiveSession: () => api.get('/games/ironfist/sessions/active'),
  getGame: (id) => api.get(`/games/ironfist/games/${encodeURIComponent(id)}`),
  submitAction: (id, body) => api.post(`/games/ironfist/games/${encodeURIComponent(id)}/actions`, body),
  resignGame: (id) => api.post(`/games/ironfist/games/${encodeURIComponent(id)}/resign`),
}

// Version information (public interface, returns the latest online version)
export const versionApi = {
  get: () => api.get('/version')
}

export default api
