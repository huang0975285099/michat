D:\project\michat\frontend\src\games\slg\game\core\MapGenerator.js


一、最大的 Bug：地块等级完全随机（★★★★★）

现在：

const level = 1 + Math.floor(rng() * TILE_MAX_LEVEL)

意味着：

1级地

6级地

10级地

完全随机

例如：

1 10 7 3 9

8 2 5 1 10

10 10 4 6 2

虽然出生点附近降级了：

1

2

2

1

但是再远一点：

9

10

8


玩家扩张会很奇怪。

为什么率土不用完全随机？

因为 SLG 要有：

主城

↓

一级地

↓

二级地

↓

三级地

↓

四级地

玩家扩张才有节奏。

否则：

一级

↓

九级

↓

三级

AI不会打。

玩家也不会打。

建议

不要按距离固定。

但是可以按概率。

例如：

外圈

70%

一级

20%

二级

10%

三级

中圈

三级

四级

五级

中心

六

七

八

九

十

这样仍然随机。

但是有成长路线。

二、NPC 城池可能压在湖上（★★★★★）

这里：

t.type='npcCity'

没有判断：

是不是湖

是不是山

是不是铜矿

例如：

原来：

湖

直接变：

NPC城

地图看起来会很奇怪。

建议：

放城池之前：

if(!TILE_TYPES[t.type].passable)
continue

否则继续找。

三、出生点附近可能有铜矿

因为：

铜矿

↓

NPC

↓

出生点

铜矿不会改

例如：

铜

铜

铜

主城

开局：

铜矿守军

体验不好。

建议：

出生点附近：

全部改成

plain

或者：

farm
四、平滑算法比较原始

现在：

九宫格

哪个最多

就变哪个

例如：

山

山

湖

下一轮：

可能：

全山

导致：

湖越来越少

尤其：

forest

hill


容易被吞。

建议：

至少：

湖

山

保持类型

或者：

只平滑：

plain

farm

forest

特殊地貌不要参与。

五、没有真正的"资源分布"

目前：

plain

farm

forest

hill


只是：

名字不同。

实际上：

都是占地。

建议：

以后：

森林

木材产量+

农田

粮食+

铜矿

铜币+


否则：

玩家不会关心：

我为什么打森林？
六、出生点只有一个

现在：

spawn

一个。

以后：

如果：

多个势力

需要：

spawn[]


提前设计。

七、guardPool 随机有一点问题

现在：

while

picked.length<2

如果：

pool

只有1个

会：

死循环

建议：

先：

if(pool.length<=teams)

直接：

slice
八、地图中心没有意义

目前：

中心

=

只是NPC多一点

建议：

中心应该：

资源最好

高级地最多

高级城最多

铜矿最多

这样：

玩家自然往中心发展。

九、地图没有"战略地形"

例如：

现在：

山

湖

只是：

不能走。

实际上：

SLG最好：

山脉

形成屏障
河流

切割地图
峡谷

形成关口

以后：

抢关隘


玩法就出来了。

十、铜矿完全随机

现在：

rng()<COPPER_TILE_RATE

所以：

可能：

连续20个铜矿

也可能：

一大片没有

建议：

泊松采样

或者：

限制：

附近2格

不能再刷铜矿

更自然。

十一、建议增加地图"区域"

目前：

地图：

100×

100

其实：

可以：

青州

冀州

幽州

并州


每州：

资源：

不同。

以后：

攻城玩法。

我给这份代码评分
项目	评分
可维护性	⭐⭐⭐⭐⭐
Seed一致性	⭐⭐⭐⭐⭐
随机算法	⭐⭐⭐⭐☆
地形生成	⭐⭐⭐☆☆
SLG体验	⭐⭐⭐☆☆
后期扩展	⭐⭐⭐⭐☆

综合：8.5/10






已查看 map.md 并对照 MapGenerator.js 逐条验证。map.md 里指出的问题基本都命中代码，下面按“已确认 bug / 额外隐患”整理，并附上具体行号。

