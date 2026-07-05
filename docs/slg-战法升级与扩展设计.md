# 战法升级与扩展设计（V2.0）

> 本文档基于 `frontend/src/games/slg/game/core/skills.js` 的 Skill 抽象与 `slg-战斗和战报.md` 的战斗流程设计。
> V2.0 重大重构：精简重复战法（17→7保留）+ 中度扩展新机制（治疗/增益/减益），总数 15。

---

## 一、设计目标

1. **战法总数 15 个**：保留 7 个核心战法（精简掉重复设计），新增 8 个好玩战法（参考率土之滨/三国志战略版）。
2. **全部战法可升级**，最高 **Lv.10**。
3. **中度扩展引擎**：新增 3 种 effect（`heal`/`buff`/`debuff`），新增字段（`lifesteal`/`condition`/`buffAttr` 等），不新增 timing。
4. **各属性都有用武之地**：武力/智力/速度/统率四类属性均有专属战法。
5. **EV 同数量级**，避免某个战法一家独大。

---

## 二、精简规则

| 原战法组 | 保留 | 删除 |
|----------|------|------|
| 武力单体：挥砍/猛击/突刺 | **力劈**（取挥砍数值，重命名） | 猛击、突刺 |
| 速度类：践踏/疾风/突袭 | **疾风** | 践踏、突袭 |
| 智力单体：火攻/水攻/天雷 | **火攻** | 水攻、天雷 |
| 追击类：连击/追击/横扫 | **连击** | 追击、横扫 |
| 控制类：谎报/威慑/迷阵/缴械 | **谎报** | 威慑、迷阵、缴械 |
| 武力群体：旋风/箭雨 | **箭雨**（3目标散射，与落雷形成差异） | 旋风 |
| 智力群体：落雷/毒计 | **落雷** | 毒计 |

> **STATUSES 字典收缩**：仅保留 `huangbao`（谎报），其余 3 个状态删除。

---

## 三、战法数据字段

在 V1.2 字段基础上，新增字段：

| 字段 | 说明 |
|------|------|
| `effect` | `damage` / `control` / `extra_attack` / **`heal`** / **`buff`** / **`debuff`** |
| `target` | `random_enemy` / **`random_ally`** / **`self`** |
| `lifesteal` | 吸血比例（0~1），伤害的一定比例回复自身兵力 |
| `condition` | 条件触发 ID，如 `low_hp`（自身兵力 < 50% 时倍率 ×1.5） |
| `conditionMult` | 条件满足时的倍率系数（如 1.5） |
| `buffAttr` | 增益/减益属性 ID：`atk`/`def`/`int`/`spd` |
| `buffValue` | 增益/减益数值（百分比，如 25 表示 +25%） |
| `buffDuration` | 增益/减益持续回合（如 2） |

**等级生效公式**（沿用 V1.2）：

```text
发动概率(lv) = rate + (lv - 1) × rateStep
伤害倍率(lv) = mult + (lv - 1) × multStep
控制持续(lv) = duration + 满足 lv ≥ durationScaleLevels 的个数
增益持续(lv) = buffDuration + 满足 lv ≥ durationScaleLevels 的个数
```

**multStep 分档**（沿用 V1.2）：

| 档位 | 适用战法 | multStep | Lv.1→Lv.10 增量 |
|------|----------|----------|-----------------|
| 单体伤害 | targetCount=1 的 `damage` 战法 | 0.05 | +0.45 |
| 群体伤害 | targetCount≥2 的 `damage` 战法 | 0.03 | +0.27 |
| 追击类 | `extra_attack` 战法 | 0.025 | +0.225 |

---

## 四、15 个战法总览

### 4.1 保留战法（7 个）

#### 1. 力劈（lipi）— 武力单体

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 40% | 58% |
| 倍率 | 1.00 | 1.45 |
| 目标 | 1 | 1 |
| 属性 | 武力 | 武力 |
| 玉石兑换 | 20 | - |

- 替代挥砍/猛击/突刺，作为武力单体代表。
- EV：Lv.1 = 0.40，Lv.10 = 0.84。

