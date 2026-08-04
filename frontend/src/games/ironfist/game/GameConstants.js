// Iron Fist - constant definition (see docs/ironfist.md Section 4/5/10/15 for values)

// Game stage (playing internal substate)
export const PHASE = {
  ROUND_START: 'round_start',
  DECIDING: 'deciding',
  LOCKED: 'locked',
  RESOLVING: 'resolving',
  WAITING_CONFIRM: 'waiting_confirm',
  WAITING_RECONNECT: 'waiting_reconnect', //PvP: Opponent disconnects, waiting to reconnect
  GAME_OVER: 'game_over',
}

// action type
export const ACTION = {
  ATTACK: 'attack',
  DEFEND: 'defend',
  CHARGE: 'charge',
  COUNTER: 'counter',
}

export const ACTIONS = [ACTION.ATTACK, ACTION.DEFEND, ACTION.CHARGE, ACTION.COUNTER]

// Action display information (for HUD)
export const ACTION_META = {
  [ACTION.ATTACK]:  { icon: '⚔️', name: 'attack', hint: '12 damage' },
  [ACTION.DEFEND]:  { icon: '🛡️', name: 'defense', hint: 'Damage reduction 60%' },
  [ACTION.CHARGE]:  { icon: '⚡', name: 'Accumulate strength', hint: 'attack×2' },
  [ACTION.COUNTER]: { icon: '🔄', name: 'counterattack', hint: 'Restrain attacks' },
}

// Numeric constant
export const INITIAL_HP = 100
export const BASE_DAMAGE = 12
export const DEFEND_REDUCTION = 0.4   //Defense damage reduction coefficient
export const CHARGE_MULTIPLIER = 2    //Charge multiplier
export const LOW_HP_THRESHOLD = 30    //Residual blood enhancement threshold (attacker)
export const LOW_HP_BUFF = 1.1        //Residual blood enhancement multiplier
export const SHIELD_HP_THRESHOLD = 20 //Residual health shield threshold (attacked party)
export const SHIELD_RATIO = 0.6       //Residual health shield damage upper limit ratio
export const CHARGE_HOLD_LIMIT = 2    //The charge mark will remain available for up to 2 turns and will become invalid if it is not consumed by an attack.

// deadlock detection
export const STALE_NO_DMG_LIMIT = 5   //Maximum number of consecutive damage-free rounds
export const STALE_ENV_DMG = 5        //Deadlock environment damage base
export const MAX_ROUNDS = 20          //Total round limit
export const BOTH_CHARGED_LIMIT = 2   //Both sides charged up at the same time to mark the upper limit of the deadlock.

// round time
export const ROUND_SECONDS = 30       //Decision countdown
export const OPPONENT_GRACE_MS = 33_000 //PvP The receiving side waits for the opponent's action grace (30s + 3s)

// Disconnection and reconnection (Plan B: server-side action stream temporary storage + local replay)
export const RECONNECT_WINDOW_MS = 60_000 //The upper limit for the opponent to wait to reconnect after disconnecting: 60 seconds
export const IRONFIST_ACTIONS_TTL_MS = 30 * 60 * 1000 //Alignment with backend IronFistActionsTTL: 30 minutes
// localStorage persistence key prefix (used for resuming the selected action in this round)
export const LS_PENDING_KEY = (roomId) => `ironfist:pending:${roomId}`
// localStorage persists the DECIDING starting timestamp of this round (local clock): the countdown will be resumed accordingly after refreshing and reconnecting.
// This prevents the reconnected party from getting a new 30s and being out of sync with the opponent's time. For details, see docs/ironfist-pvp.md Disconnection and Reconnection section.
export const LS_ROUND_KEY = (roomId) => `ironfist:round:${roomId}`

// Damage table: [player action][opponent action] = { playerDmg, opponentDmg }
// Note: Charge ×2, remaining health enhancement, and remaining health shield are not in this table, and are additionally calculated by resolveRound() in the order of multiplication zones.
//
// [Symmetry constraints—the prerequisite for PvP certainty]
// Must satisfy DT[a][b].playerDmg === DT[b][a].opponentDmg (for all a,b).
// Otherwise, both ends of PvP will get different HP (desync) when settling the same round from their respective perspectives.
// PvE can also be numerically unfair depending on who is considered the player.
// For the rounded authority value, see docs/ironfist.md Section 7 Step3: The charge is interrupted = 18, the counterattack is successful = 20.
export const DAMAGE_TABLE = {
  attack: {
    attack:  { playerDmg: 12, opponentDmg: 12 },
    defend:  { playerDmg: 0,  opponentDmg: 5  },
    charge:  { playerDmg: 0,  opponentDmg: 18 }, //Interrupt charge=18 (symmetrical charge/attack.pd)
    counter: { playerDmg: 20, opponentDmg: 0  }, //Counterattacked=20 (symmetrical counter/attack.od)
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
