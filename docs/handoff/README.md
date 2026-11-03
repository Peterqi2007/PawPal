# 协作分工 v2 · 陪伴交互（A） / 状态与专注（B）

> **依据**：`docs/PRD(1).docx` + `docs/PawPal-UI初稿-现实风-v6.pdf`，但**以本项目现状为准**（见 §2 取舍表）。
> **v2 变更**：Owner 拍板后**推翻 v1 的「形象侧 / 陪伴侧」切法**，改为按**界面表面**切分——因为「像素化 / 双视觉风 / 独立创建页」已明确不做，形象侧缩到几乎为空，不再成其为一条工作流。
> **任务书**：[A-陪伴交互与提醒.md](A-陪伴交互与提醒.md)、[B-状态与专注.md](B-状态与专注.md)。
> **维护**：契约（§5）变更需双方在场；本文件由 Owner 维护。

---

## 1. 一句话分工

| 组 | 一句话 | 交付物（可独立演示） |
|---|---|---|
| **A** | 桌宠本体：会摸头、会撒娇、到点会抖会叫 | 左键摸头/喂食 + 人格气泡 + 提醒音效·抖动·大气泡打卡 |
| **B** | 状态与专注：今天喂了没、陪我专注一会 | 右上角胶囊（心情/饱腹/打卡）+ 专注倒计时 |

## 2. Owner 决策记录（2026-11-03，**优先级高于 PRD**）

| # | 决策 | 影响 |
|---|---|---|
| D1 | **UI 沿用现有风格**（macOS 原生设计语言：毛玻璃 + 系统蓝 + 15px 圆角 + 柔和阴影 + 深色自适应，见 `viewer/src/style.css` 的 `:root`） | 砍掉「偏现实风/偏卡通风」双主题；**不做** `theme-tokens` 双套变量 |
| D2 | **忽略 PRD 的产品纸面设定**，以本项目实际为准 | 砍掉本地像素化生成、独立创建页、`localStorage` 方案、内存 12MB 宣称等 |
| D3 | **点击喂食 = 饱腹 +20**（与打卡同口径，UI 稿的 +1 视为笔误） | 数值规则唯一口径 |
| D4 | **状态存储按工程实际**：主进程 JSON，不用 localStorage | 见 §5 C2；`deviceId` 保留但无账号体系 |
| D5 | **现有日记 / 8 动作 / 图库 / 多宠全部保留**，图库**一行不许改** | 新增能力只做**追加**；创建/编辑档案仍走图库 |

**因此本轮的取舍表**（PRD 提了，但我们**接受 / 拒绝**）：

| PRD 条目 | 处置 | 理由 |
|---|---|---|
| 轻量数值系统（心情/饱腹/打卡、无衰减、每日重置） | ✅ 接受 | 与"陪伴"定位一致，成本低 |
| 提醒三件套（音效 + 抖动 + 可打卡大气泡） | ✅ 接受 | 正是现有提醒最缺的一环 |
| 专注模式（设置 + 倒计时 + 结束唤醒） | ✅ 接受 | 办公场景核心，实现干净 |
| 状态胶囊 + 今日状态面板 | ✅ 接受 | 数值系统的必要可见面 |
| 左键分区（摸头/喂食）+ 人格气泡按场景 | ✅ 接受 | 现有单击只有一个气泡池，太薄 |
| 生成像素桌宠 / 双视觉风 / 圆形头像素材 | ❌ 拒绝 | 与现有 AI 生成链路冲突，且属风格选择题 |
| 独立创建页（替换图库入口） | ❌ 拒绝（P0） | **图库不能动**；图库已是完整创建/编辑入口 |
| localStorage + deviceId 存数值 | ❌ 拒绝 | 主进程也要读（托盘/胶囊/提醒），多窗口一致性差 |
| macOS 居中模态 / 便签纸 / 像素时间块等视觉稿 | ❌ 拒绝 | 与 D1 冲突，沿用现有面板风格 |
| 「内存约 12MB」 | ❌ 拒绝 | 不实宣称，删掉 |