## 一、已确认的 bug（按文档顺序）
### 1. 地块等级完全随机，破坏扩张节奏（★★★★★）
- 代码位置： MapGenerator.js:89
- 表现： const level = 1 + Math.floor(rng() * TILE_MAX_LEVEL) 均匀产出 1~10 级。
- 后果：出生点外圈几步远就可能出现 9、10 级地，玩家无法按“主城 → 1级 → 2级 → 3级”节奏扩张。
- 建议：按距中心距离设置等级概率分布（外圈高概率 1 2 级，中圈 3 5 级，内圈 6~10 级）。
### 2. NPC 城池可能压在湖/山/铜矿上（★★★★★）
- 代码位置： MapGenerator.js:123-127
- 表现：直接 t.type = 'npcCity' ，没有判断原地块类型。
- 后果：湖泊/山地直接变城池，视觉上地块被“吞掉”，且可能出现在不可通行地貌中心。
- 建议：放置前检查 TILE_TYPES[t.type].passable ，并排除 mountain 、 lake 、 copper 等特殊地貌。
### 3. 出生点附近可能有铜矿（★★★☆☆）
- 代码位置： MapGenerator.js:139-143
- 表现：出生点只要求四邻 passable && !== 'npcCity' ，铜矿 passable，因此可以贴脸刷在出生点周围。
- 后果：开局第一块地就是铜矿守军，体验不佳。
- 建议：出生点自身及八邻强制改为 plain 或 farm 。
### 4. 平滑算法会“吃掉”湖泊/山地/森林（★★★☆☆）
- 代码位置： MapGenerator.js:50-71
- 表现：两轮九宫格多数投票，湖泊、山地等稀有地貌容易被周围大片平原/森林吞掉。
- 后果：地图缺乏天然屏障，SLG 战略纵深不足。
- 建议：特殊地貌（ lake 、 mountain ）不参与平滑，或只平滑 plain/farm/forest/hill 。
### 5. guardPool 随机可能死循环（★★★★☆）
- 代码位置： MapGenerator.js:170-175
- 表现： while (picked.length < spec.teams) 且用 picked.some(p => p.id === tpl.id) 去重。
- 后果： 当前配置下不会触发 （各 pool 数量都 ≥ teams），但如果后续调整 TILE_GUARDS 或守将池，让 teams > pool.length ，就会无限循环。更危险的是 pool.length === 0 时， pool[Math.floor(rng2() * 0)] 得到 undefined ，然后 picked.some(...) 报错。
- 建议：循环前加防御：
## 二、额外代码层面的隐患
### 6. 出生点本身可能不是平原
- 代码位置： MapGenerator.js:139-143
- 表现：只检查四邻可通行，没要求出生点地块是 plain / farm 。
- 后果：主城可能落在铜矿/森林/丘陵上，与“外圈平原出生”的设计意图不符。
### 7. 出生点降级时可能把 NPC 城池降级
- 代码位置： MapGenerator.js:150-158
- 表现：降级逻辑只看 TILE_TYPES[t.type].passable ， npcCity 也是 passable。
- 后果：极小概率把出生点旁边的 NPC 城池压成 1~2 级（虽然城市通常离中心较远，但代码层面没有排除）。
- 建议：降级时跳过 npcCity 。
### 8. 地图中心没有资源/等级梯度
- 代码位置： MapGenerator.js:89
- 表现：等级纯随机，与到中心距离无关。
- 后果：中心没有“高风险高回报”的吸引力，玩家缺乏往中间推进的动力。
- 建议：等级分布与距中心距离正相关，并在中心区域提高铜矿密度。
### 9. 铜矿完全随机，可能成片或大片空白
- 代码位置： MapGenerator.js:76-80
- 表现： rng() < COPPER_TILE_RATE 独立同分布，没有最小间距。
- 后果：运气好连续刷多个铜矿，运气不好整张图没几个。
- 建议：使用泊松采样或限制“2 格内不再生成铜矿”。
### 10. 城池放置可能失败导致城市数量不足
- 代码位置： MapGenerator.js:115-128
- 表现： while (cities.length < cityLevels.length && guard++ < 3000) ，如果 3000 次尝试仍未放满，循环直接结束。
- 后果： npcCities 数组少于 15 座， _checkVictory 会提前判定“天下一统”，胜利条件变简单。
- 建议：放满后增加断言/警告，或在失败后放宽间距重试。
### 11. TILE_TYPES 资源差异其实已存在，但不够明显
- 代码位置： GameConstants.js:27-38
- 说明：map.md 说“只是名字不同”，但代码里 forest→wood 、 hill→stone 、 mountain→iron 、 copper→coin 已有区分。真正的问题是高级地与低级地产出倍率都是 level * BASE_YIELD_PER_LEVEL ，导致玩家不太在意地块类型。
- 建议：给不同地貌加独立产量系数，或给铜矿/森林设置特殊战略价值。
## 三、总结
优先级 问题 关键代码 urgent 地块等级完全随机 MapGenerator.js:89 urgent NPC城池可压特殊地貌 MapGenerator.js:123-127 high 出生点可能是铜矿/森林 MapGenerator.js:139-143 high guardPool 死循环隐患 MapGenerator.js:170-175 medium 平滑算法吞特殊地貌 MapGenerator.js:50-71 medium 地图中心无梯度 MapGenerator.js:89 medium 铜矿随机聚集 MapGenerator.js:76-80

最优先修复的是 1、2、5 ：它们会直接影响 SLG 核心体验或导致程序异常。