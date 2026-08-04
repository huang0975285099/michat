// Display constants shared by Tekken Hall/Ledger/Achievements/Record Views.
// Consistent with the backend: see model.AchievementDefinitions for achievements, and 004_fist_token.sql for pipeline types.

// Achievement definition (code is consistent with the backend)
export const ACHIEVEMENTS = [
  { code: 'first_battle', name: 'fledgling', desc: 'Complete 1 battle', icon: '🎯' },
  { code: 'hundred_battles', name: 'Fight a hundred battles without danger', desc: 'cumulative 100 battle', icon: '💯' },
  { code: 'win_streak_5', name: 'Winning Streak Master', desc: 'winning streak 5 field', icon: '🔥' },
  { code: 'counter_master', name: 'counter master', desc: 'Successful counterattack in a single game 3 times', icon: '🔄' },
  { code: 'low_hp_comeback', name: 'Comeback with residual health', desc: 'HP < 10 win when', icon: '⚡' },
  { code: 'high_hp_win', name: 'Guaranteed victory', desc: 'HP > 90 win when', icon: '🛡️' },
]

// Achievement code → meta quick check (used for unlocking prompts on the results page)
export const ACHIEVEMENT_MAP = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.code, a]))

// PVP room slots (points pledge battle)
export const PVP_TIERS = [
  { key: 'gold', name: 'gold field', desc: 'Entry level sports · Score easily', icon: '🥇', stake: 100 },
  { key: 'platinum', name: 'platinum field', desc: 'Advanced gaming · Masters compete with each other', icon: '💠', stake: 1000 },
  { key: 'diamond', name: 'diamond field', desc: 'Peak showdown · Spend a fortune', icon: '👑', stake: 10000 },
]

// Points flow type → display copy (return when there is no remark)
export const TX_TYPE_LABEL = {
  pve_reward: 'PvE reward',
  pvp_stake: 'PvP pledge',
  pvp_win: 'PvP Win the game',
  pvp_loss: 'PvP Lose the game',
  pvp_fee: 'PvP handling fee',
  tournament_entry: 'Tournament Registration',
  tournament_prize: 'Tournament rewards',
  referral_reward: 'Invitation rewards',
  staking_reward: 'Pledge dividends',
  nft_mint: 'NFT casting',
  withdraw: 'Withdraw cash',
  deposit: 'Recharge',
  system_adjust: 'System adjustment',
}

// Game results → display (for game-by-game details)
export const MATCH_RESULT_META = {
  win: { text: 'victory', icon: '🏆', tone: 'win' },
  lose: { text: 'failed', icon: '💀', tone: 'lose' },
  draw: { text: 'draw', icon: '🤝', tone: 'draw' },
  doubleLose: { text: 'Both exhausted', icon: '💥', tone: 'draw' },
}

// Timestamp → M/D HH:mm
export function fmtTime(s) {
  if (!s) return ''
  const d = new Date(s)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
