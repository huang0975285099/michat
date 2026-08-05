export function ironFistAcceptCommand(to, roomId) {
  return { to, room_id: roomId, game: 'ironfist' }
}

export function ironFistReadyRoute(payload) {
  return {
    path: '/games/ironfist',
    query: {
      game_id: payload.game_id,
      opponent: payload.opponent,
      seat: payload.seat,
    },
  }
}
