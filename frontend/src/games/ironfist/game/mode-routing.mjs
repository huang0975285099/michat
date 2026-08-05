const AUTHORITATIVE_MODES = new Set(['pve', 'pvp', 'friend'])

export function engineKindForMode(mode) {
  return mode === 'practice' ? 'local' : AUTHORITATIVE_MODES.has(mode) ? 'authoritative' : null
}

export function requireAuthoritativeGameID(mode, gameID) {
  if (engineKindForMode(mode) !== 'authoritative') return gameID || ''
  if (!gameID) throw new Error(`${mode} requires a server-issued game_id`)
  return gameID
}
