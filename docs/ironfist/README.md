# 铁拳 3D 角色资产投放点（方案B：Babylon.js + Mixamo）

把做好的角色文件放到本目录，命名为 **`fighter.glb`**：

```
frontend/public/games/ironfist/fighter.glb
```

构建后会从站点根 `/games/ironfist/fighter.glb` 提供。游戏启动时自动加载；
**文件不存在时自动回退到占位低多边形斗士**，不会报错，所以可以先跑通再补模型。

只需要 **一个角色 glb**：对手用同一模型，运行时旋转 180° + 红色灯光区分。

---

## 资产生产流水线（Mixamo → Blender → glb）

1. **选角色**：在 <https://www.mixamo.com> 选一个拳击/格斗角色（T-pose），`Download` →
   - Format: **FBX Binary (.fbx)**
   - Pose: **T-pose**
   - 这份带蒙皮，作为"身体"。

2. **下动作**：搜索并下载下列动作，每个 `Download` 时选
   - Format: **FBX Binary**
   - Skin: **Without Skin**（只要动画，体积小）
   - 推荐动作（找相近的即可）：
     | clip 名 | Mixamo 搜索关键词 |
     |--------|------------------|
     | idle | Fighting Idle / Boxing Idle |
     | attack | Cross Punch / Jab / Hook |
     | defend | Defensive Stance / Block |
     | charge | Standing Taunt / Flexing / Power Up |
     | hit | Hit Reaction / Head Hit |
     | dodge | Sway Back / Bobbing / Dodge |
     | ko | Knockout / Falling Back Death |

3. **Blender 合并导出**（免费，无需注册）：
   - 新建场景，导入身体 FBX；再逐个导入动作 FBX。
   - 在 **Action Editor / NLA** 里把每个动作改名为上表的 **clip 名**（小写：`idle` `attack` `defend` `charge` `hit` `dodge` `ko`）。
   - `File → Export → glTF 2.0 (.glb)`，勾选 **Include → Animations**，导出为 `fighter.glb`。

---

## glb 契约（代码按此对接）

- **动画 clip 名**（AnimationGroup，大小写不敏感）：`idle` `attack` `defend` `charge` `hit` `dodge` `ko`
  - 缺哪个就跳过哪个动作的播放，`idle` 建议必有（否则静止）。
- **朝向**：T-pose 面朝 +Z（Mixamo 默认即可），代码会自动旋转两名选手对脸。
- **尺寸/原点**：人物站立、脚底在原点附近即可；偏差不大，必要时我再在代码里微调缩放/落点。

放好文件后告诉我，我会跑一遍确认 clip 名对得上、站位/朝向正确，需要的话调相机与落点。
