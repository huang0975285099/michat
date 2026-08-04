import { connect, on, off, send } from 'src/services/websocket.js'

// Room scope WebSocket encapsulation: automatically filter non-room messages, with to/room_id attached.
export class GameNet {
  constructor(opponentId, roomId) {
    this.opponentId = opponentId
    this.roomId = roomId
    this._subs = []
  }

  on(type, handler) {
    const wrapped = (payload) => {
      if (String(payload.room_id) !== String(this.roomId)) return
      handler(payload)
    }
    this._subs.push({ type, wrapped })
    on(type, wrapped)
  }

  send(type, data) {
    send(type, { to: this.opponentId, room_id: this.roomId, ...data })
  }

  ready() {
    return connect()
  }

  destroy() {
    this._subs.forEach(({ type, wrapped }) => off(type, wrapped))
    this._subs = []
  }
}
