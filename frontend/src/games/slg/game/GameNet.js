// 九州征途 - 多人世界网络层
// 负责通过 WebSocket 订阅领地变更与玩家上下线事件。
// HTTP API（join/saveState/updateTerritory）由 SlgPage.vue 直接调用 slgApi；
// 本模块仅处理 WS 入站事件的订阅与回调分发。

import { on, off, send } from 'src/services/websocket.js'

export class SlgGameNet {
  constructor() {
    this._subs = []
    this._onTerritoryUpdate = null
    this._onPresence = null
  }

  /**
   * 加入 SLG 世界（WS 订阅）。在 HTTP join 成功后调用。
   */
  joinWorld() {
    // 注册 WS 事件监听
    this._register('slg_territory_update', this._handleTerritoryUpdate.bind(this))
    this._register('slg_presence', this._handlePresence.bind(this))

    // 通知服务端：进入 SLG 世界
    send('slg_join', {})
  }

  /**
   * 离开 SLG 世界（WS 取消订阅）。
   */
  leaveWorld() {
    send('slg_leave', {})
    this._subs.forEach(({ type, wrapped }) => off(type, wrapped))
    this._subs = []
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
}
