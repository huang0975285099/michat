// 九州征途 - 战斗结算（确定性，无随机；同输入必同结果，为联网校验留余地）

/**
 * @param {{atk:number, troops:number}} attacker  进攻方（武将属性 + 兵力）
 * @param {{def:number, troops:number}} defender  防守方（守军）
 * @returns {{win:boolean, atkLoss:number, defLoss:number, exp:number}}
 */
export function resolveBattle(attacker, defender) {
  if (defender.troops <= 0) {
    return { win: true, atkLoss: 0, defLoss: 0, exp: 50 }
  }
  const aPow = attacker.troops * (1 + attacker.atk / 100)
  const dPow = defender.troops * (1 + defender.def / 100)
  const win = aPow > dPow

  let atkLoss, defLoss
  if (win) {
    // 优势越大伤亡越小；守军全灭
    const ratio = dPow / aPow            // (0,1)
    atkLoss = Math.round(attacker.troops * ratio * 0.5)
    defLoss = defender.troops
  } else {
    // 战败：己方重创，守军按劣势比例受损
    const ratio = aPow / dPow            // (0,1]
    atkLoss = Math.round(attacker.troops * 0.7)
    defLoss = Math.round(defender.troops * ratio * 0.5)
  }
  atkLoss = Math.min(atkLoss, attacker.troops)
  defLoss = Math.min(defLoss, defender.troops)

  // 经验：与歼敌数挂钩，战败也给少量
  const exp = Math.round(defLoss * 0.5) + (win ? 100 : 20)
  return { win, atkLoss, defLoss, exp }
}
