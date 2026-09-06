export const DRAGON_TIGER_ODDS = Object.freeze({
  dragon: Object.freeze([195, 100]),
  tiger: Object.freeze([195, 100]),
  draw: Object.freeze([8, 1]),
})

export function isValidDragonTigerAmount(amount) {
  return Number.isSafeInteger(amount) && amount >= 20 && amount % 20 === 0
}

export function calculateDragonTigerPayout(stake, selection) {
  if (!Number.isSafeInteger(stake) || stake < 0) return 0
  const odds = DRAGON_TIGER_ODDS[selection]
  if (!odds) return 0
  return Math.trunc(stake * odds[0] / odds[1])
}

export function calculateDragonTigerStreak(rounds, hasMore = false) {
  if (!Array.isArray(rounds)) return null
  const outcomes = rounds
    .map(round => round?.result)
    .filter(result => result === 'dragon' || result === 'tiger' || result === 'draw')
  if (!outcomes.length) return null
  const result = outcomes[0]
  let count = 0
  while (outcomes[count] === result) count++
  return { result, count, truncated: hasMore && count === outcomes.length }
}

export function phaseDeadline(round) {
  if (!round) return null
  if (round.status === 'betting') return round.betting_ends_at || null
  if (round.status === 'playing') return round.battle_ends_at || null
  if (round.status === 'settled' || round.status === 'voided') return round.display_ends_at || null
  return null
}

export function shouldApplyDragonTigerEvent(currentRound, payload) {
  const incomingRound = Number(payload?.round_id)
  const currentId = Number(currentRound?.id)
  if (!Number.isFinite(incomingRound)) return true
  if (Number.isFinite(currentId) && incomingRound < currentId) return false
  if (incomingRound > currentId) return true
  const incomingVersion = Number(payload?.state_version)
  const currentVersion = Number(currentRound?.state_version)
  if (Number.isFinite(incomingVersion) && Number.isFinite(currentVersion)) return incomingVersion > currentVersion
  return true
}
