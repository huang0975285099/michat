package service

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
)

// ── 常量（从 GameConstants.js 移植）────────────────────────────────────────────

const (
	slgMapW = 48
	slgMapH = 48

	copperTileRate    = 0.04
	cityBeltRatio     = 0.25
	formationSize     = 3
	aiLairLevel       = 6
	aiTickRealSeconds = 60 // 1 真实分钟 = 3600 游戏秒（TIME_SCALE=60）

	aiAggressionCityLv    = 4
	playerTileDefenseMult = 1.6
	aiSuccessMin          = 0.15
	aiSuccessMax          = 0.85

	aiLairMinDistFromSpawn = 10
	aiLairMinDistFromCity  = 4
	aiLairMinDistBetween   = 8

	maxPlayersPerWorld = 5
)

// tileTypeInfo 地块类型信息
type tileTypeInfo struct{ passable bool }

var slgTileTypes = map[string]tileTypeInfo{
	"plain": {true}, "farm": {true}, "forest": {true}, "hill": {true},
	"mountain": {true}, "copper": {true}, "lake": {false}, "npcCity": {true},
}

// tileGuardSpec 地块守军规格
type tileGuardSpec struct{ teams, troops int }

var slgTileGuards = map[int]tileGuardSpec{
	1: {1, 100}, 2: {1, 200}, 3: {1, 400}, 4: {1, 800}, 5: {2, 1000},
	6: {2, 2000}, 7: {2, 3000}, 8: {2, 4000}, 9: {3, 4000}, 10: {3, 5000},
}

var slgNpcCityLevels = map[int]int{1: 30000, 2: 54000, 3: 84000, 4: 120000, 5: 150000}
var slgNpcCityLevelCounts = map[int]int{1: 5, 2: 4, 3: 3, 4: 2, 5: 1}

type aiFactionInfo struct{ id, name string }

var slgAiFactions = []aiFactionInfo{
	{"ai1", "黄巾余部"},
	{"ai2", "黑山贼"},
}

// ── mulberry32 PRNG（从 MapGenerator.js 移植，位级等价）──────────────────────────

type slgRNG struct{ a uint32 }

func newSlgRNG(seed int) *slgRNG { return &slgRNG{a: uint32(seed)} }

func (r *slgRNG) next() float64 {
	r.a += 0x6D2B79F5
	t := (r.a ^ (r.a >> 15)) * (1 | r.a)
	t = (t + (t^(t>>7))*(61|t)) ^ t
	return float64(t^(t>>14)) / 4294967296.0
}

func key2d(x, y int) string { return fmt.Sprintf("%d,%d", x, y) }

// ── 地图地形（从 MapGenerator.js 步骤 1~5, 7 移植）──────────────────────────────

type slgTile struct {
	x, y, level int
	typ         string
}

// SlgMap 服务端地图缓存（从种子确定性生成，用于 AI 扩张判定）
type SlgMap struct {
	tiles   [][]slgTile
	aiLairs []struct{ x, y int }
	cities  []struct{ x, y int }
	spawn   struct{ x, y int } // 默认出生点（用于 AI 老巢距离约束）
}

