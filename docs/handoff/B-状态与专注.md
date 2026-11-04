# Part B · 状态与专注（数值 / 胶囊 / 专注模式）

> **Labels**：`part-b` `feature`
> **Milestone**：M1 / M2
> **依赖**：A 组的 `focus:enter/exit` 渲染钩子（半天可交）；A 的摸头/喂食/打卡消费你的 `stats:patch`
> **对应决策**：D1（沿现有 UI 风格）、D3（喂食 +20）、D4（主进程 JSON 存储）、D5（现有功能全保留）
> **共享契约**：[README.md](README.md) §5（C2/C3/C4/C5）
> **自测素材**：`examples/dev-pet/`（已提交，8 动作 / 256px / 全程透明底 / 0.5MB）——`cp -r examples/dev-pet ~/.petpet/pets/dev-pet` 即可在 App 里切到它，见 [examples/dev-pet/README.md](../../examples/dev-pet/README.md)

---

## 1. 目标

让用户一眼看到"今天喂了没、摸了几次"，并且能把桌宠当番茄钟用：**右上角胶囊 → 悬停看今日状态；右键专注 → 设 25 分钟 → 桌宠趴下变暗，胶囊走秒 → 归零被唤醒**。数值只涨不跌，不制造焦虑。

**M1 的第一件事是把 `stats:get/patch` 交出来**——A 组的摸头/喂食/打卡全靠它，你可以先只交数据层（含单测），再做界面。

---

## 2. 范围

| # | 能力 | 说明 |
|---|---|---|
| B1 | 数值系统 | `~/.petpet/state/<petId>.json` + IPC + 纯函数 + 单测 |
| B2 | 状态胶囊 + 今日状态面板 | 右上角独立置顶窗，收起/悬停展开 |
| B3 | 专注模式 | 设置卡 + 倒计时（在胶囊显示）+ 休息态钩子 + 结束唤醒 |

**Out of scope**

- 左键摸头/喂食、提醒三件套、右键菜单、桌宠动效 → **A 组**
- 图库 / AI 链路 / 装配 → **本轮冻结**
- 全屏遮罩、系统通知、托盘常驻红点（PRD 未要求，成本高）→ 不做
- 双视觉风（像素面板/木牌/便签纸）→ 已明确不做，统一走现有 macOS 原生语言

---

## 3. 现有代码触点

| 位置 | 是什么 | 怎么用 |
|---|---|---|
| [main.js](../../viewer/main.js) 146–181 | 主窗创建：`BrowserWindow` + 透明/无边框/置顶 + 位置持久化 | **胶囊窗照这个写**（去掉 `resizable`、`skipTaskbar: true`、`focusable: false`） |
| [main.js](../../viewer/main.js) 513–537 | `reminders.json` 的读写：`~/.petpet/` 下 JSON、`mode: 0o600` | **状态存储照这个风格**（再加原子写：temp + rename） |
| [main.js](../../viewer/main.js) 1301–1360 | 提醒定时器 + `setTimeout` 调度 | 专注倒计时**建议不用 setTimeout 累加**，用 `endAt` 时间戳差值（见 B3） |
| [src/main.ts](../../viewer/src/main.ts) 150–181 | 鼠标穿透：`uiRects()` + `updateMouseIgnore()` | **胶囊窗必须照抄**，否则会挡住桌面其它应用 |
| [src/style.css](../../viewer/src/style.css) 11–45 | `:root` + 深色模式变量表 | 变量**值**直接抄进 `capsule.css`（C4），别自创配色 |
| [panel.html](../../viewer/panel.html) / [panel.css](../../viewer/panel.css) | 现有小窗口（日记）的样式与 DOM 组织 | 面板类 UI 参考它的信息层级，别另起一套 |
| [preload.cjs](../../viewer/preload.cjs) | contextBridge 白名单写法 | `capsule-preload.cjs` 照抄结构，只暴露必要方法 |
| [09-双端适配](../09-双端适配.md) §3 | Windows 透明窗不支持 `backdrop-filter` | 每个毛玻璃面必备不透明降级底 |

---

## 4. 实施步骤

### B0 · 骨架（0.5 天）

- [x] 新建 `viewer/capsule.html` / `capsule.css` / `capsule.js` / `capsule-preload.cjs`、`companion.cjs`、`stats-store.cjs`
- [x] `main.js` 末尾 `// ==== SECTION: B / status-focus ====` 区，只放 `registerStatusFocus({...})`
- [ ] 胶囊窗：
  - 位置：主屏 `workArea` 右上角，边距 12px；监听 `display-metrics-changed` 重算（否则换分辨率会飘出屏）
  - **窗口尺寸固定为展开态**（约 `300×240`），收起时只显示顶部 56px 的胶囊，下方透明——避免动态 `setBounds` 的闪烁与 DPI 抖动
  - `frame: false` / `transparent: true` / `alwaysOnTop: true` / `skipTaskbar: true` / `focusable: false`
  - 点击穿透：`setIgnoreMouseEvents(true, { forward: true })`，指针进入胶囊/面板区才 `false`（照抄 [src/main.ts](../../viewer/src/main.ts) 150–181）
