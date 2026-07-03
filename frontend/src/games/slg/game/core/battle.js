// 九州征途 - 战斗结算（确定性，无随机；同输入必同结果，为联网校验留余地）
// 武将对决：双方互击，速度高者先出手（先手当回合灭掉对方则不承受反击）。
// 每回合按「对方攻击战力 vs 己方防御战力」互相消耗兵力，最多 BATTLE_MAX_ROUNDS 回合，
// 任一方兵力归零立即分出胜负；打满仍双方有兵则判平局。
// 双方形参同构（{atk,def,spd,troops}），守方既可以是 NPC 守将也可以是玩家部队（PVP 预留）。

import { BATTLE_MAX_ROUNDS, BATTLE_ROUND_ATTRITION } from '../GameConstants.js'

/**
 * @param {{atk:number, def:number, spd:number, troops:number}} attacker  进攻方军团
 * @param {{atk:number, def:number, spd:number, troops:number}} defender  防守方军团
 * @returns {{outcome:'win'|'lose'|'draw', atkLoss:number, defLoss:number, exp:number,
 *            first:'atk'|'def',
 *            rounds:Array<{round:number, atkTroops:number, defTroops:number, atkLoss:number, defLoss:number}>,
 *            atkStart:number, defStart:number}}
 */
export function resolveBattle(attacker, defender) {
  // 兵力一律取整入场：守军经在线/离线回复后会带小数（每回合按比例损耗取整后，
  // 小数残余永远抹不掉 → 守军「杀不死」而假判平局，且战报显示难看的浮点数）。
  const atkStart = Math.round(attacker.troops)
  const defStart = Math.round(defender.troops)
  // 先手方：速度高者（平手攻方先，主动进攻占先机）
  const first = (defender.spd || 0) > (attacker.spd || 0) ? 'def' : 'atk'

  if (defStart <= 0) {
    return { outcome: 'win', atkLoss: 0, defLoss: 0, exp: 50, first, rounds: [], atkStart, defStart }
  }

  let atkTroops = atkStart
  let defTroops = defStart
  const rounds = []

  // X 承受的损失 = X兵力 × min(1, 系数 × Y攻击战力 / X防御战力)
  // 返回换算明细（战力/倍率），供「完整战报」展示战斗道理用
  const strike = (xTroops, xDef, yTroops, yAtk) => {
    const atkPow = yTroops * (1 + yAtk / 100)
    const defPow = xTroops * (1 + xDef / 100)
    const ratio = Math.min(1, BATTLE_ROUND_ATTRITION * atkPow / defPow)
    const loss = Math.min(xTroops, Math.round(xTroops * ratio))
    return { atkPow, defPow, ratio, loss }
  }

  for (let round = 1; round <= BATTLE_MAX_ROUNDS; round++) {
    let atkLoss = 0, defLoss = 0
    const actions = []
    if (first === 'atk') {
      const s1 = strike(defTroops, defender.def, atkTroops, attacker.atk)
      defLoss = s1.loss; defTroops -= defLoss
      actions.push({ striker: 'atk', atkPow: s1.atkPow, defPow: s1.defPow, ratio: s1.ratio, loss: defLoss })
      // 后手方未被灭才反击
      if (defTroops > 0) {
        const s2 = strike(atkTroops, attacker.def, defTroops, defender.atk)
        atkLoss = s2.loss; atkTroops -= atkLoss
        actions.push({ striker: 'def', atkPow: s2.atkPow, defPow: s2.defPow, ratio: s2.ratio, loss: atkLoss })
      }
    } else {
      const s1 = strike(atkTroops, attacker.def, defTroops, defender.atk)
      atkLoss = s1.loss; atkTroops -= atkLoss
      actions.push({ striker: 'def', atkPow: s1.atkPow, defPow: s1.defPow, ratio: s1.ratio, loss: atkLoss })
      if (atkTroops > 0) {
        const s2 = strike(defTroops, defender.def, atkTroops, attacker.atk)
        defLoss = s2.loss; defTroops -= defLoss
        actions.push({ striker: 'atk', atkPow: s2.atkPow, defPow: s2.defPow, ratio: s2.ratio, loss: defLoss })
      }
    }
    rounds.push({ round, atkTroops, defTroops, atkLoss, defLoss, actions })
    if (atkTroops <= 0 || defTroops <= 0) break
  }

  const outcome = defTroops <= 0 ? 'win' : (atkTroops <= 0 ? 'lose' : 'draw')
  const atkLoss = atkStart - atkTroops
  const defLoss = defStart - defTroops
  const expBase = outcome === 'win' ? 100 : (outcome === 'draw' ? 50 : 20)
  const exp = Math.round(defLoss * 0.5) + expBase

  return { outcome, atkLoss, defLoss, exp, first, rounds, atkStart, defStart }
}
