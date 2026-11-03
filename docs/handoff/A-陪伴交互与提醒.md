# Part A · 陪伴交互与提醒（桌宠本体）

> **Labels**：`part-a` `feature`
> **Milestone**：M1 / M2
> **依赖**：B 组的 `stats:patch`（M1 第 1–2 天先交，A 早期可静默降级）
> **对应决策**：D1（沿现有 UI 风格）、D3（喂食 +20）、D5（现有功能全保留、图库禁改）
> **共享契约**：[README.md](README.md) §5（C1/C2/C3/C4/C5）
> **自测素材**：`examples/dev-pet/`（已提交，8 动作 / 256px / 全程透明底 / 0.5MB）——`cp -r examples/dev-pet ~/.petpet/pets/dev-pet` 即可在 App 里切到它，见 [examples/dev-pet/README.md](../../examples/dev-pet/README.md)

---

## 1. 目标

把"会动的图片"变成"会回应的宠物"：点头部它会舒服，点身体它会吃，到点它会抖会叫会顶着气泡要打卡——**并且不打断、不弹系统通知、不依赖网络**。

成功的样子（对应 PRD 核心演示路径的前半段）：
左键点头部 → 弹跳 +「好舒服～」3 秒消失 → 摸头心情 +5 → 设 1 分钟喂水提醒 → **叮**一声 + 桌宠抖动 + 头顶大气泡 [已完成] → 点完饱腹 +20、气泡换成「喝饱啦！」

---

## 2. 范围

**In scope**

| # | 能力 | 说明 |
|---|---|---|
| A1 | 左键分区与命中检测 | 头 40% = 摸头 / 其余 = 喂食；透明区不响应 |
| A2 | 动效与气泡 | 弹跳、呼吸、轻微平移、气泡 3 秒、人格分场景文案 |
| A3 | 提醒三件套 | 本地音效 + 抖动 + 头顶大气泡（带 [已完成]） |
| A4 | 提醒入口 | 保留自然语言输入 + 三个常用按钮 + 提示音开关 |
| A5 | 菜单与专注钩子 | 右键菜单**追加**专注模式 / 编辑档案；响应 `focus:enter/exit` |

**Out of scope**

- 状态胶囊、今日状态面板、数值存储、专注设置卡与倒计时 → **B 组**
- 图库 / AI 重绘 / 动画生成 / 装配 UI → **本轮冻结，一行不许改**
- 双视觉风、像素化、独立创建页 → 已明确不做（D1/D2）
- 日记窗（`panel.*`）→ 不动

---

## 3. 现有代码触点

| 位置 | 是什么 | 注意 |
|---|---|---|
| [index.html](../../viewer/index.html) 10–28 | `#bubble`、`#reminder-panel`、`#reminder-bar` | 气泡 3 秒、新增 `#big-bubble`、给 canvas 包一层 `.pet-stage` |
| [src/main.ts](../../viewer/src/main.ts) 150–181 | `uiRects()` + `updateMouseIgnore()`：穿透逻辑（只有精灵/面板区接收事件） | 新增的 `#big-bubble`、新按钮**必须**加进 `uiRects()`，否则点不到 |
| [src/main.ts](../../viewer/src/main.ts) 359 / 365 | `requestAction` / `playAction` + `state-priority` 抢占 | 提醒/专注期间强制动作走 `requestAction(name,'reminder')` |
| [src/main.ts](../../viewer/src/main.ts) 457–470 | `showBubbleText`，**6 秒**自动消失 | 改 3 秒；顺手接 `prefers-reduced-motion` |
| [src/main.ts](../../viewer/src/main.ts) 520 / 544 / 556 | 提交提醒 / 到点处理（切 `wiggle` + 常显条）/ 关闭常显条 | A3 在这里换成三件套 |
| [src/main.ts](../../viewer/src/main.ts) 602 / 630 | `scheduleTransition` / 随机切换定时器 | `focus:enter` 时要停掉 |
| [preload.cjs](../../viewer/preload.cjs) | contextBridge 白名单 | 新增 API 必须同步白名单，漏了就是静默 `undefined` |
| [main.js](../../viewer/main.js) 304–323 | `menu:showContext` 右键菜单 | **只追加两项**，现有项一个不删 |
| [main.js](../../viewer/main.js) 1186–1233 | `pet:assemble`（写 `pet.json`） | 加一行写 `persona`（源是分组 `profile.temperament`）；**只读 `profile`，不碰 `refs.*`** |
| [main.js](../../viewer/main.js) 513–537 / 1301–1360 | 提醒持久化与定时触发 | 字段只加不删 |
| [src/style.css](../../viewer/src/style.css) 11–45 | `:root` + 深色模式变量 | 沿用这套值（C4），别自创配色 |