- [x] 悬停展开/移出收起：150ms 进、300ms 出（防抖），**不要在展开时抢焦点**（`showInactive()`）

### B1 · 数值系统（1.5 天）⭐ 先交这个

规则（唯一口径）：

| 项 | 初始 | 变化 | 上限 | 备注 |
|---|---|---|---|---|
| 饱腹 `satiety` | 50 | **打卡喂食/喂水 +20**（每次都加）——这是唯一喂食入口 | 100 | 2026-11-04 方案 C：点桌宠身体不再加数值，只弹提示引导去点提醒里的 [已完成] |
| 心情 `mood` | 60 | 摸头 +5（**每日合计上限 15** → `moodToday`）；打卡**当天第一次** +10 | 100 | 同一天第 2 次起打卡不再加心情（防连点刷分） |
| 打卡 `checkins` | 0 | 每次 [已完成] +1 | 显示 `min(n,3)/3` | 计分口径见上两行 |
| 漏点惩罚 | — | 喂食/喂水提醒 **1 分钟内**没点 [已完成] → 心情/饱腹各 **-30** | 保底 0 | 自定义提醒不惩罚；惩罚不吃心情每日额度 |

**表现（只改外观，不改数值）**

| 触发 | 表现 |
|---|---|
| 饱腹 < 30 | 桌宠瘫倒（CSS 旋转）+ 气泡「饿…饿扁了…」 |
| 饱腹 > 80 | 开心跳跃（CSS 循环动画） |
| 心情 < 30 | 背对你（水平翻转）+ 头顶乌云 ☁️ + 气泡「有点不开心…摸摸我嘛」 |
| 心情 > 80 | 头顶爱心 💗 |

- [x] `stats-store.cjs`：
  - `read(petId)` / `patch(petId, delta)` / `ensureToday(petId)`
  - 文件 `~/.petpet/state/<petId>.json`，**原子写**（写 `.tmp` → `fs.renameSync`），`mode: 0o600`
  - 目录不存在自动创建（教训见 [09-双端适配](../09-双端适配.md) §3「启动不自动创建 `~/.petpet/pets`」那条事故）
  - 跨天：`state.date !== today()` → 重置 `mood/satiety/checkins/moodToday`，`deviceId` 保留
  - `petId` 必须过 `security-utils.cjs` 的 `safePetId`（防路径穿越）
- [x] 纯函数（node 直测，**不要测 DOM**）：`applyMood(state, +5)`、`applyFeed(state)`、`applyCheckin(state)`、`dailyReset(state, today)`、`clamp`
- [x] IPC：`stats:get(petId)` / `stats:patch(petId, delta)` → **返回新状态**（调用方只信返回值）
- [x] 单测 ≥12 例：初始值、上限钳制、每日 15 上限、跨天重置、超 3 次打卡、非法 petId、坏 JSON（应重建而不是崩）
- [ ] **B1 一交，A 组就能开工**——所以先推这一个 PR（可独立合并）

### B2 · 状态胶囊 + 今日状态面板（1.5 天）

- [x] 收起态（56px 高）：圆形头像（**精灵表首帧 + CSS `border-radius:50%`**，不需要新素材）、宠物名、一条状态点（有未完成打卡时主色点）
- [x] 展开态：`今日状态` 标题 + 日期行（`11 / 02 周一`）+ 两根细进度条（心情暖红 `--pp-mood-fill` / 饱腹暖橙 `--pp-satiety-fill`）+ 打卡圆点 `2/3`
- [x] 数值来源只走 `stats:get`；收到 A 的 `stats:patch` 后主进程广播 `capsule:refresh` 让胶囊刷新（**不要在胶囊里自己算分**）
- [x] 悬停展开时指针进入面板区仍保持可交互；移出整个窗口 300ms 后收起
- [x] 空态：没有宠物包 / 没有数值文件 → 显示「还没有宠物」而不是空白
- [x] 降级：`backdrop-filter` 不支持 → `rgba(246,246,246,.96)` 实底
- [x] 深色模式：抄 `style.css` 的 `prefers-color-scheme: dark` 变量块，手测一次

### B3 · 专注模式（1.5 天）

- [x] 入口：A 的右键菜单发 `focus:request`；托盘菜单也加一项
- [x] 设置卡：独立小窗（居中主屏，约 `360×220`，**不做全屏遮罩**——需要全屏透明窗，成本高收益低）
  - 大号分钟输入（数字键盘可直接输）+ 预设 `15 / 25 / 45 / 60` + `开始` + `取消`
  - 校验：1–180 的整数，非法输入禁用按钮并给行内提示