---

## 3. 切分依据：按界面表面切，而不是按产品故事切

```
┌─ 桌宠主窗（320×320）─────────┐   ┌─ 新窗口（右上角 / 居中）──────┐
│ 精灵 + 气泡 + 提醒条          │   │ 状态胶囊 + 今日状态面板        │
│ 左键摸头/喂食 · 呼吸/弹跳      │   │ 专注设置卡 + 倒计时            │
│ → A 组                        │   │ → B 组                        │
└──────────────┬───────────────┘   └───────────────┬───────────────┘
               │        stats:get / stats:patch    │
               └──────────────► 主进程 ◄────────────┘
                          （数值唯一真源，B 建、A 用）
```

- **文件不重叠**：A 只碰主窗三件套（`index.html` / `src/main.ts` / `src/style.css` / `preload.cjs`），B 只碰新窗口（`capsule.*` / `focus.*` / `stats-store.cjs` / `companion.cjs`）。
- **能力互补**：A 需要 B 的数值接口（摸头/喂食/打卡要加减分），B 需要 A 的渲染钩子（专注时要暂停随机动作 + 调暗桌宠）。
- 两处依赖都在**第 1 天就能交**，因此可真正并行（见 §6 里程碑）。

---

## 3.5 依赖关系（谁等谁）—— 已核对，**无死锁，但有两个方向相反的跨组信号**

| ID | 方向 | 传什么 | 阻塞什么 | 解法 |
|---|---|---|---|---|
| **P1** | A → B | `stats:patch` 返回值 | A1 的记分、A3 的 [已完成] | **已解除**：A 组自行交付了契约 C2 的最小 provider（`viewer/companion.cjs`，含 20 单测）；B 组直接复用该 IPC，或把实现迁进 `stats-store.cjs`，**IPC 名不变** |
| **P2** | B → A | `focus:enter/exit` | B3 的"桌宠趴下变暗" | **A0 用 20 行 stub 先交**（监听 + CSS 类），不占 A1 工期 |
| P3 | A → B | `focus:request` 能打开设置卡 | 右键菜单手测 | B0 建窗时先接上；未接时菜单项 no-op 不报错 |
| P4 | A → B | `capsule:refresh` | 打卡后胶囊即时刷新 | B 侧广播，A 只需调 `stats:patch` |
| **S4** | 共同（隐性坑） | `pet:assemble` 会生成**新 petId** | 重新装配后 B 的 `state/<旧id>.json` 对不上 → 数值凭空归零 | B 订阅 `pet:switch`：新 id 无 state 时按宠物名迁移旧值；或显式接受归零并写进文档 |

**为什么不算死锁**：P1 是**数据叶**（A 只取返回值，不依赖 B 的 UI），P2 是**渲染叶**（B 只发信号，不依赖 A 的业务）。两者都能用 stub 在 M0 当天打通，所以可以真并行。

**关键路径与解锁顺序**

| 时间 | A 组 | B 组 | 解锁了什么 |
|---|---|---|---|
| D0 | 契约冻结 + `focus` stub + `stats` mock | §5 冻结 + 胶囊窗骨架 | 双方都能编译 |
| D1–2 | A1 左键分区（用 mock 记分） | **B1 数值系统（优先合）** | A1 切真接口；B2 开工 |
| D3–4 | A2 动效 + 人格气泡 | B2 胶囊 + 今日面板 | — |
| D5–6 | A3/A4 提醒三件套 + 入口 | B3 专注模式 | — |
| D7 | 合流演示 + 8 条验收 | 同左 | — |

**单边延期的降级**：B 延期 → A 仍可演示"摸头有反应、提醒会抖会叫"，只是记分不落库；A 延期 → B 的专注照常走秒唤醒，只是桌宠不趴下变暗。**两侧都不会互相卡死。**

