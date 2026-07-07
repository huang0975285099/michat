// 九州征途 - 多人世界网络层
// 负责通过 WebSocket 订阅领地变更与玩家上下线事件。
// HTTP API（join/saveState/updateTerritory）由 SlgPage.vue 直接调用 slgApi；
// 本模块仅处理 WS 入站事件的订阅与回调分发。

import { on, off, send, wsConnected } from 'src/services/websocket.js'
import { watch } from 'vue'

export class SlgGameNet {
  constructor() {
    this._subs = []
    this._onTerritoryUpdate = null
    this._onPresence = null
    this._onAIExpansion = null
    this._onReconnect = null
    this._unwatchReconnect = null
  }

  /**
   * 加入 SLG 世界（WS 订阅）。在 HTTP join 成功后调用。
   */
  joinWorld() {
    // 注册 WS 事件监听
    this._register('slg_territory_update', this._handleTerritoryUpdate.bind(this))
    this._register('slg_presence', this._handlePresence.bind(this))
    this._register('slg_ai_expansion', this._handleAIExpansion.bind(this))

    // 通知服务端：进入 SLG 世界
    send('slg_join', {})

    // WS 断线重连：底层 websocket.js 的重连只重新鉴权，不会重发任何业务层"加入房间"
    // 消息。而服务端在断线时（Unregister）已经把本端从"这个世界的在线名单"里摘掉了
    // （slgSvc.Leave），如果不在这里重新报到，本端会永久收不到之后任何人的上下线广播，
    // 导致后加入玩家的主城安全区/领地数据再也同步不过来——只能靠手动刷新页面硬重连才恢复。
    // 重新报到的同时通知上层借机做一次全量重新同步，补上断线期间错过的变更。
    this._unwatchReconnect = watch(wsConnected, (v) => {
      if (!v) return
      send('slg_join', {})
      this._onReconnect?.()
    })
  }

  /**
   * 离开 SLG 世界（WS 取消订阅）。
   */
  leaveWorld() {
    send('slg_leave', {})
    this._subs.forEach(({ type, wrapped }) => off(type, wrapped))
    this._subs = []
    this._unwatchReconnect?.()
    this._unwatchReconnect = null
  }

  /**
   * 设置领地变更回调。
   * @param {(ev: {x,y,owner_chat_id,owner_name,is_city,action}) => void} cb
   */
  onTerritoryUpdate(cb) { this._onTerritoryUpdate = cb }

  /**
   * 设置玩家上下线回调。
   * @param {(ev: {chat_id,online}) => void} cb
   */
  onPresence(cb) { this._onPresence = cb }

  /**
   * 设置 AI 扩张回调（服务端权威 AI 领地变更）。
   * @param {(ev: {faction_id,x,y,level,tile_type,action}) => void} cb
   */
  onAIExpansion(cb) { this._onAIExpansion = cb }

  /**
   * 设置 WS 重连回调：断线重连、重新报到（slg_join）之后触发一次，
   * 上层应借机重新拉取一次全量世界快照，避免断线期间错过的领地/上下线广播导致长期 desync。
   * @param {() => void} cb
   */
  onReconnect(cb) { this._onReconnect = cb }

  _register(type, handler) {
    this._subs.push({ type, wrapped: handler })
    on(type, handler)
  }

  _handleTerritoryUpdate(payload) {
    if (this._onTerritoryUpdate) this._onTerritoryUpdate(payload)
  }

  _handlePresence(payload) {
    if (this._onPresence) this._onPresence(payload)
  }

  _handleAIExpansion(payload) {
    if (this._onAIExpansion) this._onAIExpansion(payload)
  }
}