---

## 4. 实施步骤

### A0 · 契约与钩子（0.5 天）

- [ ] 与 B 组过一遍 [README.md](README.md) §5，确认 C1/C3/C5
- [ ] `pet:assemble` 写 `pet.json` 时加一行 `persona: profile.temperament`（可选字段；注意字段名不同：图库里叫 `temperament`，`pet.json` 里叫 `persona`）
- [ ] `preload.cjs` 加 `stats` 两个方法 + `onFocusEnter/onFocusExit` 监听
- [ ] `main.js` 末尾加 `// ==== SECTION: A / companion-pet ====` 区，只放一行注册
- [ ] 顺手修 3 个 Windows 失败用例（`it.skipIf(process.platform === 'win32')`）

### A1 · 左键分区（1 天）

- [ ] 把 `<canvas id="stage">` 包进 `<div class="pet-stage">`（A2 的动效都作用在这层，**别去改 PIXI sprite 的 transform**）
- [ ] 命中判定：`pointerup` 时
  1. 取当前帧在 canvas 上的绘制矩形（`sprite.getBounds()` 已有）
  2. **alpha 检测**：把指针坐标换算成纹理坐标，读该点 alpha（`app.renderer.extract.pixels()` 太重——改用离屏 canvas 缓存一帧 alpha 图，只在动作切换时刷新）
  3. `alpha < 16` → 忽略点击（点到透明区不该触发）
  4. 否则按「包围盒上 40% = 头部」分区
- [ ] 摸头：`stats:patch({ mood: +5 })`（B 返回的新状态用于判断是否已达每日上限）→ 弹跳 + 气泡
- [ ] 喂食：`stats:patch({ feed: true })` → +20 → 气泡
- [ ] 拖拽与点击不冲突：位移 > 6px 视为拖拽（沿用现有阈值）
- [ ] 单测：`splitHeadBody(bounds, y)`、`hitAlpha(alphaMap, x, y)` 纯函数各 ≥4 例

### A2 · 动效与人格气泡（1 天）

- [ ] 弹跳：`.pet-stage` `translateY(-8px)` 180ms 回弹（不打断精灵动画）
- [ ] 呼吸 + 轻微平移：`scale 1 ↔ 1.015`（4s）+ `translateX ±6px`（6s 交替）；`prefers-reduced-motion` 时全关
- [ ] 气泡 **3 秒**自动消失（现 6 秒）
- [ ] 人格分场景文案：`pet.json.persona` → 3 套池 × 4 场景（摸头/喂食/喂水/专注结束）= 12 池，纯数据放 `src/bubbles.ts`
  - 缺失 `persona` → 回退 `pet.json.bubbles`（现有行为，零回归）
  - 文案必须走数据，TS 里不留散落字符串
- [ ] 人格文案抽查：3 种人格 × 4 场景各点一次，不重复（同池内随机且不连续重复）

### A3 · 提醒三件套（1.5 天）⭐ 验收核心

**① 音效**

- [ ] `viewer/assets/ding.wav`（≤50KB，自制或 CC0，来源写进 `assets/` 说明与 CONTRIBUTING）
- [ ] 加进 `package.json` 的 `build.files`（漏了打包后静音，`assets/` 目前只打进图标）
- [ ] 自动播放限制：主窗加 `webPreferences.autoplayPolicy: 'no-user-gesture-required'`，或首次交互解锁 `AudioContext`
- [ ] 读不到音频 → 静默降级，不抛错

**② 抖动**

- [ ] `@keyframes pp-shake` 作用在 `.pet-stage`：`translateX ±6px`，120ms × 3
- [ ] 抖动结束后精灵继续正常播放（不重置帧）

**③ 头顶大气泡 + 打卡**

- [ ] 新增 `#big-bubble`：桌宠头顶、白底微阴影（C4 值）、含主色 [已完成] 按钮
- [ ] 持续 **10 秒**；超时淡出但**不丢提醒**（胶囊红点由 B 负责）
- [ ] 点击 → `stats:patch({ checkin: true })` → 气泡变「吃饱啦！」1.5 秒 → 消失
- [ ] **窗口空间**：主窗 320×320。推荐 `setWindowSize(360×420)` 临时放大、结束后恢复（`view:setSize` 通道已存在）；B0 阶段先确认这条可行
- [ ] `#big-bubble` 加入 `uiRects()`，否则点不到按钮

### A4 · 提醒入口（0.5 天）

- [ ] 保留现有文本框 + 自然语言解析（`src/reminder.ts` 的 `parseReminder`，**6 例单测不许删**）
- [ ] 加三个快捷按钮：`喂食` / `喂水`（写入 `kind: 'feed'|'water'`，默认「1 小时后」）/ `自定义`
- [ ] 加一个「提示音」开关（存 `reminders.json` 的 `sound: boolean`，缺省 true）
- [ ] `reminders.json` 只加字段：`kind`、`sound`；旧数据缺字段时按默认值处理（**不做迁移脚本**）

