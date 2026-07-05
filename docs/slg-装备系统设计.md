# SLG 装备系统设计

> 配套文档：`slg-战法升级与扩展设计.md`（玉石经济）、`slg-战斗和战报.md`（战斗公式）
>
> 设计目标：在不破坏现有战法/玉石经济闭环的前提下，引入装备维度让武将 build 多样化。
> 装备走「铜币经济」（区别于战法的玉石经济），两条经济线相互独立、互不干扰。

---

## 一、装备类型与属性

### 6 种装备槽位

每名武将最多同时装备 6 件，每种类型 1 件。

| 类型 ID | 名称 | 图标 | 槽位 |
|---|---|---|---|
| `weapon`   | 武器 | ⚔️ | 1 |
| `helmet`   | 头盔 | 🪖 | 1 |
| `necklace` | 项链 | 📿 | 1 |
| `armor`    | 铠甲 | 🛡️ | 1 |
| `belt`     | 腰带 | 🟫 | 1 |
| `boots`    | 靴子 | 🥾 | 1 |

### 主属性随机

**关键设计**：同一类型装备的不同个体可能加不同主属性（参考用户示例：「武器1，普通，+5智力」「武器2，普通，+5速度」「武器3，精良，+10武力」）。

| 属性 ID | 名称 | 说明 |
|---|---|---|
| `atk` | 武力 | 影响普攻/武力战法伤害 |
| `def` | 统率 | 影响防御值 |
| `int` | 智力 | 影响智力战法伤害 |
| `spd` | 速度 | 影响出手顺序与速度战法伤害 |

**抽取时**：类型（1/6 等概率）× 主属性（1/4 等概率）= 24 种组合。

---

## 二、品质与数值

| 品质 ID | 名称 | 颜色 | 主属性（Lv.1） | 每级增量 | Lv.10 主属性 | 抽取概率 |
|---|---|---|---|---|---|---|
| `common` | 普通 | #bdbdbd | +5  | +1 | +14  | 50% |
| `rare`   | 精良 | #4fc3f7 | +10 | +2 | +28  | 30% |
| `elite`  | 精锐 | #ba68c8 | +18 | +3 | +45  | 15% |
| `legend` | 王牌 | #ffb300 | +30 | +5 | +75  | 5%  |

> 概率与武将招募完全一致（`GENERAL_QUALITY.rate`），玩家心智模型可复用。
>
> Lv.10 数值核算：`主属性 + 9 × 增量`。王牌满级 +75 单属性，对基础 80~100 的武将约 +75%~+94%，强力但非碾压。

---

## 三、抽装备机制

### 入口
- 武将面板的「招募」按钮旁加「装备抽奖」按钮（复用武将招募流程的心智模型）
- 单次消耗：**2000 铜币**
- 无免费次数（与武将招募的开局免费 1 次不同）

### 抽取流程

```
1. 扣 2000 铜币
2. 掷品质：common 50% / rare 30% / elite 15% / legend 5%（同武将招募）
3. 掷类型：6 种等概率（1/6）
4. 掷主属性：4 种等概率（1/4）
5. 生成装备实例 iid、Lv.1、入仓库
6. 推送日志：「✨ 抽得 精良武器·智（+10 智力）」
```

### 命名规则
`品质前缀 + 类型名 + · + 属性缩写`

例：
- 普通 + 武器 + int → 「普通武器·智」
- 精良 + 头盔 + def → 「精良头盔·防」
- 王牌 + 靴子 + spd → 「王牌靴子·速」

---

## 四、装备绑定规则

### 仓库与绑定
- `state.equipments`：装备仓库（所有未销毁的装备实例数组）
- `g.equip`：武将身上的装备槽 `{ weapon: iid|null, helmet: iid|null, ... }`，6 个槽各存一个 iid
- **同一装备实例只能被 1 个武将绑定**（与战法绑定规则一致）
- 武将每种类型只能装 1 件（即同一武将不能装 2 件武器）

