import { on, off, send } from 'src/services/websocket.js'

// 房间作用域的 WebSocket 封装：自动过滤非本房间消息，附带 to/room_id。
export class GameNet {
  constructor(opponentId, roomId) {
    this.opponentId = opponentId
    this.roomId = roomId
    this._subs = []
  }

  on(type, handler) {
    const wrapped = (payload) => {
      if (payload.room_id !== this.roomId) return
      handler(payload)
    }
    this._subs.push({ type, wrapped })
    on(type, wrapped)
  }

  send(type, data) {
    send(type, { to: this.opponentId, room_id: this.roomId, ...data })
  }

  destroy() {
    this._subs.forEach(({ type, wrapped }) => off(type, wrapped))
    this._subs = []
  }
}
