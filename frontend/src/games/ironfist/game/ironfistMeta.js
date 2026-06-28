// 铁拳大厅/账本/成就/记录视图共享的展示常量。
// 与后端保持一致：成就见 model.AchievementDefinitions，流水类型见 004_fist_token.sql。

// 成就定义（code 与后端一致）
export const ACHIEVEMENTS = [
  { code: 'first_battle', name: '初出茅庐', desc: '完成 1 场对战', icon: '🎯' },
  { code: 'hundred_battles', name: '百战不殆', desc: '累计 100 场对战', icon: '💯' },
  { code: 'win_streak_5', name: '连胜达人', desc: '连胜 5 场', icon: '🔥' },
  { code: 'counter_master', name: '反击大师', desc: '单场反击成功 3 次', icon: '🔄' },
  { code: 'low_hp_comeback', name: '残血翻盘', desc: 'HP < 10 时获胜', icon: '⚡' },
  { code: 'high_hp_win', name: '稳操胜券', desc: 'HP > 90 时获胜', icon: '🛡️' },
]

// 成就 code → meta 快查（结果页解锁提示用）
export const ACHIEVEMENT_MAP = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.code, a]))

// PVP 房间档位（链上质押对战，后续开放）
export const PVP_TIERS = [
  { key: 'gold', name: '黄金场', desc: '入门竞技 · 轻松上分', icon: '🥇', stake: 100 },
  { key: 'platinum', name: '铂金场', desc: '进阶博弈 · 高手过招', icon: '💠', stake: 1000 },
  { key: 'diamond', name: '钻石场', desc: '巅峰对决 · 一掷千金', icon: '👑', stake: 10000 },
]

// $FIST 流水类型 → 展示文案（无 remark 时回退）
export const TX_TYPE_LABEL = {
  pve_reward: 'PvE 奖励',
  pvp_win: 'PvP 赢局',
  pvp_loss: 'PvP 输局',
  pvp_fee: 'PvP 手续费',
  tournament_entry: '锦标赛报名',
  tournament_prize: '锦标赛奖励',
  referral_reward: '邀请奖励',
  staking_reward: '质押分红',
  nft_mint: 'NFT 铸造',
  withdraw: '提现',
  deposit: '充值',
  system_adjust: '系统调整',
}

// 对局结果 → 展示（逐局明细用）
export const MATCH_RESULT_META = {
  win: { text: '胜利', icon: '🏆', tone: 'win' },
  lose: { text: '失败', icon: '💀', tone: 'lose' },
  draw: { text: '平局', icon: '🤝', tone: 'draw' },
  doubleLose: { text: '双双力竭', icon: '💥', tone: 'draw' },
}

// 时间戳 → M/D HH:mm
export function fmtTime(s) {
  if (!s) return ''
  const d = new Date(s)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