#### 2. 疾风（jifeng）— 速度单体

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 35% | 53% |
| 倍率 | 1.10 | 1.55 |
| 目标 | 1 | 1 |
| 属性 | 速度 | 速度 |
| 玉石兑换 | 25 | - |

- 速度系单体输出。
- EV：Lv.1 = 0.385，Lv.10 = 0.82。

#### 3. 火攻（huogong）— 智力单体

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 35% | 53% |
| 倍率 | 1.20 | 1.65 |
| 目标 | 1 | 1 |
| 属性 | 智力 | 智力 |
| 玉石兑换 | 30 | - |

- 智力系单体输出。
- EV：Lv.1 = 0.42，Lv.10 = 0.87。

#### 4. 箭雨（jianyu）— 武力群体

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 25% | 43% |
| 倍率 | 0.50 | 0.77 |
| 目标 | 3 | 3 |
| 属性 | 武力 | 武力 |
| 玉石兑换 | 30 | - |

- 三目标散射，对密集守军有效。
- EV：Lv.1 = 0.375，Lv.10 = 0.99。

#### 5. 落雷（luolei）— 智力群体

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 35% | 53% |
| 倍率 | 0.55 | 0.82 |
| 目标 | 2 | 2 |
| 属性 | 智力 | 智力 |
| 玉石兑换 | 30 | - |

- 智力系双目标铺伤。
- EV：Lv.1 = 0.385，Lv.10 = 0.87。

#### 6. 连击（lianji）— 追击

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 35% | 53% |
| 追击倍率 | 1.00 | 1.225 |
| 玉石兑换 | 20 | - |

- 普攻后 35% 概率追加一次 100% 普攻伤害。
- EV：Lv.1 = 0.35，Lv.10 = 0.65。

#### 7. 谎报（huangbao）— 控制

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 30% | 48% |
| 持续回合 | 1 | 2 |
| 目标 | 1 | 1 |
| 玉石兑换 | 20 | - |

- 唯一控制战法，跳过目标下一次行动。
- durationScaleLevels=[10]（满级 +1 回合）。

---

### 4.2 新增战法（8 个）

#### 8. 青囊（qingnang）— 智力治疗（新机制）

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 30% | 48% |
| 倍率 | 1.50 | 1.95 |
| 目标 | 1（我军） | 1 |
| 属性 | 智力 | 智力 |
| 玉石兑换 | 30 | - |

- **effect: heal**：行动前 30% 概率治疗随机 1 名我军，回复量 = 智力 × 1.5 倍兵力（受 maxLevel 成长）。
- 设计参考：率土之滨「青囊秘要」、三国志战略版「刮骨疗毒」。
- 目标 `random_ally`，目标兵力未满时优先；超过上限取上限。
- 治疗不影响输出，与伤害战法 EV 不可直接比较，按"等效伤害"折算约 0.45。

#### 9. 激励（jili）— 武力增益（新机制）

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 35% | 53% |
| 增益属性 | 武力（atk） | 武力 |
| 增益数值 | +25% | +25% |
| 持续回合 | 2 | 3 |
| 玉石兑换 | 25 | - |

- **effect: buff**：行动前 35% 概率提升随机 1 名我军 25% 武力，持续 2 回合（满级 3 回合）。
- 设计参考：三国志战略版「陷阵营」「武锋阵」。
- buffDuration 持续按 lv 在 [5,10] 各 +1 回合。
- 增益以百分比叠加到 `atk` 属性后参与伤害计算。

#### 10. 铁壁（tiebi）— 统率增益（新机制）

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 35% | 53% |
| 增益属性 | 统率（def） | 统率 |
| 增益数值 | +25% | +25% |
| 持续回合 | 2 | 3 |
| 玉石兑换 | 25 | - |

- **effect: buff**：行动前 35% 概率提升随机 1 名我军 25% 统率，持续 2 回合（满级 3 回合）。
- 增益以百分比叠加到 `def` 属性后参与减伤计算。