### A5 · 菜单与专注钩子（0.5 天）

- [ ] 右键菜单**追加**两项（位置：现有「提醒我」之后）：
  - `🎯 专注模式` → `send('focus:request')`（B 接）
  - `✏️ 编辑档案` → `send('refs:open')`（打开**现有**图库窗，不改图库任何代码）
- [ ] 现有菜单项（日记 / 参考图库 / 8 动作 / 重置大小）**原样保留**
- [ ] `focus:enter` → 停掉 `randomTimer` 与 `scheduleTransition`，`.pet-stage` 加 `filter: brightness(.82) saturate(.55)`
- [ ] `focus:exit` → 恢复定时器与滤镜，可选播一次 `wiggle`
- [ ] 单测：`applyFocusState(state, entering)` 纯函数（焦点态 + 定时器启停的决策）≥3 例

---

## 5. 契约产出 / 消费

| 契约 | 角色 | 内容 |
|---|---|---|
| C1 `pet.json.persona` | 产出 | 装配时写入一行，缺省回退 `bubbles` |
| C3 `reminder:*` | 产出 | 扩 `kind` / `sound` 字段 |
| C3 `focus:enter/exit` | 消费 | 渲染层暂停随机 + 调暗 |
| C3 `stats:patch` | 消费 | 摸头/喂食/打卡；**B 未就绪时静默降级** |
| C4 视觉基线 | 遵守 | 新 DOM（气泡/按钮/抖动）只用现有变量 |

---

## 6. 验收标准

| # | 验收 | 判定 |
|---|---|---|
| 1 | 点头部：弹跳 + 气泡（人格语气）+ 心情 +5；点身体：喂食 +20 | 3 种人格各 3 次 |
| 2 | 点透明区（宠物轮廓外）无反应、不弹气泡 | 沿边缘点 10 次 |
| 3 | 气泡 3 秒消失；连续点击不叠加多个气泡 | 手测 |
| 4 | 设 1 分钟提醒 → **有声音** + 抖动 + 头顶大气泡带 [已完成] | 掐表 3 次 |
| 5 | 点 [已完成] → 饱腹 +20，气泡换文案后消失 | 打开 `state/*.json` 核对 |
| 6 | 关掉提示音开关 → 只抖不响 | 手测 |
| 7 | 专注中：桌宠变暗、随机动作停止；结束后恢复 | 手测 + 日志 |
| 8 | 右键菜单：原有 5 项全在 + 新增 2 项可用 | 截图对照 |
| 9 | 现有 8 动作、日记、图库、多宠**全部回归正常** | 逐项手测 + `npm test` 全绿 |
| 10 | 断网全程可跑通 | 关 Wi-Fi |

---

## 7. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 点 [已完成] 需要窗口临时变大，窗口抖动观感差 | 体验 | 先做 A3 前的窗口尺寸预演；不行就改成「大气泡贴边展开，不出窗」 |
| 每帧读 alpha 太重 | 掉帧 | 只在动作切换时缓存一张 512px 缩略 alpha 图 |
| 抖动/呼吸作用在 PIXI 对象上会与动画抢 | 花屏 | 一律作用在 `.pet-stage` wrapper |
| 新增 DOM 漏进 `uiRects()` | 点了没反应 | 加完立刻手测穿透 |
| 打包漏 `assets/*.wav` | 静音 | 加 `build.files` 后跑一次 `npm run dist` 手测 |
| 改 `pet:assemble` 触碰图库红线 | 打回 | **只读 `profile`、只写 `pet.json`**；改完 `grep -r "refs" main.js` 自查无新增引用 |

---

## 8. 交付物清单

- 代码：`index.html`、`src/main.ts`、`src/style.css`、`src/bubbles.ts`、`src/reminder.ts`（扩展）、`preload.cjs`、`main.js`（SECTION A + 菜单 + assemble 一行）
- 资源：`viewer/assets/ding.wav`
- 测试：`tests/interaction.test.ts`、`tests/bubbles.test.ts`（≥15 例）
- 文档：`persona` 字段**已随 dev-pet 落地**（schema + validate_pet + docs/08 已同步），A 组只需在 `pet:assemble` 写入 + 渲染层消费；`docs/08` 补 `reminders.json` 新字段；`docs/14` 加「左键分区」「人格气泡」「提醒三件套」；`docs/13` §2 同步
- PR：`feat/a-companion` → `main`，标题 `feat(pet): 左键分区 + 人格气泡 + 提醒三件套`
