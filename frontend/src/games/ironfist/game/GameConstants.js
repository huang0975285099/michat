// 铁拳 - 常量定义（数值见 docs/ironfist.md 第四/五/十/十五节）

// 游戏阶段（playing 内部子状态）
export const PHASE = {
  ROUND_START: 'round_start',
  DECIDING: 'deciding',
  LOCKED: 'locked',
  RESOLVING: 'resolving',
  WAITING_CONFIRM: 'waiting_confirm',
  WAITING_RECONNECT: 'waiting_reconnect', // PvP：对手掉线，等待重连
  GAME_OVER: 'game_over',
}

// 动作类型
export const ACTION = {
  ATTACK: 'attack',
  DEFEND: 'defend',
  CHARGE: 'charge',
  COUNTER: 'counter',
}

export const ACTIONS = [ACTION.ATTACK, ACTION.DEFEND, ACTION.CHARGE, ACTION.COUNTER]

// 动作展示信息（HUD 用）
export const ACTION_META = {
  [ACTION.ATTACK]:  { icon: '⚔️', name: '攻击', hint: '12 伤害' },
  [ACTION.DEFEND]:  { icon: '🛡️', name: '防御', hint: '减伤 60%' },
  [ACTION.CHARGE]:  { icon: '⚡', name: '蓄力', hint: '攻击×2' },
  [ACTION.COUNTER]: { icon: '🔄', name: '反击', hint: '克制攻击' },
}

// 数值常量
export const INITIAL_HP = 100
export const BASE_DAMAGE = 12
export const DEFEND_REDUCTION = 0.4   // 防御减伤系数
export const CHARGE_MULTIPLIER = 2    // 蓄力倍率
export const LOW_HP_THRESHOLD = 30    // 残血强化阈值（攻击方）
export const LOW_HP_BUFF = 1.1        // 残血强化倍率
export const SHIELD_HP_THRESHOLD = 20 // 残血护盾阈值（被攻击方）
export const SHIELD_RATIO = 0.6       // 残血护盾伤害上限比例
export const CHARGE_HOLD_LIMIT = 2    // 蓄力标记最多保留 2 个可用回合，未攻击消耗则失效

// 僵局检测
export const STALE_NO_DMG_LIMIT = 5   // 连续无伤害回合上限
export const STALE_ENV_DMG = 5        // 僵局环境伤害基数
export const MAX_ROUNDS = 20          // 总回合上限
export const BOTH_CHARGED_LIMIT = 2   // 双方同时蓄力标记僵局上限

// 回合时间
export const ROUND_SECONDS = 30       // 决策倒计时
export const OPPONENT_GRACE_MS = 33_000 // PvP 收方等待对方动作宽限（30s + 3s）

// 断线重连（方案 B：服务端 action 流暂存 + 本地重放）
export const RECONNECT_WINDOW_MS = 60_000 // 对手掉线后等待重连上限：60 秒
export const IRONFIST_ACTIONS_TTL_MS = 30 * 60 * 1000 // 与后端 IronFistActionsTTL 对齐：30 分钟
// localStorage 持久化 key 前缀（用于本回合已选动作的续传）
export const LS_PENDING_KEY = (roomId) => `ironfist:pending:${roomId}`

// 伤害表：[玩家动作][对手动作] = { playerDmg, opponentDmg }
// 注意：蓄力 ×2、残血强化、残血护盾不在此表中，由 resolveRound() 按乘区顺序额外计算
//
// 【对称性约束 — PvP 确定性的前提】
// 必须满足 DT[a][b].playerDmg === DT[b][a].opponentDmg（对所有 a,b）。
// 否则 PvP 两端从各自视角结算同一回合会得出不同 HP（desync），
// PvE 也会因"谁被当作 player"而数值不公。
// 取整后的权威值见 docs/ironfist.md 第七节 Step3：蓄力被打断=18、反击成功=20。
export const DAMAGE_TABLE = {
  attack: {
    attack:  { playerDmg: 12, opponentDmg: 12 },
    defend:  { playerDmg: 0,  opponentDmg: 5  },
    charge:  { playerDmg: 0,  opponentDmg: 18 }, // 打断蓄力=18（对称 charge/attack.pd）
    counter: { playerDmg: 20, opponentDmg: 0  }, // 被反击=20（对称 counter/attack.od）
  },
  defend: {
    attack:  { playerDmg: 5,  opponentDmg: 0  },
    defend:  { playerDmg: 0,  opponentDmg: 0  },
    charge:  { playerDmg: 0,  opponentDmg: 0  },
    counter: { playerDmg: 0,  opponentDmg: 8  },
  },
  charge: {
    attack:  { playerDmg: 18, opponentDmg: 0  },
    defend:  { playerDmg: 0,  opponentDmg: 0  },
    charge:  { playerDmg: 0,  opponentDmg: 0  },
    counter: { playerDmg: 0,  opponentDmg: 8  },
  },
  counter: {
    attack:  { playerDmg: 0,  opponentDmg: 20 },
    defend:  { playerDmg: 8,  opponentDmg: 0  },
    charge:  { playerDmg: 8,  opponentDmg: 0  },
    counter: { playerDmg: 8,  opponentDmg: 8  },
  },
}