#### 11. 破甲（pojia）— 智力减益（新机制）

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 35% | 53% |
| 减益属性 | 统率（def） | 统率 |
| 减益数值 | -25% | -25% |
| 持续回合 | 2 | 3 |
| 玉石兑换 | 25 | - |

- **effect: debuff**：行动前 35% 概率降低随机 1 名敌军 25% 统率，持续 2 回合（满级 3 回合）。
- 设计参考：率土之滨「道行险阻」、三国志战略版「夺魂挟魄」（简化版）。
- 减益后敌军 def 降低，受到的伤害提升。

#### 12. 乱谋（luanmou）— 智力减益（新机制）

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 35% | 53% |
| 减益属性 | 智力（int） | 智力 |
| 减益数值 | -25% | -25% |
| 持续回合 | 2 | 3 |
| 玉石兑换 | 25 | - |

- **effect: debuff**：行动前 35% 概率降低随机 1 名敌军 25% 智力，持续 2 回合（满级 3 回合）。
- 针对智力型敌将（火攻/落雷/青囊/破甲/乱谋），削减其输出与治疗能力。

#### 13. 嗜血（shixue）— 武力吸血（damage 变种）

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 35% | 53% |
| 倍率 | 1.00 | 1.45 |
| 吸血比例 | 30% | 30% |
| 目标 | 1 | 1 |
| 属性 | 武力 | 武力 |
| 玉石兑换 | 30 | - |

- **damage + lifesteal**：行动前 35% 概率对随机 1 名敌军造成 100% 武力伤害，并将 30% 伤害回复为自身兵力。
- 设计参考：率土之滨「饮鸩止渴」、三国志战略版「暴戾无仁」（吸血变种）。
- EV（伤害部分）：Lv.1 = 0.35，Lv.10 = 0.75。吸血价值按 30% 折算约 +0.10~0.20。

#### 14. 背水（beishui）— 速度残血爆发（damage 变种）

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 40% | 58% |
| 倍率 | 1.00 | 1.45 |
| 条件倍率 | ×1.5（兵力 < 50%） | ×1.5 |
| 目标 | 1 | 1 |
| 属性 | 速度 | 速度 |
| 玉石兑换 | 25 | - |

- **damage + condition**：行动前 40% 概率对随机 1 名敌军造成 100% 速度伤害；若自身当前兵力 < 入场兵力 50%，倍率 ×1.5（即 1.5x）。
- 设计参考：率土之滨「背水一战」、三国志战略版「所向披靡」（条件触发）。
- EV（平均）：Lv.1 ≈ 0.40 × (0.5 × 1.0 + 0.5 × 1.5) = 0.50，残血时可达 0.60。

#### 15. 鬼神（guishen）— 高倍率突击（extra_attack 变种）

| 项目 | Lv.1 | Lv.10 |
|------|------|-------|
| 发动概率 | 25% | 43% |
| 追击倍率 | 1.50 | 1.725 |
| 玉石兑换 | 30 | - |

- **extra_attack**：普通攻击后 25% 概率追加一次 150% 普攻伤害（受兵种克制影响）。
- 设计参考：率土之滨「鬼神霆威」、三国志战略版「一骑当千」（突击变种）。
- 与连击形成"高概率低倍率 vs 低概率高倍率"的取舍。
- EV：Lv.1 = 0.375，Lv.10 = 0.745。

---

## 五、15 个战法总览表