---

## 3.6 两组共同的开发基线：`examples/dev-pet`

已提交到仓库（0.5MB，8 动作 × 8 帧 × 256px，全程透明底，`validate_pet.py` 已通过）：

```bash
cp -r examples/dev-pet ~/.petpet/pets/dev-pet      # Windows: xcopy /E /I examples\dev-pet %USERPROFILE%\.petpet\pets\dev-pet
python pipeline/validate_pet.py examples/dev-pet
```

- A 用它测：`wiggle`（提醒到点要播）、透明区不响应点击、8 动作菜单、`persona` 气泡
- B 用它测：精灵首帧当胶囊头像、`sleep` 当专注休息态、跨动作切换不闪
- 只有 `idle`/`belly` 是真实帧，其余是几何变换派生的占位动画——**别当正式素材**，正式素材走 [05-素材管线](../05-素材管线.md)

---

## 4. 文件所有权

| 路径 | A | B | 说明 |
|---|:---:|:---:|---|
| `viewer/index.html` / `src/main.ts` / `src/style.css` / `preload.cjs` | ✍️ 独占 | — | 桌宠主窗全部归 A |
| `viewer/capsule.*` / `capsule-preload.cjs` / `focus.html` / `focus.*` / `status-focus.cjs` / `focus-session.cjs` / `capsule-state.cjs` | — | ✍️ 独占 | 新窗口与专注逻辑，B 新建 |
| `viewer/companion.cjs` / `stats-store.cjs` | — | ✍️ 独占 | 主进程模块 |
| `viewer/assets/*.wav` | ✍️ 独占 | — | 提醒音效 |
| `viewer/refs.*` / `refs-store.cjs` / `refs-preload.cjs` / `pet-assembler.cjs` / `animator*` | 🚫 **禁改** | 🚫 **禁改** | 图库 + AI 链路：本轮冻结 |
| `viewer/main.js` | ⚠️ 只在 `// ==== SECTION: A ====` 区加 | ⚠️ 只在 `// ==== SECTION: B ====` 区加 | 见下 |
| `schema/pet.schema.json` / `pipeline/validate_pet.py` / `docs/08` | ✍️ 独占（C1 一个字段） | — | 三处同步 |
| `docs/13` §2 计数 / `docs/14` 矩阵 | 各加自己那行 | 各加自己那行 | PR 前 rebase |

**`main.js` 的写法**（两人都只有一行）：

```js
// main.js 末尾
// ==== SECTION: A / companion-pet ====
registerPetCompanion({ ipcMain, app, screen, send, PETS_ROOT })
// ==== SECTION: A / end ====

// ==== SECTION: B / status-focus ====
registerStatusFocus({ app, screen, BrowserWindow, ipcMain, getPet, getStats, notifyPet, onStateChange })
// ==== SECTION: B / end ====
```

> 合并后实际签名（B 落地时按真实依赖注入，比 initial 设想多了 `getPet` / `getStats` / `notifyPet`；
> `notifyPet` 就是 A 的 `send(channel, payload)` 闭包）。

> 冲突时：**双方都保留，rebase 后手改**，不要删对方那行。

---

## 5. 共享契约（M0 冻结，之后只加不改）

### C1 · `pet.json` 新增**一个可选字符串** `persona`（**注意：不是 `temperament`**）

```json
{ "version": 3, "id": "dou-dou", "name": "豆豆", "persona": "傲娇" }
```

- **不加 `meta` 对象**（v1 方案作废）：不需要 style/avatar/createdAt——视觉只有一套，头像用精灵首帧圆裁。
- 写入方：**A 组**，在 `pet:assemble` 里把分组 `profile.temperament`（图库字段名）写成 `pet.json.persona`（**只读 profile、只写 pet.json，不碰任何 `refs.*` 文件**）。
- 消费方：A 的渲染层按人格选场景文案池；缺失 → 回退现有 `bubbles` 池。
- `version` 保持 `3`（升 4 会被 `validate_pet.py` / `pet-import.cjs` 的 `[2,3]` 判定拒掉所有现有包）。

