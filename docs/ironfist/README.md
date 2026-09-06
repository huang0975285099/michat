# 铁拳 3D 角色资产制作说明（Babylon.js + Mixamo）

游戏目前使用两个独立角色模型：

```text
frontend/public/games/ironfist/fighter.glb   # 左侧角色（龙）
frontend/public/games/ironfist/fighter2.glb  # 右侧角色（虎）
```

构建后分别通过 `/games/ironfist/fighter.glb` 和
`/games/ironfist/fighter2.glb` 提供。游戏启动时自动加载；第二个模型加载失败时会回退到
`fighter.glb`，两个模型都无法加载时则使用程序生成的低多边形占位角色。

角色与动作主要从 [Adobe Mixamo](https://www.mixamo.com/) 获取。Mixamo 可免费用于项目，
但不是 CC0 或开源素材库；使用前应确认 Adobe 当前的授权条款，模型文件不可作为独立素材重新分发。

---

## 资产生产流水线（Mixamo → Blender → GLB）

### 1. 下载角色身体

在 Mixamo 选择一个拳击或格斗角色，下载角色的 T-pose：

- Format：**FBX Binary (.fbx)**
- Pose：**T-pose**
- Skin：**With Skin**
- Frames per Second：**30**
- Keyframe Reduction：**None**

这份文件包含角色网格、材质、骨骼和蒙皮，作为角色主体。制作第二个角色时，应重新选择一个
外形不同的角色，但最好继续使用 Mixamo 标准骨骼，以便复用现有动作。

### 2. 下载动作

在 Mixamo 搜索并下载以下动作。除角色主体外，动作文件统一选择：

- Format：**FBX Binary**
- Skin：**Without Skin**
- Frames per Second：**30**
- Keyframe Reduction：**None**

| 游戏 clip 名 | Mixamo 搜索关键词 | 当前项目参考文件 |
|---|---|---|
| `idle` | Fighting Idle / Boxing Idle | `Fighting Idle.fbx` |
| `attack` | Cross Punch / Jab / Hook | `Cross Punch.fbx` |
| `defend` | Defensive Stance / Block | `Standing Block Idle.fbx` |
| `charge` | Standing Taunt / Flexing / Power Up | `Sword And Shield Power Up.fbx` |
| `hit` | Hit Reaction / Head Hit | `Head Hit.fbx` |
| `dodge` | Sway Back / Bobbing / Dodge | `Dodging.fbx` |
| `ko` | Knockout / Falling Back Death | `Falling Back Death.fbx` |

当前参考 FBX 文件位于 `docs/games/`。

### 3. 在 Blender 中合并

1. 新建 Blender 场景并删除默认物体。
2. 导入带蒙皮的角色主体 FBX。
3. 依次导入七个不带蒙皮的动作 FBX。
4. 将动作重定向到角色主体的 Armature。
5. 在 **Dope Sheet → Action Editor** 中，把动作严格重命名为：
   `idle`、`attack`、`defend`、`charge`、`hit`、`dodge`、`ko`。
6. 把需要导出的动作放入 NLA，避免 Blender 清理未引用的 Action。
7. 删除动作 FBX 带入的多余 Armature，只保留角色主体、主体骨骼和七个动作。

### 4. 导出 GLB

选择 `File → Export → glTF 2.0`：

- Format：**glTF Binary (.glb)**
- Include：只导出角色网格和主体 Armature
- Transform：应用当前变换
- Animation：开启 **Animations**、**NLA Strips** 和 **All Actions**
- Shape Keys：没有使用时可关闭

第一个角色导出为 `fighter.glb`，第二个角色导出为 `fighter2.glb`。

### 5. 使用项目脚本自动合并

项目已经提供 Blender 5.1 自动构建脚本，可直接把一个带蒙皮的 Mixamo 角色与
`docs/games/` 中的七个动作合并：

```powershell
& 'D:\Program Files\Blender Foundation\Blender 5.1\blender.exe' `
  --background --factory-startup `
  --python 'D:\project\michat\scripts\build_ironfist_fighter.py' -- `
  'C:\Users\Administrator\Downloads\Maria WProp J J Ong.fbx' `
  'D:\project\michat\frontend\public\games\ironfist\fighter2.glb'
```

脚本会自动完成以下工作：

- 保留角色主体的网格、材质、骨骼与蒙皮。
- 去除动作 FBX 中重复导入的网格和骨骼。
- 将动作统一命名为游戏要求的七个 clip。
- 使用 Blender 5.1 的 NLA Tracks 模式导出，避免遗漏 `idle`。
- 输出包含材质和全部动画的单文件 GLB。

---

## GLB 接口契约

- 动画组名称必须是：`idle`、`attack`、`defend`、`charge`、`hit`、`dodge`、`ko`。
- 名称大小写不敏感，但建议全部使用小写。
- `idle` 必须可循环；其他动作应为单次播放。
- 角色正面朝向 **+Z**，代码会自动旋转两名角色使其面对彼此。
- 角色脚底应位于原点附近，应用缩放后导出，避免两名角色大小差异过大。
- 网格必须绑定到唯一的主 Armature，避免导出重复骨骼和无效动作。
- 两个角色可以使用不同网格和材质，但应使用兼容的 Mixamo 骨骼与相同的动画名称。

可以使用以下命令检查 GLB 是否包含完整动画：

```powershell
node -e "const fs=require('fs');const f=process.argv[1];const b=fs.readFileSync(f);const n=b.readUInt32LE(12);const j=JSON.parse(b.subarray(20,20+n).toString().trim());console.log((j.animations||[]).map(x=>x.name))" frontend/public/games/ironfist/fighter2.glb
```

预期输出包含：

```text
idle, attack, defend, charge, hit, dodge, ko
```

---

## 其他免费/开放素材来源

- [Quaternius](https://quaternius.com/)：大量免费低多边形角色，注意每个资源包的具体授权。
- [Kenney 3D Assets](https://kenney.nl/assets/category:3D)：适合移动端的低多边形资产。
- [Sketchfab](https://sketchfab.com/)：下载时筛选 CC0/CC-BY，并保存作者与授权信息。

CC-BY 素材必须在应用的致谢或关于页面署名；CC0 通常无需署名，但仍建议保存来源链接、
作者、下载日期和许可证副本。