| 序号 | ID | 名称 | 类型 | 属性 | Lv.1 概率 | Lv.1 倍率 | 目标数 | 效果 | 玉石 |
|------|----|------|------|------|-----------|-----------|--------|------|------|
| 1 | `lipi` | 力劈 | 主动 | 武力 | 40% | 1.00 | 1 | 伤害 | 20 |
| 2 | `jifeng` | 疾风 | 主动 | 速度 | 35% | 1.10 | 1 | 伤害 | 25 |
| 3 | `huogong` | 火攻 | 主动 | 智力 | 35% | 1.20 | 1 | 伤害 | 30 |
| 4 | `jianyu` | 箭雨 | 主动 | 武力 | 25% | 0.50 | 3 | 伤害 | 30 |
| 5 | `luolei` | 落雷 | 主动 | 智力 | 35% | 0.55 | 2 | 伤害 | 30 |
| 6 | `lianji` | 连击 | 追击 | - | 35% | 1.00 | 1 | 追加普攻 | 20 |
| 7 | `huangbao` | 谎报 | 控制 | - | 30% | - | 1 | 跳过行动 | 20 |
| 8 | `qingnang` | 青囊 | 主动 | 智力 | 30% | 1.50 | 1（我军） | 治疗 | 30 |
| 9 | `jili` | 激励 | 主动 | 武力 | 35% | - | 1（我军） | 增益 atk | 25 |
| 10 | `tiebi` | 铁壁 | 主动 | 统率 | 35% | - | 1（我军） | 增益 def | 25 |
| 11 | `pojia` | 破甲 | 主动 | 智力 | 35% | - | 1 | 减益 def | 25 |
| 12 | `luanmou` | 乱谋 | 主动 | 智力 | 35% | - | 1 | 减益 int | 25 |
| 13 | `shixue` | 嗜血 | 主动 | 武力 | 35% | 1.00 | 1 | 伤害+吸血 | 30 |
| 14 | `beishui` | 背水 | 主动 | 速度 | 40% | 1.00 | 1 | 伤害+残血爆发 | 25 |
| 15 | `guishen` | 鬼神 | 追击 | - | 25% | 1.50 | 1 | 追加普攻 | 30 |

---

## 六、引擎扩展（battle.js）

### 6.1 新增 effect 处理

```javascript
// ② 前置主动战法
if (skill && skill.timing === 'beforeAction') {
  if (rate(skill.rate)) {
    u.skillFire++
    events.push({ type: 'skill_trigger', ... })
    if (skill.effect === 'damage')        doAttack(skill, u, events)
    else if (skill.effect === 'control')  doControl(skill, u, events)
    else if (skill.effect === 'heal')     doHeal(skill, u, events)       // 新增
    else if (skill.effect === 'buff')     doBuff(skill, u, events)       // 新增
    else if (skill.effect === 'debuff')   doDebuff(skill, u, events)     // 新增
  }
}
```

### 6.2 doHeal（治疗）

```javascript
const doHeal = (skill, u, events) => {
  const allies = alive(u.side === 'atk' ? atkUnits : defUnits)
    .filter(a => a.troops < a.start)              // 优先未满血
  if (!allies.length) return
  const count = Math.min(skill.targetCount || 1, allies.length)
  const pool = allies.slice()
  for (let n = 0; n < count; n++) {
    const target = pool.splice(Math.floor(rand() * pool.length), 1)[0]
    const attrVal = u[skill.attribute] || 0
    const heal = Math.round(u.troops * (1 + attrVal / 150) * (skill.mult || 1) * 0.3)
    const before = target.troops
    target.troops = Math.min(target.start, target.troops + heal)
    const real = target.troops - before
    events.push({ type: 'heal', side: target.side, actor: target.name, actorKey: target.key,
      skill: skill.id, skillName: skill.name, value: real, targetLeft: target.troops })
  }
}
```

> 治疗量公式与伤害对称：`troops × (1 + attr/150) × mult × 0.3`，确保不会过强。

### 6.3 doBuff / doDebuff（增益/减益）

```javascript
// 单位增加 buffs/debuffs 字段：{ atk: [{value, until}, ...] }
const doBuff = (skill, u, events) => {
  const allies = alive(u.side === 'atk' ? atkUnits : defUnits)
  if (!allies.length) return
  const count = Math.min(skill.targetCount || 1, allies.length)
  const pool = allies.slice()
  for (let n = 0; n < count; n++) {
    const target = pool.splice(Math.floor(rand() * pool.length), 1)[0]
    applyBuff(target, skill.buffAttr, skill.buffValue, skill.duration)
    events.push({ type: 'buff_add', side: target.side, actor: target.name, actorKey: target.key,
      skill: skill.id, skillName: skill.name, attr: skill.buffAttr, value: skill.buffValue,
      duration: skill.duration })
  }
}
// doDebuff 类似，目标改为 enemies，事件 type 为 'debuff_add'
```

