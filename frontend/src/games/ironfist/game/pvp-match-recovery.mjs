export function matchedQueuePayload(data = {}) {
  if (data.status !== 'matched' || !data.room_id) return null
  return {
    roomId: data.room_id,
    gameId: data.game_id,
    opponent: data.opponent,
    tier: data.tier,
    stake: data.stake,
  }
}