### 绑定/解绑
- 在武将面板点击武将 → 进入「装备管理」子面板
- 6 个槽位显示当前装备 / 空槽
- 点击槽位 → 弹出仓库内可用装备列表（同类型 + 未绑定）→ 选择即绑定
- 已绑定装备点击 → 弹出「卸下」按钮
- 装备卸下/换装自动回收原装备到仓库

---

## 五、装备升级（铁匠坊「打造」入口）

### 入口
- 建筑管理面板的「铁匠坊」一行加「打造」按钮（与「升级」按钮并列）
- 点击进入装备升级面板：列出仓库全部装备 + 当前等级 + 升级消耗 + 「升级」按钮

### 升级公式

```
升级消耗（铜币） = 品质基础 × 当前等级
```

| 品质 | 品质基础 | Lv.1→2 | Lv.5→6 | Lv.9→10 | 满级总耗（Lv.1→10） |
|---|---|---|---|---|---|
| 普通  | 200   | 200    | 1000   | 1800   | 9,000     |
| 精良  | 500   | 500    | 2500   | 4500   | 22,500    |
| 精锐  | 1200  | 1200   | 6000   | 10800  | 54,000    |
| 王牌  | 3000  | 3000   | 15000  | 27000  | 135,000   |

### 升级规则
- 单次升级 +1 级，不可跳级
- 满 10 级后「升级」按钮置灰显示「满级」
- 升级消耗铜币不足时按钮置灰，显示「铜币不足」
- 升级后属性立即生效，无需重新装备

### 资源平衡核算
- 铜矿地 Lv.5 产出 = 5 × 120 = 600 铜币/小时
- 主城 Lv.5 领地上限 28 块，假设 5 块铜矿 = 3000 铜币/小时
- 满级一件王牌装备 ≈ 135000 铜币 ≈ 45 游戏小时挂机产出
- 满级一件普通装备 ≈ 9000 铜币 ≈ 3 游戏小时挂机产出

---

## 六、数据结构

### 装备实例

```js
{
  iid: 'eq_1',              // 装备实例 ID（递增，全局唯一）
  type: 'weapon',           // 类型 ID
  quality: 'rare',          // 品质 ID
  attr: 'int',              // 主属性 ID
  level: 1,                 // 当前等级 1~10
  boundTo: null,            // 绑定的武将 ID（null = 仓库中未绑定）
}
```

### 武将装备槽

```js
// 在 makeGeneral 中扩展
{
  ...,
  equip: {
    weapon:   null,    // iid 或 null
    helmet:   null,
    necklace: null,
    armor:    null,
    belt:     null,
    boots:    null,
  },
}
```

### GameState 新增字段

```js
this.equipments = []        // 装备仓库（所有装备实例数组）
this._equipSeq = 0          // iid 自增序号
```

### 存档迁移 v8 → v9

```js
// save()
const v = 9
return { v, ..., equipments: this.equipments, _equipSeq: this._equipSeq }

// load()
if (data.v < 9) {
  // 旧档补默认值
  gs.equipments = []
  gs._equipSeq = 0
  // 已有武将补空装备槽
  gs.generals.forEach(g => { g.equip = emptyEquipSlots() })
}
```

---

## 七、属性叠加（战斗结算）

### 装备属性如何生效

`GameState.js` 的 `effAtk/effDef/effInt/effSpd` 函数（L563-566）当前公式：

```js
const effAtk = g => g.atk + (g.lv - 1) * LEVELUP_ATK * growthOf(g.quality) + forgeBonus
```

新增装备加成：

```js
const equipBonus = (g, attr) => {
  let sum = 0
  for (const type of EQUIP_TYPES) {
    const iid = g.equip?.[type]
    if (!iid) continue
    const eq = this.equipments.find(e => e.iid === iid)
    if (eq && eq.attr === attr) sum += equipValue(eq)   // equipValue = 主属性 + (lv-1) × 增量
  }
  return sum
}

const effAtk = g => g.atk + (g.lv - 1) * LEVELUP_ATK * growthOf(g.quality) + forgeBonus + equipBonus(g, 'atk')
```

### 装备数值函数