### 6.4 属性生效（攻击/防御计算时叠加 buff/debuff）

```javascript
// 计算 u 的有效属性时：
function effAttr(u, attr) {
  const base = u[attr] || 0
  const mods = [...(u.buffs?.[attr] || []), ...(u.debuffs?.[attr] || [])]
  const modSum = mods.reduce((s, m) => s + m.value, 0)  // 百分比累加
  return Math.max(0, base * (1 + modSum / 100))
}
// doAttack 中：const attrVal = effAttr(u, skill.attribute)
//             const defVal = effAttr(target, 'def')
```

### 6.5 condition（残血爆发）

```javascript
// doAttack 中加 condition 检查：
let mult = skill.mult || 1
if (skill.condition === 'low_hp' && u.troops < u.start * 0.5) {
  mult *= (skill.conditionMult || 1.5)
  events.push({ type: 'condition_met', side: u.side, actor: u.name, actorKey: u.key,
    condition: skill.condition })
}
const atkPow = u.troops * (1 + attrVal / 150) * mult * counter * roll
```

### 6.6 lifesteal（吸血）

```javascript
// doAttack 中，伤害造成后：
if (skill.lifesteal && loss > 0) {
  const steal = Math.round(loss * skill.lifesteal)
  const before = u.troops
  u.troops = Math.min(u.start, u.troops + steal)
  const real = u.troops - before
  if (real > 0) {
    events.push({ type: 'lifesteal', side: u.side, actor: u.name, actorKey: u.key,
      value: real, targetLeft: u.troops })
  }
}
```

### 6.7 buff/debuff 回合结算

```javascript
// 每回合结束时，所有单位的 buffs/debuffs 中 until <= round 的项移除
// （用 until = round + duration 标记，而不是 countdown）
```

---

## 七、与现有系统的兼容性

| 战法效果 | 引擎支持 | 备注 |
|----------|----------|------|
| `damage`（主动/追击） | ✅ 已支持 | 直接可用 |
| `control`（跳过行动） | ✅ 已支持 | 直接可用，仅保留 huangbao 状态 |
| `extra_attack` | ✅ 已支持 | 鬼神复用，倍率 1.5x |
| **`heal`**（治疗） | 🆕 新增 | doHeal |
| **`buff`**（增益） | 🆕 新增 | doBuff + effAttr |
| **`debuff`**（减益） | 🆕 新增 | doDebuff + effAttr |
| `lifesteal`（吸血） | 🆕 字段 | doAttack 内集成 |
| `condition`（残血爆发） | 🆕 字段 | doAttack 内集成 |

**引擎改动清单**：
1. `skills.js`：删除 10 个旧战法，新增 8 个新战法；STATUSES 收缩为仅 huangbao；新增字段说明。
2. `battle.js`：新增 doHeal/doBuff/doDebuff；新增 effAttr；doAttack 集成 condition/lifesteal；新增 buff/debuff 回合结算。
3. `GameState.js`：`save()` 中 `data.v` 由 9 → 10（同步存档迁移），旧档战法 ID 删除后已拥有者保留为无效 ID（getSkill 返回 null 自动忽略），玉石不退还。

---

## 八、升级系统（沿用 V1.2）

- 最高 **Lv.10**，默认 Lv.1。
- 升级消耗 = `cost × 当前等级`。
- `skillLevels` 存储与存档迁移已实现（v8）。
- 玉石经济闭环已实现（v8）：销毁武将产出玉石 → 兑换/升级战法。

---

## 九、设计原则总结

1. **精简重复**：每组相似战法只保留 1 个代表，避免"换皮"战法。
2. **机制多样化**：新增治疗/增益/减益/吸血/残血爆发，让智力型武将有更多定位。
3. **属性均衡**：武力/智力/速度/统率四类属性均有专属战法（铁壁用统率属性）。
4. **引擎克制扩展**：仅新增 3 种 effect + 2 个字段，不新增 timing，改动可控。
5. **参考经典**：青囊/激励/破甲/嗜血/背水/鬼神均致敬率土之滨/三国志战略版经典战法。