### C2 · 数值存储（B 建，A 用）

- 文件：`~/.petpet/state/<petId>.json`，`mode: 0o600`，原子写（temp + rename）
- 结构：`{ date: '2026-11-03', mood: 60, satiety: 50, checkins: 0, moodToday: 0, deviceId: '<uuid>' }`
- 规则：本地日期跨天重置；只升不降、上限 100；心情每日上限 15
- **不用 localStorage**：主进程要读（托盘、胶囊、专注），多窗口一致性靠 IPC
- IPC：`stats:get(petId)` / `stats:patch(petId, delta)` → **返回新状态**，调用方只信返回值
- A 组不得直接读写该文件

### C3 · IPC 命名（只加不改）

| 前缀 | 归属 | 用途 |
|---|---|---|
| `stats:*` | B 提供、A 消费 | `stats:get` / `stats:patch` |
| `focus:*` | 双向 | A → B：`focus:request`（右键/托盘点专注，A 已接）；B → A：**`focus:state`(entering:boolean)**（落定时统一用这条，`focus:enter/exit` 未使用） |
| `capsule:*` | B | `capsule:get` / `capsule:refresh`（主进程→胶囊广播）/ `capsule:toggle` / `capsule:setIgnoreMouse`；`capsule:expand/collapse` 由胶囊自己用 CSS 完成，未走 IPC |
| `reminder:*` | A | 现有 3 个通道**扩字段不删旧字段** |
| `pet:*` | 现有 | A 扩展 `pet:assemble` 写 `persona`（只加字段） |

### C4 · 视觉基线（不是 token 文件，是硬约定）

新窗口**必须**复用 `viewer/src/style.css` 的变量语言，值不许自创：

| 变量 | 值（浅色） | 用途 |
|---|---|---|
| `--accent` | `#007AFF`（深色 `#0A84FF`） | 主色 / 主按钮 / 焦点环 |
| `--bubble-bg` | `rgba(255,255,255,.78)` | 气泡底 |
| `--bar-bg` / `--menu-bg` | `rgba(246,246,246,.75/.78)` | 胶囊底、面板底 |
| `--shadow` | `0 10px 30px rgba(0,0,0,.16), 0 2px 8px rgba(0,0,0,.10)` | 浮层阴影 |
| 圆角 | 气泡 15px / 面板 12px / 按钮 8px | — |
| 字体 | `-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif` | — |

- 新窗口 HTML 里**复制** `:root` + `@media (prefers-color-scheme: dark)` 两块变量（**文件名各自独立，不做跨组共享文件**，避免为抽公共文件而改 A 的 style.css）。
- 唯一允许新增的变量：`--pp-mood-fill`（暖红）/ `--pp-satiety-fill`（暖橙），由 B 定义在 `capsule.css`，色值从现有设计语言推导，PR 说明即可。
- Windows 无 `backdrop-filter`（见 [09-双端适配](../09-双端适配.md) §3）：**每个毛玻璃面都要有不透明降级底**。

### C5 · 跨组两个钩子（各半天内可交付）

| 方向 | 调用 | 行为 |
|---|---|---|
| A → B | `invoke('stats:patch', { mood: +5 })` | 摸头/喂食/打卡统一走这里；**B 未就绪时 A 静默降级**（不弹错） |
| B → A | `send('focus:enter' / 'focus:exit', { minutes })` | A 在渲染层：暂停随机动作与转移链 + canvas `brightness(.82) saturate(.55)`；退出时恢复并（可选）播 `wiggle` |

**倒计时显示在胶囊窗（B 自己完成）**，不在桌宠头顶——避免 B 往 A 的 DOM 里塞元素。PRD §7 原文允许「头顶**或**胶囊处」。

---

## 6. 节奏与工时

