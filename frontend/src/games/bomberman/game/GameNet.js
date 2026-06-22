import { on, off, send } from 'src/services/websocket.js'

export class GameNet {
  constructor(opponentId, roomId) {
    this.opponentId = opponentId
    this.roomId = roomId
    this._subs = [] // { type, wrapped }
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
