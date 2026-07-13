// 门派 PK · 梦幻西游风 - 战斗界面响应式布局（BattleScene 与 UIScene 的唯一坐标来源）
//
// 两个场景叠在同一块画布上：BattleScene 画角色立绘，UIScene 画数据面板/按钮/日志。
// 角色必须落在面板之间的空档里，所以两者的坐标只能有一份定义，否则改一处就会错位。
//
// 横屏：梦幻西游式对角站位，数据面板分居左右上角，指令栏竖排在右侧。
// 竖屏（手机）：数据面板上下堆叠在顶部，角色居中纵向排列，指令栏铺成底部三列网格。

const PORTRAIT = {
  panelH: 96,          // 竖屏数据面板压缩高度（行距收紧）
  btnH: 40, btnGap: 6, btnCols: 3, btnRows: 3,   // 4 技能 + 普攻 + 必杀 + 防御 = 7 个，3×3 放得下
  margin: 8,
  // 立绘尺寸压缩后单个角色占 y-54 ~ y+20 共约 74px，两个角色 + 间隔正好塞进小屏的中间空档
  charEmojiSize: 44, charEmojiOffset: -32, charNameOffset: 12, charBaseW: 100,
}

const LANDSCAPE = {
  panelH: 118,
  btnH: 44, btnGap: 6, btnW: 118,
  charEmojiSize: 96, charEmojiOffset: -60, charNameOffset: 16, charBaseW: 144,
}

/**
 * @param {number} w 画布宽
 * @param {number} h 画布高
 */
export function getBattleLayout(w, h) {
  const portrait = h > w
  return portrait ? portraitLayout(w, h) : landscapeLayout(w, h)
}

function portraitLayout(w, h) {
  const P = PORTRAIT
  const actionH = P.btnRows * (P.btnH + P.btnGap) - P.btnGap
  const actionTop = h - P.margin - actionH
  const hintY = actionTop - 12
  const tickerY = actionTop - 30

  const enemyTop = P.margin
  const playerTop = enemyTop + P.panelH + P.margin
  // 角色可用竖直空档：玩家面板下沿 ~ 日志单行上沿
  const bandTop = playerTop + P.panelH + 10
  const bandBottom = tickerY - 12

  return {
    portrait: true,
    panelH: P.panelH,
    barW: Math.min(w - 40, 300),
    // 面板内容以中心为原点、上沿在 -10，故 y = 顶边 + 10
    enemyPanel: { x: w / 2, y: enemyTop + 10 },
    playerPanel: { x: w / 2, y: playerTop + 10 },
    // 回合数在竖屏不占竖直空间，做成右上角小角标
    round: { x: w - 14, y: P.margin + 2, size: 26, originX: 1, showSub: false },
    timer: { x: w - 14, y: P.margin + 34, originX: 1 },
    // 竖屏日志退化为单行滚动条，省下 80px 给角色
    log: { x: w / 2, y: tickerY, width: w - 24, lines: 1, ticker: true },
    action: {
      top: actionTop, left: 12, cols: P.btnCols, gap: P.btnGap,
      btnW: Math.max(84, (w - 24 - (P.btnCols - 1) * P.btnGap) / P.btnCols),
      btnH: P.btnH,
    },
    hint: { x: w / 2, y: hintY },
    enemyChar: { x: w / 2, y: bandTop + 54 },
    playerChar: { x: w / 2, y: bandBottom - 20 },
    char: {
      emojiSize: P.charEmojiSize, emojiOffset: P.charEmojiOffset,
      nameOffset: P.charNameOffset, baseW: P.charBaseW,
    },
    resultPanel: { w: Math.min(340, w - 24), h: Math.min(380, h - 60) },
  }
}

function landscapeLayout(w, h) {
  const L = LANDSCAPE
  return {
    portrait: false,
    panelH: L.panelH,
    barW: 240,
    enemyPanel: { x: 144, y: 22 },
    playerPanel: { x: w - 144, y: 22 },
    round: { x: w / 2, y: 6, size: 54, originX: 0.5, showSub: true },
    timer: { x: w / 2, y: 82, originX: 0.5 },
    log: { x: 12, y: h - 128, width: 232, lines: 5, ticker: false },
    action: {
      // 右侧竖排指令栏（仿梦幻西游），整列垂直居中
      top: null, left: null, cols: 1, gap: L.btnGap, btnW: L.btnW, btnH: L.btnH,
      rightAligned: true,
    },
    hint: { x: w / 2, y: h - 26 },
    // 梦幻西游式对角站位：敌方左上、玩家右下，隔场相望
    enemyChar: { x: w * 0.34, y: h * 0.30 },
    playerChar: { x: w * 0.62, y: h * 0.62 },
    char: {
      emojiSize: L.charEmojiSize, emojiOffset: L.charEmojiOffset,
      nameOffset: L.charNameOffset, baseW: L.charBaseW,
    },
    resultPanel: { w: Math.min(380, w - 32), h: Math.min(400, h - 40) },
  }
}