// NewSlgMap 从种子生成地图（与前端 MapGenerator.generateMap 位级等价）
func NewSlgMap(seed int) *SlgMap {
	rng := newSlgRNG(seed)
	cx, cy := float64(slgMapW)/2, float64(slgMapH)/2
	maxDist := math.Hypot(cx, cy)

	// 步骤 1: 随机初始类型（加权）
	type wt struct {
		typ string
		w   int
	}
	weighted := []wt{{"plain", 30}, {"farm", 14}, {"forest", 20}, {"hill", 14}, {"mountain", 12}, {"lake", 10}}
	totalW := 0
	for _, w := range weighted {
		totalW += w.w
	}
	pickType := func() string {
		r := rng.next() * float64(totalW)
		for _, w := range weighted {
			r -= float64(w.w)
			if r < 0 {
				return w.typ
			}
		}
		return "plain"
	}

	grid := make([][]string, slgMapH)
	for y := range grid {
		grid[y] = make([]string, slgMapW)
		for x := 0; x < slgMapW; x++ {
			grid[y][x] = pickType()
		}
	}

	// 步骤 2: 两轮多数平滑（lake/mountain 保留）
	preserve := map[string]bool{"lake": true, "mountain": true}
	for pass := 0; pass < 2; pass++ {
		next := make([][]string, slgMapH)
		for y := range next {
			next[y] = make([]string, slgMapW)
			copy(next[y], grid[y])
		}
		for y := 0; y < slgMapH; y++ {
			for x := 0; x < slgMapW; x++ {
				cur := grid[y][x]
				if preserve[cur] {
					continue
				}
				count := map[string]int{}
				for dy := -1; dy <= 1; dy++ {
					for dx := -1; dx <= 1; dx++ {
						nx, ny := x+dx, y+dy
						if nx < 0 || ny < 0 || nx >= slgMapW || ny >= slgMapH {
							continue
						}
						count[grid[ny][nx]]++
					}
				}
				best, bestN := cur, 0
				for t, n := range count {
					if n > bestN {
						best, bestN = t, n
					}
				}
				next[y][x] = best
			}
		}
		grid = next
	}

	// 步骤 2.5: 铜矿地散点
	copperPlaced := make([][]bool, slgMapH)
	for i := range copperPlaced {
		copperPlaced[i] = make([]bool, slgMapW)
	}
	for y := 0; y < slgMapH; y++ {
		for x := 0; x < slgMapW; x++ {
			if grid[y][x] == "lake" {
				continue
			}
			tooClose := false
			for dy := -2; dy <= 2 && !tooClose; dy++ {
				for dx := -2; dx <= 2 && !tooClose; dx++ {
					ny, nx := y+dy, x+dx
					if ny < 0 || nx < 0 || ny >= slgMapH || nx >= slgMapW {
						continue
					}
					if copperPlaced[ny][nx] {
						tooClose = true
					}
				}
			}
			if tooClose {
				continue
			}
			if rng.next() < copperTileRate {
				grid[y][x] = "copper"
				copperPlaced[y][x] = true
			}
		}
	}

	// 步骤 3: 等级（按到中心距离分带）
	tiles := make([][]slgTile, slgMapH)
	for y := range tiles {
		tiles[y] = make([]slgTile, slgMapW)
		for x := 0; x < slgMapW; x++ {
			typ := grid[y][x]
			dist := math.Hypot(float64(x)-cx, float64(y)-cy)
			rawRatio := dist / maxDist
			landRatio := math.Max(0, math.Min(1, (rawRatio-cityBeltRatio)/(1-cityBeltRatio)))
			tiles[y][x] = slgTile{x: x, y: y, typ: typ, level: pickLevelByDist(rng, landRatio)}
		}
	}

	// 步骤 4: NPC 城池
	var cityLevels []int
	for lv, count := range slgNpcCityLevelCounts {
		for i := 0; i < count; i++ {
			cityLevels = append(cityLevels, lv)
		}
	}
	sort.Ints(cityLevels)

	type cityCand struct {
		x, y int
		dist float64
	}
	var cityCandidates []cityCand
	guard := 0
	for len(cityCandidates) < len(cityLevels) && guard < 6000 {
		guard++
		ang := rng.next() * math.Pi * 2
		r := math.Sqrt(rng.next()) * cityBeltRatio * maxDist
		x := int(math.Round(cx + math.Cos(ang)*r))
		y := int(math.Round(cy + math.Sin(ang)*r))
		if x < 1 || y < 1 || x >= slgMapW-1 || y >= slgMapH-1 {
			continue
		}
		tooClose := false
		for _, c := range cityCandidates {
			if math.Hypot(float64(c.x-x), float64(c.y-y)) < 2.5 {
				tooClose = true
				break
			}
		}
		if tooClose {
			continue
		}
		t := tiles[y][x]
		if !slgTileTypes[t.typ].passable || t.typ == "mountain" || t.typ == "lake" || t.typ == "copper" {
			continue
		}
		cityCandidates = append(cityCandidates, cityCand{x, y, math.Hypot(float64(x)-cx, float64(y)-cy)})
	}
	sort.Slice(cityCandidates, func(i, j int) bool { return cityCandidates[i].dist > cityCandidates[j].dist })

	var cities []struct{ x, y int }
	for i, c := range cityCandidates {
		if i >= len(cityLevels) {
			break
		}
		tiles[c.y][c.x].typ = "npcCity"
		tiles[c.y][c.x].level = cityLevels[i]
		cities = append(cities, struct{ x, y int }{c.x, c.y})
	}

	// 步骤 5: 默认出生点（外圈 70%~90% 半径的可通行地块，四邻可通行）
	spawn := struct{ x, y int }{4, 4} // 兜底
	guard = 0
	found := false
	for !found && guard < 1000 {
		guard++
		ang := rng.next() * math.Pi * 2
		r := (0.7 + rng.next()*0.2) * maxDist
		x := int(math.Round(cx + math.Cos(ang)*r))
		y := int(math.Round(cy + math.Sin(ang)*r))
		if x < 2 || y < 2 || x >= slgMapW-2 || y >= slgMapH-2 {
			continue
		}
		ok := true
		for _, d := range [][2]int{{0, 0}, {1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
			t := tiles[y+d[1]][x+d[0]]
			if !slgTileTypes[t.typ].passable || t.typ == "npcCity" {
				ok = false
				break
			}
		}
		if ok {
			spawn = struct{ x, y int }{x, y}
			found = true
		}
	}

	// 步骤 7: AI 势力老巢（用独立 rng3，与步骤 1~6 完全无关）
	rng3 := newSlgRNG(seed ^ 0x12345678)
	var aiLairs []struct{ x, y int }
	for range slgAiFactions {
		placed := false
		for g3 := 0; g3 < 3000 && !placed; g3++ {
			x := int(rng3.next() * float64(slgMapW))
			y := int(rng3.next() * float64(slgMapH))
			if x < 0 || x >= slgMapW || y < 0 || y >= slgMapH {
				continue
			}
			t := tiles[y][x]
			if !slgTileTypes[t.typ].passable {
				continue
			}
			if t.typ == "npcCity" || t.typ == "lake" || t.typ == "mountain" || t.typ == "copper" {
				continue
			}
			if math.Hypot(float64(x-spawn.x), float64(y-spawn.y)) < aiLairMinDistFromSpawn {
				continue
			}
			tooClose := false
			for _, c := range cities {
				if math.Hypot(float64(c.x-x), float64(c.y-y)) < aiLairMinDistFromCity {
					tooClose = true
					break
				}
			}
			if tooClose {
				continue
			}
			for _, l := range aiLairs {
				if math.Hypot(float64(l.x-x), float64(l.y-y)) < aiLairMinDistBetween {
					tooClose = true
					break
				}
			}
			if tooClose {
				continue
			}
			aiLairs = append(aiLairs, struct{ x, y int }{x, y})
			placed = true
		}
		if !placed {
		outer:
			for y := 0; y < slgMapH; y++ {
				for x := 0; x < slgMapW; x++ {
					t := tiles[y][x]
					if !slgTileTypes[t.typ].passable {
						continue
					}
					if t.typ == "npcCity" || t.typ == "mountain" || t.typ == "copper" {
						continue
					}
					if x == spawn.x && y == spawn.y {
						continue
					}
					dup := false
					for _, l := range aiLairs {
						if l.x == x && l.y == y {
							dup = true
							break
						}
					}
					if dup {
						continue
					}
					aiLairs = append(aiLairs, struct{ x, y int }{x, y})
					break outer
				}
			}
		}
	}

	m := &SlgMap{tiles: tiles, aiLairs: aiLairs, cities: cities}
	m.spawn = spawn
	return m
}

// pickLevelByDist 按距中心距离比随机选等级（从 MapGenerator.js 移植）
func pickLevelByDist(rng *slgRNG, ratio float64) int {
	wp := func(items [][2]int) int {
		total := 0
		for _, it := range items {
			total += it[1]
		}
		r := rng.next() * float64(total)
		for _, it := range items {
			r -= float64(it[1])
			if r < 0 {
				return it[0]
			}
		}
		return items[len(items)-1][0]
	}
	if ratio > 0.75 {
		return wp([][2]int{{1, 10}, {2, 30}, {3, 35}, {4, 20}, {5, 5}})
	}
	if ratio > 0.60 {
		return wp([][2]int{{2, 10}, {3, 30}, {4, 35}, {5, 20}, {6, 5}})
	}
	if ratio > 0.45 {
		return wp([][2]int{{3, 10}, {4, 25}, {5, 40}, {6, 20}, {7, 5}})
	}
	if ratio > 0.30 {
		return wp([][2]int{{4, 10}, {5, 30}, {6, 40}, {7, 15}, {8, 5}})
	}
	if ratio > 0.15 {
		return wp([][2]int{{5, 9}, {6, 28}, {7, 36}, {8, 17}, {9, 10}})
	}
	return wp([][2]int{{6, 7}, {7, 20}, {8, 30}, {9, 25}, {10, 18}})
}

// slgGarrisonOf 计算地块守军总兵力（从 GameConstants.js 移植）
func slgGarrisonOf(level int, typ string) int {
	if typ == "npcCity" {
		if g, ok := slgNpcCityLevels[level]; ok {
			return g
		}
		return slgNpcCityLevels[5]
	}
	spec, ok := slgTileGuards[level]
	if !ok {
		return 0
	}
	return spec.teams * formationSize * spec.troops
}

// ── AI 扩张逻辑（从 GameState.js _aiExpandStep 移植）─────────────────────────────

// AITerritoryEvent AI 扩张事件（用于 WS 广播）
type AITerritoryEvent struct {
	FactionID string `json:"faction_id"`
	X         int    `json:"x"`
	Y         int    `json:"y"`
	Level     int    `json:"level"`
	TileType  string `json:"tile_type"`
	Action    string `json:"action"` // "claim"
}

// RunAIExpansionForFaction 执行单个 AI 势力的一次扩张判定
// ownerMap: "x,y" → ownerChatID（包含玩家和 AI 的领地，无主地块不在 map 中）
// isCityMap: "x,y" → bool（是否为主城）
// rng: 随机源
// 返回: 扩张事件（nil = 本次未扩张）
func (m *SlgMap) RunAIExpansionForFaction(
	faction aiFactionInfo,
	lairX, lairY int,
	ownerMap map[string]string,
	isCityMap map[string]bool,
	rng *rand.Rand,
) *AITerritoryEvent {
	// 检查老巢是否还在
	lairKey := key2d(lairX, lairY)
	if owner, ok := ownerMap[lairKey]; !ok || owner != faction.id {
		return nil
	}

	// 收集 AI 拥有的所有地块 & 计算总战力
	type ownedTile struct {
		x, y, level int
		typ         string
	}
	var owned []ownedTile
	aiPower := 0
	for y := 0; y < slgMapH; y++ {
		for x := 0; x < slgMapW; x++ {
			k := key2d(x, y)
			if owner, ok := ownerMap[k]; ok && owner == faction.id {
				t := m.tiles[y][x]
				lvl := t.level
				if x == lairX && y == lairY {
					lvl = aiLairLevel
				}
				owned = append(owned, ownedTile{x, y, lvl, t.typ})
				aiPower += slgGarrisonOf(lvl, t.typ)
			}
		}
	}
	if aiPower <= 0 || len(owned) == 0 {
		return nil
	}

	// 收集边境候选（八邻去重）
	// 规则（与前端 _aiExpandStep 一致）：
	// - 跳过不可通行地块
	// - 跳过己方地块
	// - 跳过其他 AI 势力地块
	// - 跳过所有玩家地块（服务端不知道玩家主城等级，保守不攻击玩家领地）
	// - 只扩张到无主地块
	seen := map[string]bool{}
	type candidate struct {
		x, y, level int
		typ         string
	}
	var candidates []candidate
	for _, t := range owned {
		for dy := -1; dy <= 1; dy++ {
			for dx := -1; dx <= 1; dx++ {
				if dx == 0 && dy == 0 {
					continue
				}
				nx, ny := t.x+dx, t.y+dy
				if nx < 0 || ny < 0 || nx >= slgMapW || ny >= slgMapH {
					continue
				}
				nt := m.tiles[ny][nx]
				if !slgTileTypes[nt.typ].passable {
					continue
				}
				k := key2d(nx, ny)
				if seen[k] {
					continue
				}
				owner := ownerMap[k] // "" if not in map
				if owner != "" {
					// 有主地块：跳过（己方、其他 AI、玩家都不打）
					continue
				}
				seen[k] = true
				candidates = append(candidates, candidate{nx, ny, nt.level, nt.typ})
			}
		}
	}
	if len(candidates) == 0 {
		return nil
	}

	// 加权随机选目标（等级越低权重越高）
	weights := make([]float64, len(candidates))
	totalW := 0.0
	for i, c := range candidates {
		w := 1.0 / math.Max(1, float64(c.level))
		weights[i] = w
		totalW += w
	}
	r := rng.Float64() * totalW
	target := candidates[len(candidates)-1]
	for i, c := range candidates {
		r -= weights[i]
		if r < 0 {
			target = c
			break
		}
	}

	// 胜率判定
	def := slgGarrisonOf(target.level, target.typ)
	chance := math.Min(aiSuccessMax, math.Max(aiSuccessMin, float64(aiPower)/float64(aiPower+def)))
	if rng.Float64() >= chance {
		return nil
	}

	return &AITerritoryEvent{
		FactionID: faction.id,
		X:         target.x,
		Y:         target.y,
		Level:     target.level,
		TileType:  target.typ,
		Action:    "claim",
	}
}
