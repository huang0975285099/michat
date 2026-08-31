import axios from 'axios'
import { Notify } from 'quasar'
import { t } from 'src/i18n'

const isDev = process.env.DEV

const api = axios.create({
  baseURL: isDev ? '/api' : 'https://m.yzs88.com:8088/api',
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
      Notify.create({ type: 'warning', message: t('system.sessionExpired') })
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

// Offline encrypted attachments. These endpoints only receive opaque AES-GCM
// chunks and operational sizes; the file key/name/type remain inside chat E2EE.
export const attachmentApi = {
  quota: () => api.get('/attachments/quota'),
  init: (metadata, signal) => api.post('/attachments', metadata, { signal }),
  get: (id, signal) => api.get(`/attachments/${encodeURIComponent(id)}`, { signal }),
  putChunk: (id, index, ciphertext, sha256, signal) => api.put(
    `/attachments/${encodeURIComponent(id)}/chunks/${index}`,
    ciphertext,
    {
      signal,
      timeout: 120000,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Chunk-SHA256': sha256,
      },
    },
  ),
  complete: (id, signal) => api.post(`/attachments/${encodeURIComponent(id)}/complete`, null, { signal }),
  downloadChunk: (id, index, signal) => api.get(
    `/attachments/${encodeURIComponent(id)}/chunks/${index}`,
    { signal, timeout: 120000, responseType: 'arraybuffer' },
  ),
  acknowledge: (id, signal) => api.post(`/attachments/${encodeURIComponent(id)}/ack`, null, { signal }),
  cancel: (id, signal) => api.delete(`/attachments/${encodeURIComponent(id)}`, { signal }),
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