- [x] 开始：写 `~/.petpet/focus.json`（`{ endAt, minutes }`）→ `send('focus:enter', { minutes })` → 胶囊切专注态
- [x] 倒计时：**在胶囊窗显示**（C5）`FOCUS 24:59` + `提前结束` 按钮
  - 时间基准用 `endAt - Date.now()`，**不要用 `setTimeout` 累加**（避免休眠/换窗漂移）
  - 每秒 tick 用 `setInterval(1000)`，但显示值由时间戳算，`tabular-nums` 防跳动
- [x] 结束（自然归零或提前结束）：清 `focus.json` → `send('focus:exit')`（A 恢复桌宠）→ 胶囊回常规态 → 主进程让桌宠播 `wiggle` + 气泡「休息一下，顺便给我换水吧。」
- [x] 重启恢复：启动读 `focus.json`，`endAt` 未到 → 继续显示并补发 `focus:enter`；已过 → 清文件（**无双重计时风险**，因为时间是绝对的）
- [x] 单测 ≥6 例：`parseMinutes`（非法/0/负数/超 180/小数）、`formatCountdown(ms)`（含 0 与跨时）、`remaining(endAt, now)`

---

## 5. 契约产出 / 消费

| 契约 | 角色 | 内容 |
|---|---|---|
| C2 状态文件 | 产出 | `~/.petpet/state/<petId>.json`，A 不得直写 |
| C3 `stats:*` | 产出 | `stats:get` / `stats:patch`，M1 第 1–2 天交付 |
| C3 `capsule:*` | 产出 | `capsule:refresh` / `capsule:expand` |
| C3 `focus:*` | 产出+消费 | 发 `focus:enter/exit` 给 A；发 `focus:request` 给你自己 |
| C4 视觉基线 | 遵守 | 复制 `style.css` 变量值；只新增 `--pp-mood-fill` / `--pp-satiety-fill` |
| C5 跨组钩子 | 消费 | `focus:enter/exit` 由 A 实现渲染效果 |

---

## 6. 验收标准

| # | 验收 | 判定 |
|---|---|---|
| 1 | 右上角胶囊位置正确、不挡桌面点击（透明区能点到下层应用） | 在胶囊旁边点桌面图标 |
| 2 | 悬停展开、移出收起；深色模式可读 | 手测 + 截图 |
| 3 | 摸头 3 次后心情 +15，第 4 次不再涨 | 看 `state/*.json` |
| 4 | 打卡 3 次：饱腹 50→100（封顶）、打卡显示 3/3 | 手测 |
| 5 | 跨天（改系统时间）后数值重置为初始值 | 改日期重启 |
| 6 | 重启 App 数值/打卡都在 | 杀进程重启 |
| 7 | 专注 1 分钟：胶囊走秒、桌宠变暗且不随机换动作、归零唤醒 | 掐表 |
| 8 | 专注中杀进程重启 → 倒计时按剩余时间继续 | 手测 |
| 9 | 提前结束可立即恢复 | 手测 |
| 10 | 单测：数值 ≥12 例 + 时间 ≥6 例 | `npm test` |
| 11 | 现有日记/图库/8 动作/多宠不受影响 | 回归手测 |

---

## 7. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 胶囊窗挡住桌面 | 严重体验问题 | 固定尺寸 + 精确 rect 判定 + `forward: true`，先做穿透验证再写 UI |
| 状态文件写坏（半截 JSON） | 数值丢失 | 原子写 + 读失败重建默认值（不要删文件，改名 `.corrupt` 留证） |
| 专注中休眠/换屏导致时间漂移 | 倒计时不准 | 全部基于 `endAt` 时间戳 |
| 与 A 同时改 `main.js` | 冲突 | 严格 SECTION 区，逻辑进 `companion.cjs` |
| 跨天重置在用户熬夜时"半夜归零" | 观感受挫 | 按本地日期（00:00）重置即可，PRD 口径；不要做成"24 小时滑动窗口" |
| 新增测试导致 CI 计数红 | PR 被卡 | 同步 `docs/13` §2 的 vitest 总数 |

---

## 8. 交付物清单

- 代码：`viewer/capsule.*`、`capsule-preload.cjs`、`focus.html` / `focus.js` / `focus.css`、`companion.cjs`、`stats-store.cjs`、`main.js`（SECTION B + 托盘项）
- 测试：`tests/stats.test.ts`、`tests/focus.test.ts`（≥18 例）
- 文档：`docs/14` 加「数值系统」「状态胶囊」「专注模式」三行；`docs/13` §2 计数同步；`docs/08` 若新增 `pet.json` 字段需同步（本期 B 组**不新增契约字段**）
- PR 建议拆两个：`feat(b-stats): 数值系统 + IPC`（先合）、`feat(b-ui): 胶囊 + 专注模式`