| 里程碑 | 内容 | 产出 |
|---|---|---|
| **M0（第 0 天，0.5 天）** | §5 过一遍冻结；两分支建好；A 给 `pet:assemble` 加 `persona` 一行（schema/validator/docs 已就绪） | 契约可编译 |
| **M1（第 1–2 天）** | **B 先交 `stats-store.cjs` + IPC + 单测**；A 同时做左键分区与 hit 检测 | A 能记分、B 有数值 |
| **M2（第 3–6 天）** | A：提醒三件套 + 设置面板 + 人格气泡；B：胶囊 + 状态面板 + 专注 | 两条线各自 demo |
| **M3（第 7 天）** | 合流走 PRD「核心演示路径」+ 8 条验收逐条过 | 演示视频 |

工时：**A ≈ 5 人日，B ≈ 5 人日**（均衡，见各自任务书的分阶段估算）。

---

## 7. 协作规约（PR 检查用）

1. 分支：`feat/a-companion`、`feat/b-status-focus`，PR → `main`，reviewer = 对方 + Owner。
2. 每个 PR 本地全绿（命令与 CI 一致）：
   ```bash
   cd viewer && npm test && npx tsc --noEmit && npm run build
   cd .. && python pipeline/validate_pet.py .github/examples/redshao-demo/
   python pipeline/check_docs_sync.py && python pipeline/check_refs.py
   ```
3. 加测试必须同步 `docs/13` §2 的「✅ N 通过」数字（`check_test_counts.py` 比的是**测试总数**），否则 CI 必红。
4. 改 `pet.json` 字段必须三处同步：`schema/pet.schema.json` + `pipeline/validate_pet.py` + `docs/08`。
5. 新能力必须补 `docs/14` 一行，证据列写真实 `文件:符号`。
6. 不引新依赖（jsdom / canvas / 音频库一律不加）；算法写纯函数用 vitest 直测。
7. 提交信息中性：不写具体 AI 工具/厂商/模型名（`commit-check.yml` 有匹配正则）。
8. **`viewer/refs.*` 与 `animator*`、`pet-assembler.cjs` 本轮冻结**——任何 PR 改动这些文件直接打回。

---

## 8. 开工前置（Owner 处理）

1. **推到 GitHub 建 remote**。当前只有 1 个 squash 提交、无 remote、无 tag，而 `docs/14` 引用了 17 个历史 commit → `check_refs.py` 必红、CI 首跑就挂。二选一：(a) 恢复真实历史；(b) 把「验证 commit」列改成「本仓库快照」并放宽 `check_refs.py`（推荐，30 分钟）。
2. **3 个 Windows 专属失败用例**（`security-utils` / `pet-import` 的 symlink `EPERM`，Linux CI 能过）→ A 组第一个 commit 改 `it.skipIf(process.platform === 'win32')`。
3. ~~`examples/` 路径不存在（实际在 `.github/examples/`）~~ → **已修复**：示例素材已归位到 `examples/`，CI 的宠物包校验恢复可跑。

---

## 9. GitHub 落地

```bash
gh label create part-a --description "桌宠陪伴交互与提醒" --color 5319e7
gh label create part-b --description "状态数值与专注模式" --color 0e8a16

gh issue create --title "Part A · 陪伴交互与提醒（摸头喂食 / 人格气泡 / 提醒三件套）" \
  --label part-a --body-file docs/handoff/A-陪伴交互与提醒.md

gh issue create --title "Part B · 状态与专注（数值系统 / 状态胶囊 / 专注模式）" \
  --label part-b --body-file docs/handoff/B-状态与专注.md

git switch -c feat/a-companion main
git switch -c feat/b-status-focus main
```

**两个坑**：① 本机没装 `gh`，用网页新建 Issue 粘正文同样可行；② Issue 正文的相对链接以**仓库根**为基准，粘贴前把 `../../viewer/x` 批量改成 `viewer/x`。