```js
const EQUIP_QUALITY = {
  common: { name: '普通', value: 5,  step: 1, costBase: 200  },
  rare:   { name: '精良', value: 10, step: 2, costBase: 500  },
  elite:  { name: '精锐', value: 18, step: 3, costBase: 1200 },
  legend: { name: '王牌', value: 30, step: 5, costBase: 3000 },
}

function equipValue(eq) {
  const q = EQUIP_QUALITY[eq.quality]
  return q.value + (eq.level - 1) * q.step
}

function equipUpgradeCost(eq) {
  const q = EQUIP_QUALITY[eq.quality]
  return q.costBase * eq.level     // 当前等级 × 品质基础
}
```

---

## 八、UI 入口

### 1. 武将面板「装备抽奖」按钮
- 在武将面板右上角「🎲 招募」按钮旁加「✨ 抽装备」按钮
- 点击 → 扣 2000 铜币 → 掷装备 → toast 提示「抽得 XXX」→ 重新打开面板刷新

### 2. 武将面板「装备管理」子面板
- 点击武将行 → 进入武将详情，加「装备」按钮
- 装备管理面板：6 个槽位卡片，显示当前装备或「空槽」
- 点击槽位 → 弹出仓库内同类型未绑定装备列表 → 选择即绑定
- 点击已装装备 → 显示「卸下」按钮

### 3. 建筑管理面板「铁匠坊·打造」入口
- 铁匠坊一行加「🔨 打造」按钮（与「升级」并列）
- 点击 → 装备升级面板：滚动列表显示仓库全部装备
  - 每行：装备名 + Lv.N/10 + 当前属性 + 升级消耗 + 「升级」按钮
  - 满级置灰「满级」；铜币不足置灰

---

## 九、与现有系统的关系

| 系统 | 关系 |
|---|---|
| 武将招募 | 共用铜币经济，但装备无免费次数 |
| 战法系统 | 完全独立（玉石 vs 铜币） |
| 铁匠坊 | 原「+全属性」保留，新增「打造」入口升级装备 |
| 战斗结算 | effAtk/effDef/effInt/effSpd 叠加装备加成 |
| 存档迁移 | v8 → v9，新增 equipments + 武将 equip 槽 |
| NPC 城池掉落 | 本期不实现（仅抽装备获取），后续可扩展 |

---

## 十、引擎改动清单

| 文件 | 改动 |
|---|---|
| `GameConstants.js` | 新增 `EQUIP_TYPES`、`EQUIP_QUALITY`、`EQUIP_MAX_LEVEL`、`EQUIP_DRAW_COST` 常量 |
| `core/equipment.js`（新） | 装备数据 + `equipValue`/`equipUpgradeCost`/`rollEquipment` 函数 |
| `core/GameState.js` | 加 `equipments`/`_equipSeq`；加 `drawEquipment`/`upgradeEquipment`/`bindEquip`/`unbindEquip` 方法；扩展 `effAtk/effDef/effInt/effSpd` 叠加装备加成；存档 v8→v9 |
| `scenes/UIScene.js` | 武将面板加「抽装备」按钮；新增 `_openEquipDraw`（抽装备结果面板）、`_openEquipManage`（武将装备槽管理）、`_openEquipUpgrade`（铁匠坊打造面板）三个方法 |
| `core/battle.js` | 不需改（属性已在 GameState 层叠加） |

---

## 十一、预期玩法效果

### Build 流派示例

1. **高武力输出流**：传说武器·武 + 传说腰带·武 + 战法「猛击」→ atk 极高，单点爆发
2. **高智力谋士流**：传说头盔·智 + 传说项链·智 + 战法「火攻」→ int 极高，群体焚烧
3. **高速度突袭流**：传说靴子·速 + 传说武器·速 + 战法「突袭」→ spd 极高，先手 + 双目标
4. **坦克流**：传说铠甲·防 + 传说头盔·防 → def 极高，吸引火力

### 资源经济循环

```
铜矿地产出铜币
   ↓
抽装备（2000/次）/ 升级装备（品质 × 等级）
   ↓
武将战力提升
   ↓
推更高等级地块 → 更多铜币
   ↓
抽更高级装备 → 武将更强
```

与玉石经济（遣散武将→战法）形成双循环，互不干扰。
