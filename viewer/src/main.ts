// PetPet 桌宠查看器 - 渲染引擎（PixiJS v8）
// 功能：精灵表播放、动作切换、拖拽、缩放、气泡、随机行为
// 注意：Electron/CSP 环境下必须使用 unsafe-eval 模块（PixiJS v8 依赖）
import 'pixi.js/unsafe-eval'
import * as PIXI from 'pixi.js'
import { parseReminder } from './reminder'
import { shouldPlay } from './state-priority'
import { effectiveWeight } from './temperament' // V2-A: 气质调制器（2026-08-09）
// Part A：陪伴交互（左键分区 / 人格气泡 / 提醒三件套）
import { resolveHit, buildAlphaMap, toLayoutPoint } from './hit-test'
import { pickBubble, type BubbleScene } from './persona-bubbles'
import { expressionOf, thresholdBubble } from './pet-expression'
import { heartBurstSpec, HEART_BURST_MS, HEART_GLYPH, heartEnd, heartOpacity } from './heart-burst'
import {
  createQueue, enqueue, currentOf, pendingCount, dismiss,
  type QueueState, type ReminderEntry
} from './reminder-queue'
import { applyFocusState, focusLabel } from './focus'
import { playDing, unlockAudio } from './audio'
// 音效资源走 Vite 资源管线：构建后自动落到 dist/assets/ 并返回可用 URL
// （直接写 './assets/ding.wav' 在生产模式下会指向不存在的 dist/assets/ding.wav，play() 必失败）
import dingUrl from '../assets/ding.wav?url'

// ================= 类型 =================
interface PetActionSpec {
  file?: string
  sprite?: string
  frames: number
  fps?: number
  loop?: boolean
  weight?: number
  pingpong?: boolean
  frameWidth?: number
  frameHeight?: number
  scale?: number
  transitions?: Record<string, number>
  label?: string // v3：菜单显示名（优先于内置映射）
  diary?: { mood: string; text: string } // v3：动作→日记心情文案（优先于内置映射）
}

interface PetJson {
  version: number
  id: string
  name: string
  theme?: string
  bubbles?: string[] // v3：互动气泡文案池（优先于内置 BUBBLE_TEXTS）
  persona?: string // Part A：人格（温柔/傲娇/搞笑）——决定互动气泡语气；缺省回退 bubbles
  cellWidth: number
  cellHeight: number
  error?: string
  actions: Record<string, PetActionSpec>
  // V2-A: 身份+气质（2026-08-09，可选，缺省=中性，兼容旧包）
  identity?: {
    species?: string
    appearance?: Record<string, string>
    habits?: Record<string, boolean>
  }
  temperament?: {
    activity?: number
    clinginess?: number
    curiosity?: number
    independence?: number
  }
}

declare global {
  interface Window {
    petAPI: {
      listPets: () => Promise<string[]>
      loadPet: (id: string) => Promise<PetJson>
      getFile: (id: string, rel: string) => Promise<{ dataUrl?: string; error?: string }>
      setWindowSize: (w: number, h: number) => void
      scaleTo: (w: number, h: number) => Promise<{ x: number; y: number; width: number; height: number } | null>
      moveWindow: (x: number, y: number) => void
      setIgnoreMouse: (ignore: boolean, forward?: boolean) => void
      getWindowPosition: () => Promise<{ x: number; y: number }>
      onZoom: (cb: (f: number) => void) => void
      onReset: (cb: () => void) => void
      onTestAction: (cb: (name: string) => void) => void
      notifyPetLoaded: (id: string) => void
      notifyAction: (info: { mood: string; text: string }) => void
      onAction: (cb: (name: string) => void) => void
      setReminder: (spec: { at: number; repeat: string; text: string; kind?: string }) => Promise<{ id?: string; error?: string }>
      onReminderFire: (cb: (r: { id: string; text: string; kind?: string; sound?: boolean }) => void) => void
      appendActivity: (entry: { petId: string; mood: string; text: string }) => void
      openDiary: (petId: string) => void
      onOpenReminder: (cb: () => void) => void
      onVisibility: (cb: (visible: boolean) => void) => void  // P2-5: 隐藏时暂停动画
      showContextMenu: (x: number, y: number) => Promise<void>
      listActivity: (petId: string) => Promise<{ ts: number; mood: string; text: string }[]>
      onPetSwitch: (cb: (id: string) => void) => void
      // Part A：数值 / 偏好 / 专注钩子 / 音效上报
      statsGet: (petId: string) => Promise<StatsResponse | null>
      statsPatch: (petId: string, delta: StatsDelta) => Promise<StatsResponse | null>
      prefsGet: () => Promise<{ sound: boolean } | null>
      prefsSet: (patch: { sound?: boolean }) => Promise<{ ok: boolean; sound: boolean } | null>
      reportAudio: (status: string, detail?: string) => void
      onFocusChange: (cb: (entering: boolean) => void) => void
      onBubble: (cb: (text: string) => void) => void
      reminderAck: (id: string) => void
      onReminderMissed: (cb: (info: { id: string; state?: { mood: number; satiety: number } }) => void) => void
    }
  }
}

interface StatsState {
  date: string
  mood: number
  satiety: number
  checkins: number
  moodToday: number
  deviceId: string
}

interface StatsDelta {
  feed?: true
  checkin?: true
  mood?: number
}

interface StatsResponse {
  ok: boolean
  error?: string
  state?: StatsState
  applied?: { mood: number; satiety: number; checkins: number }
  capped?: { mood: boolean; satiety: boolean }
  rejected?: string[]
}

// ================= 状态 =================
const app = new PIXI.Application()

let pet: PetJson | null = null
let petId = ''
let sprite: PIXI.AnimatedSprite | null = null
let textures: Record<string, PIXI.Texture[]> = {}
let currentAction = 'idle'
let baseScale = 0.9
// P2-8: 缩放持久化（localStorage，渲染层可用）
try {
  const savedScale = parseFloat(localStorage.getItem('petpet:scale') || '')
  if (savedScale >= 0.5 && savedScale <= 2) baseScale = savedScale
} catch { /* ignore */ }
let pingpongDir = 1
let bubbleTimer: ReturnType<typeof setTimeout> | null = null
let randomTimer: ReturnType<typeof setInterval> | null = null
let transitionTimer: ReturnType<typeof setTimeout> | null = null // 行为链调度（scheduleTransition）
// Part A：陪伴交互状态
let reminderQueue: QueueState = createQueue()
let bigBubbleOn = false
let bigBubbleTimer: ReturnType<typeof setTimeout> | null = null
let soundEnabled = true
let focusOn = false
const alphaMaps: Record<string, Uint8ClampedArray> = {}
let lastBubble = ''
let noReactUntil = 0
const BUBBLE_MS = 3000         // 普通气泡 3 秒（PRD：3 秒内消失）
const BIG_COLLAPSE_MS = 10000  // 大气泡 10 秒后收成小胶囊，但不丢提醒
// 渲染进程跟踪的窗口状态（初始 = 主进程创建尺寸/位置；本地维护，避免异步竞态漂移）
let curWinW = 320
let curWinH = 320
let curWinX = 0
let curWinY = 0

const WINDOW_W = 320
const WINDOW_H = 320
const BUBBLE_TEXTS = ['汪！', '摸摸我～', '今天也要开心哦！', '饿了…有吃的吗？', '(*^▽^*)']

// ================= 初始化 =================
async function init() {
  await app.init({
    backgroundAlpha: 0,
    antialias: true,
    resizeTo: window,
    resolution: Math.min(window.devicePixelRatio || 1, 2)
  })
  document.getElementById('stage')?.replaceWith(app.canvas)
  app.canvas.style.width = '100%'
  app.canvas.style.height = '100%'
  app.canvas.style.display = 'block'
  app.canvas.classList.add('pet-canvas') // 弹跳/抖动动效挂在这（见 style.css）
  // P2-3: 可访问性——canvas 角色标注（屏幕阅读器能读出这是桌宠）
  app.canvas.setAttribute('role', 'img')
  app.canvas.setAttribute('aria-label', pet?.name ? `${pet.name}（桌面宠物）` : '桌面宠物')

  // 拖拽移动窗口
  let dragging = false
  let startScreen = { x: 0, y: 0 }
  let winStart = { x: 0, y: 0 }

  app.canvas.addEventListener('pointerdown', async (e) => {
    dragging = true
    unlockAudio(dingUrl) // 首次手势解锁音频（自动播放策略的双保险之一）
    startScreen = { x: e.screenX, y: e.screenY }
    winStart = await window.petAPI.getWindowPosition()
    app.canvas.setPointerCapture(e.pointerId)
  })

  // 拖拽移动窗口（同步本地位置跟踪，供缩放中心计算使用）
  app.canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const nx = winStart.x + (e.screenX - startScreen.x)
    const ny = winStart.y + (e.screenY - startScreen.y)
    curWinX = Math.round(nx)
    curWinY = Math.round(ny)
    window.petAPI.moveWindow(Math.round(nx), Math.round(ny))
  })

  app.canvas.addEventListener('pointerup', () => { dragging = false })
  app.canvas.addEventListener('pointercancel', () => { dragging = false })

  // 鼠标穿透（借鉴 bitnp）：透明区穿透桌面，宠物区可交互
  // forward=true 让穿透时仍能收到 mousemove，从而检测鼠标进入宠物区
  // 方案B：面板/提醒条/菜单打开时，其区域也保持可交互
  let lastIgnore: boolean | null = null
  function uiRects() {
    const out: { x: number; y: number; w: number; h: number }[] = []
    for (const el of [
      document.getElementById('reminder-panel'),
      document.getElementById('big-bubble') // 提醒气泡里有 [已完成] 按钮，必须可点
    ]) {
      if (el && !el.classList.contains('hidden')) {
        const r = el.getBoundingClientRect()
        out.push({ x: r.x, y: r.y, w: r.width, h: r.height })
      }
    }
    document.querySelectorAll('.pet-menu').forEach(el => {
      const r = el.getBoundingClientRect()
      out.push({ x: r.x, y: r.y, w: r.width, h: r.height })
    })
    return out
  }
  function updateMouseIgnore(e: PointerEvent) {
    if (dragging) return // 拖拽中强制交互
    const x = e.clientX
    const y = e.clientY
    const onSprite = sprite ? sprite.getBounds().containsPoint(x, y) : false
    const onUI = uiRects().some(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
    const shouldIgnore = !(onSprite || onUI)
    if (shouldIgnore !== lastIgnore) {
      lastIgnore = shouldIgnore
      window.petAPI.setIgnoreMouse(shouldIgnore, true)
    }
  }
  // R-3: document capture 监听已覆盖 canvas 上所有移动，删掉 canvas 冗余绑定（避免每次移动走两遍 uiRects 回流）
  document.addEventListener('pointermove', updateMouseIgnore, true)
  // 初始穿透
  setTimeout(() => window.petAPI.setIgnoreMouse(true, true), 300)

  // 单击 = 互动：点头部摸头 / 点身体喂食 / 点透明区无反应（Part A）
  // 功能入口：托盘 + 右键菜单（原生菜单，自动毛玻璃/定位）
  let downPos = { x: 0, y: 0 }
  let lastPointerUp = 0
  app.canvas.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY } })
  app.canvas.addEventListener('pointerup', (e) => {
    lastPointerUp = Date.now()
    if (e.button !== 0) return // 只处理左键（右键走 contextmenu 菜单）
    const dist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y)
    if (dist < 6) void handlePetClick(e.clientX, e.clientY)
  })

  // 右键 → 原生 macOS 菜单（主进程 Menu.popup，自动毛玻璃/定位）
  app.canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    window.petAPI.showContextMenu(e.screenX, e.screenY)
  })

  // 滚轮/触摸表面缩放（Magic Mouse 表面滑动 = 滚动事件，极易误触）
  // 三重防误触：
  // 1. ctrlKey（智能缩放/双指双击）→ 忽略
  // 2. 点击后 250ms 内的滚动 → 忽略
  // 3. 累积式：滚动位移累积到阈值才缩放一档（点击抖动 dY<5、短滑、方向抖动都不会触发）
  let wheelAccum = 0
  let wheelLastTs = 0
  const WHEEL_SCROLL_THRESHOLD = 40
  app.canvas.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return
    if (Date.now() - lastPointerUp < 250) return
    e.preventDefault()
    const now = Date.now()
    if (now - wheelLastTs > 300) wheelAccum = 0 // 滚动停顿后重置累积
    wheelLastTs = now
    wheelAccum += e.deltaY
    while (Math.abs(wheelAccum) >= WHEEL_SCROLL_THRESHOLD) {
      applyZoom(wheelAccum < 0 ? 1.08 : 1 / 1.08)
      wheelAccum -= Math.sign(wheelAccum) * WHEEL_SCROLL_THRESHOLD
    }
  }, { passive: false })

  // 双击 → 恢复默认大小（绝不缩小）
  app.canvas.addEventListener('dblclick', (e) => {
    e.preventDefault()
    resetZoom()
  })

  // 托盘事件
  window.petAPI.onZoom((f) => applyZoom(f))
  window.petAPI.onReset(() => resetZoom())

  // 测试：切换动作
  window.petAPI.onTestAction((name) => requestAction(name, 'menu'))

  // 托盘菜单切换动作（7/31 恢复旧版功能）
  window.petAPI.onAction((name) => requestAction(name, 'menu'))

  // 记录初始窗口位置（缩放中心计算基准）
  try {
    const pos = await window.petAPI.getWindowPosition()
    curWinX = pos.x
    curWinY = pos.y
  } catch (err) {
    console.error('获取窗口位置失败', err)
  }

  // P0-1：发现宠物，而非硬编码 redshao（listPets 终于被调用）
  let pets: string[] = []
  try {
    pets = await window.petAPI.listPets()
  } catch (err) {
    console.error('listPets 失败', err)
  }
  if (pets.length === 0) {
    // P0（2026-08-09）：Windows 用户看不懂 ~ 路径（老坑复发）——按平台显示实际路径
    const petsPath = navigator.userAgent.includes('Windows')
      ? '%USERPROFILE%\\.petpet\\pets'
      : '~/.petpet/pets'
    showFatal(`没有找到宠物包。请创建 ${petsPath}/<宠物名>/pet.json（格式见 docs/08-接口协议.md）`)
    return
  }
  petId = pets[0]
  await loadPet(petId)
  // 多宠：托盘菜单支持切换（主进程已构建切换子菜单）
  window.petAPI.onPetSwitch((id) => {
    loadPet(id).catch(err => showFatal(err.message))
  })
  setupUI()
  startRandomBehavior()
}

// ================= 宠物加载 =================
async function loadPet(id: string) {
  // N-1：先释放上一只宠物的 GPU 资源（P0-1 修复引入的回归：只丢引用不释放显存）
  // 必须在 textures = {} 之前——否则对象被替换后 GC 够不着（Assets 缓存持有强引用）
  if (sprite) { sprite.destroy(); sprite = null }
  for (const frames of Object.values(textures)) {
    for (const f of frames) f.destroy()   // Texture.destroy() 连 TextureSource 一起销毁
  }
  textures = {}
  // 切换宠物/动作时取消挂起的转移调度（防止旧宠物转移定时器在新宠物上触发）
  if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null }

  petId = id
  const data = await window.petAPI.loadPet(id)
  if (!data || data.error) {
    // P0-2：不再静默失败，抛出给顶层 catch → 可见错误卡片
    const msg = data?.error || `宠物 ${id} 加载失败：pet.json 缺失或无法解析`
    throw new Error(msg)
  }
  pet = data
  // P2-3: 宠物加载后更新 canvas 的 aria-label（init 时 pet 还未加载）
  if (app.canvas) {
    app.canvas.setAttribute('aria-label', `${pet.name}（桌面宠物）`)
  }
  // theme 为契约元数据字段（schema/docs 保留，供未来换肤）；当前版本不参与渲染——
  // 不设置幽灵 data-theme（无 CSS 消费，设置只会误导审计为"功能存在"）
  // 通知主进程当前宠物（托盘动作菜单用）
  window.petAPI.notifyPetLoaded(id)

  const names = Object.keys(pet.actions)
  // N-2：先加载首个动作 → 立刻有画面，其余后台补（此前 await Promise.all 全部加载完才画第一帧，冷启动秒级空窗）
  await loadAction(names[0])
  playAction(names[0], 'init') // 初始加载：直接播放（不经仲裁，init 语义）
  void Promise.all(names.slice(1).map(loadAction))  // 其余不阻塞首帧
  updateTitle()
}

// 加载单个动作的精灵表 → 切片 → 存入 textures[name]
async function loadAction(name: string) {
  if (!pet) return
  const act = pet.actions[name]
  const rel = act.file || act.sprite
  if (!rel || textures[name]) return
  // N-3：优先 petpet:// 协议短 URL（零 base64、流式读盘、Assets 缓存键稳定）；
  // 协议不可用时回退 dataURL（getFile 保留 IPC 兼容路径）
  const url = `petpet://${petId}/${rel}`
  let tex: PIXI.Texture
  try {
    tex = await PIXI.Assets.load(url)
  } catch (e) {
    console.warn(`动作 ${name} 协议加载失败，回退 IPC: ${e}`)
    const res = await window.petAPI.getFile(petId, rel)
    if (!res.dataUrl) {
      console.warn(`动作 ${name} 精灵表加载失败: ${res.error}`)
      return
    }
    tex = await PIXI.Assets.load(res.dataUrl)
  }
  const cw = act.frameWidth || pet!.cellWidth
  const ch = act.frameHeight || pet!.cellHeight
  const cols = Math.max(1, Math.floor(tex.width / cw))
  const frames: PIXI.Texture[] = []
  for (let i = 0; i < act.frames; i++) {
    const col = i % cols
    frames.push(new PIXI.Texture({
      source: tex.source,
      frame: new PIXI.Rectangle(col * cw, 0, cw, ch)
    }))
  }
  textures[name] = frames
  // Part A：为命中判定预生成 64×64 alpha 缩略图（每动作一张，取首帧）
  buildAlphaMapFor(name, frames[0])
}

/**
 * 从动作首帧生成 alpha 缩略图，供"点透明区不响应"使用。
 * 失败（纹理源不可绘制/跨源限制）则静默跳过，判定退化为只按区域。
 */
function buildAlphaMapFor(name: string, tex: PIXI.Texture | undefined) {
  if (!tex || alphaMaps[name]) return
  try {
    const src = tex.source.resource as unknown as CanvasImageSource | undefined
    if (!src) return
    const size = 64
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    const f = tex.frame
    ctx.clearRect(0, 0, size, size)
    ctx.drawImage(src, f.x, f.y, f.width, f.height, 0, 0, size, size)
    const rgba = ctx.getImageData(0, 0, size, size).data
    alphaMaps[name] = buildAlphaMap(rgba, size, size, size)
  } catch (e) {
    console.warn(`[PetPet] alpha 缩略图生成失败（${name}），命中判定退化为区域判定`, e)
  }
}

function updateTitle() {
  if (pet) document.title = `PetPet - ${pet.name}`
}

// ================= 动作播放 =================
// 动作请求仲裁：所有触发源统一走这里（P0 状态仲裁层）
// - menu/init：用户主动/初始加载 → 直接执行
// - reminder：提醒必须显示 → 直接执行
// - random：随机行为 → 仅在待机时允许（不再打断任何动作）
function requestAction(name: string, source: 'menu' | 'reminder' | 'random' | 'init' | 'transition' = 'menu') {
  if (!pet || !textures[name] || textures[name].length === 0) return
  if (!shouldPlay({ name, source }, currentAction)) return
  playAction(name, source)
}

function playAction(name: string, source: 'menu' | 'reminder' | 'random' | 'init' | 'transition' = 'menu') {
  if (!pet || !textures[name] || textures[name].length === 0) return
  // P1-7: 随机行为不写日记（12s 一条会把 100 条日记 20 分钟冲光）——只有用户主动/提醒才记录
  if (source !== 'random' && name !== 'idle' && name !== currentAction) logActionActivity(name)
  // 动作切换 → 通知主进程同步日记「当前状态」（idle 也用固定文案）
  const actT = resolveActionDiary(name)
  window.petAPI.notifyAction(actT
    ? { mood: actT.mood, text: actT.text.replace('{name}', petDisplayName()) }
    : { mood: '待机', text: `${petDisplayName()}安安静静地待着，等你来摸～` })
  const act = pet.actions[name]
  const frames = textures[name]

  if (sprite) {
    sprite.destroy()
    sprite = null
  }

  sprite = new PIXI.AnimatedSprite(frames)
  sprite.anchor.set(0.5)
  sprite.animationSpeed = (act.fps || 4) / 60
  sprite.loop = act.loop !== false
  pingpongDir = 1

  if (act.pingpong) {
    // 往返播放：播完一 cycle 反向
    sprite.on('loop', () => {
      if (!sprite) return
      pingpongDir *= -1
      sprite.animationSpeed = Math.abs(sprite.animationSpeed) * pingpongDir
    })
  }

  app.stage.addChild(sprite)
  currentAction = name
  applyScale()
  sprite.play()
  // 行为链调度：仅自动行为源（random/transition）挂转移定时器——
  // 用户手动/提醒进入的动作不设转移（state-priority 设计意图：手动切换不被自动打断）
  if (source === 'random' || source === 'transition') scheduleTransition(name)
}

// 缩放约束：0.5x ~ 2x（窗口跟随缩放，永远完整显示全身，不裁切）
const ZOOM_MIN = 0.5
const ZOOM_MAX = 2

async function applyScale() {
  if (!sprite) return
  // 8/5 v2：窗口尺寸只随缩放（baseScale）变化，与动作无关 → 切换动作零跳变（修复"切换时窗口闪烁/动作消失"感）
  // 帧尺寸优先取当前动作帧的真实纹理尺寸（Pixi v8 的 FrameObject 无 width/height，需类型收窄）
  const firstTex = sprite.textures[0]
  const fw = (firstTex && 'width' in firstTex ? (firstTex as PIXI.Texture).width : undefined) || pet?.cellWidth || 250
  const fh = (firstTex && 'height' in firstTex ? (firstTex as PIXI.Texture).height : undefined) || pet?.cellHeight || 250
  const fit = Math.min(WINDOW_W / fw, WINDOW_H / fh)  // 固定 320 基准，不随窗口变化
  const act: PetActionSpec = pet?.actions?.[currentAction] || { frames: 0 }
  const actScale = act.scale || 1

  // 窗口 = 初始尺寸 × baseScale（与动作无关），但**不缩到基准尺寸以下**：
  // 提醒面板 / 大气泡这些 UI 需要 ~304px 宽度，窗口一缩小就会被裁掉。
  // 放大仍然生效（>1 时窗口跟着长），缩小只缩精灵、保留足够画布。
  const newW = Math.max(WINDOW_W, Math.round(WINDOW_W * baseScale))
  const newH = Math.max(WINDOW_H, Math.round(WINDOW_H * baseScale))
  sprite.scale.set(baseScale * fit * actScale)
  sprite.position.set(newW / 2, newH / 2)

  // 缩放交给主进程：它知道窗口的真实 bounds，按中心缩放后夹回工作区并回传结果。
  // 渲染层不再自己算位置——之前正是"渲染层假设的尺寸"和"实际窗口"不一致，把窗口推到了屏幕外。
  // 尺寸没变就别发 IPC：切换动作会频繁调用本函数，每次都让主进程 setBounds 是白噪声（日志也会刷屏）。
  if (newW === curWinW && newH === curWinH) return
  const applied = await window.petAPI.scaleTo(newW, newH)
  if (applied) {
    curWinX = applied.x
    curWinY = applied.y
    curWinW = applied.width
    curWinH = applied.height
  }
}

function applyZoom(factor: number) {
  const prev = baseScale
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, baseScale * factor))
  baseScale = next
  try { localStorage.setItem('petpet:scale', String(next)) } catch { /* ignore */ }  // P2-8
  // P2-9: 到边界给反馈（静默钳制让人困惑：继续滚什么都没发生）
  if (next === prev) {
    showBubbleText(next >= ZOOM_MAX ? '已经是最大啦 🐾' : '已经最小啦 🐾')
  } else {
    applyScale()
  }
}

function resetZoom() {
  baseScale = 0.9
  try { localStorage.setItem('petpet:scale', '0.9') } catch { /* ignore */ }  // P2-8
  applyScale()
}

// ================= 气泡 =================
/**
 * 显示一条气泡。
 * @param text  指定文案（省略则按 scene 从人格池里抽）
 * @param scene 互动场景（head/feed/water/focusEnd）——用 persona 选池，缺省回退 bubbles
 */
function showBubbleText(text?: string, scene?: BubbleScene) {
  const bubble = document.getElementById('bubble')!
  const pool = bubblePool()
  const picked = text
    || (scene ? pickBubble(pet?.persona, scene, Math.random, lastBubble) : undefined)
    || pool[Math.floor(Math.random() * pool.length)]
  lastBubble = picked
  bubble.textContent = picked
  bubble.classList.remove('hidden')
  bubble.style.left = '50%'
  bubble.style.top = '8px'
  bubble.style.transform = 'translateX(-50%)'

  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => {
    bubble.classList.add('hidden')
  }, BUBBLE_MS)
}

// ================= 红苕日记（方案B） =================
// 动作 → 心情 + 文案（{name} 运行时替换为宠物名，不再硬编码红苕）
const ACTIVITY_TEXTS: Record<string, { mood: string; text: string }> = {
  sleep:   { mood: '安逸', text: '{name}蜷成一团睡着了，呼噜声轻轻的。' },
  sniff:   { mood: '好奇', text: '{name}凑近嗅了嗅，鼻头湿漉漉的。' },
  wiggle:  { mood: '开心', text: '{name}扭着屁股撒欢，尾巴摇成小风扇。' },
  run:     { mood: '兴奋', text: '{name}嗖地窜了出去，一溜烟就没影了。' },
  knead:   { mood: '满足', text: '{name}踩奶踩得入迷，前爪一按一按的。' },
  belly:   { mood: '惬意', text: '{name}翻出肚皮晒太阳，毫无防备。' },
  poop:    { mood: '心虚', text: '{name}先转着圈圈踩好位置，解决完就撒欢跑开了。' },
  stretch: { mood: '舒坦', text: '{name}伸了个大大的懒腰，爪子张得开花。' }
}

// ================= 文案数据优先（v3 数据下沉） =================
// pet.json 的 bubbles / diary / label 优先，代码常量仅作兜底（docs/08 §2.2）
function bubblePool(): string[] {
  return pet?.bubbles && pet.bubbles.length > 0 ? pet.bubbles : BUBBLE_TEXTS
}

function resolveActionDiary(name: string): { mood: string; text: string } | undefined {
  const d = pet?.actions?.[name]?.diary
  if (d && d.mood && d.text) return d
  return ACTIVITY_TEXTS[name]
}

function petDisplayName(): string {
  return pet?.name || '宠物'
}

function logActionActivity(name: string) {
  const t = resolveActionDiary(name)
  if (!t) return
  window.petAPI.appendActivity({ petId, mood: t.mood, text: t.text.replace('{name}', petDisplayName()) })
}


// ================= 左键分区：摸头 / 喂食（Part A） =================
async function handlePetClick(x: number, y: number) {
  if (!sprite || !pet) return
  if (Date.now() < noReactUntil) return // 弹跳/抖动进行中忽略，避免误触与判定漂移
  const b = sprite.getBounds()
  // 指针是视口坐标，sprite.getBounds() 是布局坐标：动效（呼吸/平移）作用在 .pet-stage 上，
  // 必须按 canvas 的实际缩放换回布局坐标，否则头/身边界会错几个像素
  const el = app.canvas as HTMLCanvasElement
  const rect = el.getBoundingClientRect()
  const p = toLayoutPoint({
    clientX: x, clientY: y,
    rectLeft: rect.left, rectTop: rect.top, rectWidth: rect.width, rectHeight: rect.height,
    layoutWidth: el.clientWidth || el.width || rect.width,
    layoutHeight: el.clientHeight || el.height || rect.height
  })
  const region = resolveHit(
    { x: b.x, y: b.y, width: b.width, height: b.height },
    p.x, p.y,
    alphaMaps[currentAction] || null
  )
  console.debug('[PetPet][命中]', JSON.stringify({
    x: Math.round(p.x), y: Math.round(p.y),
    bounds: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
    hasAlpha: !!alphaMaps[currentAction], action: currentAction, region
  }))
  if (!region) return // 点到透明区：不响应（不冒泡、不加数值）
  if (region === 'head') await interactHead()
  else await interactFeed()
}

/** 饱腹/心情告急时，气泡优先说这件事（"瘫倒喊饿"必须真的喊出来） */
function urgentBubble(): string {
  return expressionOf(lastStats).bubble
}

/** 摸头：弹跳 + 人格气泡 + 心情 +5（每日封顶 15，由主进程判定） */
async function interactHead() {
  bouncePet()
  const r = await statsPatch({ mood: 5 })
  const capped = !!r?.capped?.mood
  const urgent = urgentBubble()
  if (urgent) return showBubbleText(urgent, 'head')
  showBubbleText(capped ? '今天摸够啦，明天再来～' : undefined, 'head')
}

/** 喂食：人格气泡 + 饱腹 +20（封顶 100） */
async function interactFeed() {
  const r = await statsPatch({ feed: true })
  const capped = !!r?.capped?.satiety
  const urgent = urgentBubble()
  if (urgent) return showBubbleText(urgent, 'feed')
  showBubbleText(capped ? '已经吃得饱饱的啦' : undefined, 'feed')
}

function bouncePet() {
  const c = app.canvas as HTMLCanvasElement
  noReactUntil = Date.now() + 220
  c.classList.remove('pp-bounce')
  void c.offsetWidth // 强制重排，让同名动画能重播
  c.classList.add('pp-bounce')
  window.setTimeout(() => c.classList.remove('pp-bounce'), 220)
}

function shakePet() {
  const c = app.canvas as HTMLCanvasElement
  noReactUntil = Date.now() + 420
  c.classList.remove('pp-shake')
  void c.offsetWidth
  c.classList.add('pp-shake')
  window.setTimeout(() => c.classList.remove('pp-shake'), 420)
}

/** 数值更新：B 组未就绪时静默降级（不弹错、不打断互动） */
// ===== 数值 → 表现（饱腹<30 瘫倒、>80 跳跃；心情<30 乌云、>80 爱心）=====
let lastStats: { mood: number; satiety: number } | null = null

// ===== 爱心喷发（心情 > 80）：10 秒内从头心持续喷出爱心，飞出去的过程中快速淡出 =====
let heartTimers: number[] = []
let heartBurstOn = false
let heartBurstDone = false

function stopHeartBurst() {
  heartTimers.forEach((t) => window.clearTimeout(t))
  heartTimers = []
  heartBurstOn = false
  const host = document.getElementById('pet-hearts')
  if (host) host.innerHTML = ''
}

function spawnHeart(p: ReturnType<typeof heartBurstSpec>[number]) {
  const host = document.getElementById('pet-hearts')
  if (!host || !heartBurstOn) return
  const el = document.createElement('span')
  el.className = 'pp-heart'
  el.textContent = HEART_GLYPH
  el.style.fontSize = `${p.size}px`
  el.style.left = `calc(50% + ${p.x}px)`
  el.style.top = '42%'
  host.appendChild(el)

  const end = heartEnd(p)
  // 透明度按 heartOpacity 曲线取样，保证"15% 之后快速变淡、70% 处彻底消失"
  const samples = [0, 0.15, 0.3, 0.45, 0.6, 0.7, 1]
  const frames = samples.map((t) => ({
    offset: t,
    opacity: heartOpacity(t) * (t === 0 ? 0 : 1),
    transform: `translate(calc(-50% + ${Math.round(end.x * t + p.sway * Math.sin(t * Math.PI))}px), calc(-50% + ${Math.round(end.y * t)}px)) scale(${(0.65 + 0.35 * t).toFixed(2)}) rotate(${Math.round(p.rotate * t)}deg)`
  }))
  // 第一帧从 0 透明度起步（避免"啪"地出现），t=0 的 offset 必须是 0
  frames[0].opacity = 0

  const anim = el.animate(frames, { duration: p.life, easing: 'linear', fill: 'forwards' })
  anim.onfinish = () => el.remove()
  window.setTimeout(() => el.remove(), p.life + 120)
}

/** 开始一次 10 秒喷发（只在高心情状态下触发；重复调用不会叠加） */
function startHeartBurst() {
  if (heartBurstOn) return
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // 减少动态偏好：不喷发，直接留一个静态爱心
    heartBurstDone = true
    return
  }
  heartBurstOn = true
  heartBurstDone = false
  const particles = heartBurstSpec({ durationMs: HEART_BURST_MS })
  for (const p of particles) {
    const t = window.setTimeout(() => spawnHeart(p), p.startAt)
    heartTimers.push(t)
  }
  // 喷发结束后收尾：停表、清层，并把"状态徽标"留成一个小爱心
  const done = window.setTimeout(() => {
    stopHeartBurst()
    heartBurstDone = true
    const badge = document.getElementById('pet-overlay')
    if (badge) {
      badge.textContent = HEART_GLYPH
      badge.classList.remove('hidden')
    }
  }, HEART_BURST_MS + 50)
  heartTimers.push(done)
}

function applyPetExpression(next: { mood?: number; satiety?: number } | null | undefined, opts: { bubble?: boolean } = {}) {
  if (!next) return
  const expr = expressionOf(next)
  const stage = document.getElementById('petStage')
  if (stage) {
    stage.classList.toggle('pp-collapsed', expr.collapsed)
    stage.classList.toggle('pp-jump', expr.jump)
    stage.classList.toggle('pp-sad', expr.moodFace === 'sad')
  }
  const overlay = document.getElementById('pet-overlay')
  if (overlay) {
    // 爱心走"喷发"，静态徽标只留乌云；喷发结束再补一枚小爱心示意状态
    overlay.textContent = expr.overlay === 'cloud' ? '☁️' : expr.overlay === 'hearts' && heartBurstDone ? HEART_GLYPH : ''
    overlay.classList.toggle('hidden', !overlay.textContent)
  }
  if (expr.overlay === 'hearts') startHeartBurst()
  else if (heartBurstOn) stopHeartBurst()
  // 只在"跨过阈值"时冒一次气泡，避免每次 +5 都刷屏
  if (opts.bubble !== false) {
    const text = thresholdBubble(lastStats, next)
    if (text) showBubbleText(text)
  }
  lastStats = { mood: Number(next.mood) || 0, satiety: Number(next.satiety) || 0 }
}

async function loadStatsOnce() {
  if (!petId) return
  try {
    const r = await window.petAPI.statsGet(petId)
    if (r && r.ok) applyPetExpression(r.state, { bubble: false })
  } catch { /* 老包没有数值时忽略 */ }
}

async function statsPatch(delta: StatsDelta): Promise<StatsResponse | null> {
  if (!petId) return null
  try {
    const api = window.petAPI
    if (typeof api.statsPatch !== 'function') return null
    const r = await api.statsPatch(petId, delta)
    if (r && r.ok) applyPetExpression(r.state)
    return r && r.ok ? r : null
  } catch (e) {
    console.warn('[PetPet] 数值更新失败（不影响互动）', e)
    return null
  }
}

async function refreshPrefs() {
  try {
    const p = await window.petAPI.prefsGet()
    soundEnabled = !p || p.sound !== false
  } catch {
    soundEnabled = true
  }
  const cb = document.getElementById('reminder-sound') as HTMLInputElement | null
  if (cb) cb.checked = soundEnabled
}

/** 专注钩子（B 组通过 focus:state 触发；当前无发送方时是空转） */
function setFocusState(entering: boolean) {
  focusOn = entering
  const fx = applyFocusState(entering)
  const stage = document.getElementById('petStage')
  if (stage) stage.classList.toggle('is-focused', fx.resting)
  if (app.canvas) app.canvas.setAttribute('aria-label', focusLabel(entering, petDisplayName()))
}

// ================= 提醒系统（方案B） =================
function openReminderPanel() {
  document.getElementById('reminder-panel')!.classList.remove('hidden')
  const input = document.getElementById('reminder-input') as HTMLInputElement
  input.value = ''
  input.focus()
  void refreshPrefs()
}

function closeReminderPanel() {
  document.getElementById('reminder-panel')!.classList.add('hidden')
}

async function submitReminder() {
  const input = document.getElementById('reminder-input') as HTMLInputElement
  const raw = input.value.trim()
  if (!raw) return
  const spec = parseReminder(raw)
  if (!spec) {
    showBubbleText('我听不懂这个时间…试试「一分钟后提醒我喝水」')
    return
  }
  const res = await window.petAPI.setReminder({ at: spec.at, repeat: spec.repeat, text: spec.text, kind: 'custom' })
  if (res && res.error) {
    showBubbleText('这个时间有点奇怪，换个说法试试？')
    return
  }
  closeReminderPanel()
  // P1-2: 回执回显解析结果——"每天 10:30 叫你「吃药」"，用户当场核对，解析 bug 不再隐藏
  const d = new Date(spec.at)
  const p = (n: number) => String(n).padStart(2, '0')
  const when = `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
  const repeatLabel = spec.repeat === 'daily' ? '（每天）' : spec.repeat === 'weekly' ? '（每周）' : ''
  showBubbleText(`好哦，${when}叫你「${spec.text}」${repeatLabel}`)
  window.petAPI.appendActivity({ petId, mood: '答应', text: `${petDisplayName()}答应提醒你：${when} ${spec.text}${repeatLabel}` })
}

/** 快捷提醒：喂食 / 喂水（1 小时后，一次性） */
async function submitQuickReminder(kind: 'feed' | 'water') {
  const name = petDisplayName()
  const at = Date.now() + 3600_000
  const text = kind === 'feed' ? `该给${name}喂饭啦` : `该给${name}换水啦`
  const res = await window.petAPI.setReminder({ at, repeat: 'none', text, kind })
  if (res && res.error) {
    showBubbleText('设置失败了，稍后再试')
    return
  }
  closeReminderPanel()
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  const when = `${p(d.getHours())}:${p(d.getMinutes())}`
  showBubbleText(`好哦，${when} 提醒你${kind === 'feed' ? '喂饭' : '换水'}`)
  window.petAPI.appendActivity({ petId, mood: '答应', text: `${name}答应提醒你：${when} ${text}` })
}

function normalizeKind(k?: string): ReminderEntry['kind'] {
  return k === 'feed' || k === 'water' ? k : 'custom'
}

/**
 * 提醒到点：入队 → 大气泡 + 抖动 + 音效（三件套）。
 * 多条同时到点时排队，气泡上显示「还有 N 条」，不会丢提醒。
 */
function handleReminderFire(r: { id: string; text: string; kind?: string; sound?: boolean }) {
  reminderQueue = enqueue(reminderQueue, { id: r.id, text: r.text, kind: normalizeKind(r.kind) })
  renderBigBubble()
  shakePet()
  void playReminderSound(r.sound !== false)
  requestAction('wiggle', 'reminder') // 提醒时扭两下，不打扰地刷存在感（reminder 源优先，可打断当前动作）
}

async function playReminderSound(enabled: boolean = soundEnabled) {
  if (!enabled) {
    window.petAPI.reportAudio('skipped', '提示音已关闭')
    return
  }
  const status = await playDing(dingUrl)
  window.petAPI.reportAudio(status, status === 'played' ? 'ding.wav' : 'play() 被拒绝（自动播放策略）')
}

function renderBigBubble() {
  const el = document.getElementById('big-bubble')!
  const cur = currentOf(reminderQueue)
  if (!cur) {
    bigBubbleOn = false
    el.classList.add('hidden')
    el.classList.remove('bb-collapsed')
    if (bigBubbleTimer) { clearTimeout(bigBubbleTimer); bigBubbleTimer = null }
    return
  }
  bigBubbleOn = true
  const icon = cur.kind === 'feed' ? '🍚' : cur.kind === 'water' ? '💧' : '⏰'
  const iconEl = document.getElementById('big-bubble-icon')
  const miniEl = document.getElementById('big-bubble-mini')
  const textEl = document.getElementById('big-bubble-text')
  const moreEl = document.getElementById('big-bubble-more')
  if (iconEl) iconEl.textContent = icon
  if (miniEl) miniEl.textContent = icon
  if (textEl) textEl.textContent = cur.text
  const n = pendingCount(reminderQueue)
  if (moreEl) {
    moreEl.textContent = n > 0 ? `还有 ${n} 条` : ''
    moreEl.classList.toggle('hidden', n === 0)
  }
  el.classList.remove('hidden', 'bb-collapsed')
  if (bigBubbleTimer) clearTimeout(bigBubbleTimer)
  // 10 秒后收起成小胶囊：不打扰看宠物，但提醒不会丢（点一下可展开）
  bigBubbleTimer = setTimeout(() => el.classList.add('bb-collapsed'), BIG_COLLAPSE_MS)
}

function expandBigBubble() {
  const el = document.getElementById('big-bubble')
  if (!el || el.classList.contains('hidden')) return
  el.classList.remove('bb-collapsed')
  if (bigBubbleTimer) clearTimeout(bigBubbleTimer)
  bigBubbleTimer = setTimeout(() => el.classList.add('bb-collapsed'), BIG_COLLAPSE_MS)
}

/** [已完成]：打卡 + 出队；还有下一条则自动顶上 */
async function completeCheckin() {
  const cur = currentOf(reminderQueue)
  if (!cur) return
  // 先回执：主进程据此取消"1 分钟没点就扣分"的计时器
  try { window.petAPI.reminderAck(cur.id) } catch { /* 老版本没有这个通道 */ }
  reminderQueue = dismiss(reminderQueue)
  const r = await statsPatch({ checkin: true })
  const more = pendingCount(reminderQueue)
  renderBigBubble()
  if (more === 0) {
    const urgent = urgentBubble()
    showBubbleText(urgent || (r ? '吃饱啦，谢谢主人！' : '收到啦！'), 'feed')
  }
}

function openDiary() {
  // 日记面板是独立小窗口（主进程管理），避免在宠物窗口内遮挡宠物
  window.petAPI.openDiary(petId)
}

// P1-5: 删除幽灵换肤（switchTheme 无调用者、无 CSS 消费 data-theme）

function setupUI() {
  const input = document.getElementById('reminder-input') as HTMLInputElement
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submitReminder()
    } else if (e.key === 'Escape') {
      closeReminderPanel()
    }
  })
  document.getElementById('reminder-ok')!.addEventListener('click', submitReminder)
  document.getElementById('reminder-cancel')!.addEventListener('click', closeReminderPanel)
  window.petAPI.onReminderFire((r) => handleReminderFire(r))
  // 托盘兜底入口：提醒面板（右键手势不可用时）
  window.petAPI.onOpenReminder(() => openReminderPanel())
  // P2-5: 窗口隐藏时暂停动画（省电）——恢复时继续
  window.petAPI.onVisibility((visible) => {
    if (!visible) stopHeartBurst()
    if (visible) {
      app.ticker.start()
    } else {
      app.ticker.stop()
    }
  })

  // ---- Part A：提醒快捷入口 / 提示音开关 / 打卡按钮 ----
  const quick = document.getElementById('reminder-quick')
  quick?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-kind]') as HTMLElement | null
    const kind = btn?.dataset.kind
    if (kind === 'feed' || kind === 'water') void submitQuickReminder(kind)
  })

  const soundBox = document.getElementById('reminder-sound') as HTMLInputElement | null
  soundBox?.addEventListener('change', () => {
    soundEnabled = !!soundBox.checked
    void window.petAPI.prefsSet({ sound: soundEnabled })
    showBubbleText(soundEnabled ? '好，到点会响一声～' : '好，到点只抖不响')
  })

  document.getElementById('big-bubble-done')?.addEventListener('click', (e) => {
    e.stopPropagation() // 别让点击冒泡到"展开"处理
    void completeCheckin()
  })
  // 收起成小胶囊后点一下可展开
  document.getElementById('big-bubble')?.addEventListener('click', () => expandBigBubble())

  void loadStatsOnce() // 读取当前数值 → 应用瘫倒/跳跃/乌云/爱心

  // 专注钩子（B 组通过 focus:state 触发，本组只负责表现）
  window.petAPI.onFocusChange((entering) => setFocusState(entering))
  // 专注结束：主进程发一条唤醒气泡（文案由主进程给，渲染层不硬编码）
  window.petAPI.onBubble((text) => {
    if (text) showBubbleText(text)
  })
  // 喂食/喂水提醒 1 分钟内没点「已完成」：主进程扣分并广播，这里同步队列与表现
  window.petAPI.onReminderMissed((info) => {
    reminderQueue = dismiss(reminderQueue, info.id)
    renderBigBubble()
    if (info.state) applyPetExpression(info.state)
    shakePet()
    showBubbleText('等太久啦…有点难过', 'water')
  })
  void refreshPrefs()
}

// ================= 随机行为 =================
// P0：随机触发经 requestAction('random') 仲裁——只在待机时触发（守卫已在 shouldPlay），
// 且回 idle 带守卫：仅当“当前仍是本次随机动作”时才回（修复：用户/提醒打断后不再被强制拉回 idle）

// 统一行为链调度（替代原内联 4s 补丁）：
// 按时长 frames/fps 估算（钳制 2–12s）；到点且未被更高优先级动作打断时，
// 有 transitions 则按权重转移（transition 源），否则回 idle（init 源）
function scheduleTransition(name: string) {
  if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null }
  const act = pet?.actions?.[name]
  if (!act) return
  const durMs = Math.min(12000, Math.max(2000, ((act.frames || 1) / (act.fps || 4)) * 1000))
  transitionTimer = setTimeout(() => {
    transitionTimer = null
    if (!pet || focusOn || currentAction !== name) return
    const trans = act.transitions
    if (trans && Object.keys(trans).length > 0) {
      // 转移链：按权重选下一个动作（Shimeji NextBehaviorList 思路，docs/11 §2.1）
      const pool = Object.entries(trans).filter(([n, w]) => textures[n] && n !== name && w > 0)
      if (pool.length > 0) {
        const total = pool.reduce((s, [, w]) => s + w, 0)
        let r = Math.random() * total
        for (const [n, w] of pool) {
          r -= w
          if (r <= 0) { requestAction(n, 'transition'); return }
        }
      }
    }
    // 无转移链 → 回 idle（init 源，绕开 random 源互斥守卫）
    requestAction('idle', 'init')
  }, durMs)
}

function startRandomBehavior() {
  if (randomTimer) clearInterval(randomTimer)
  randomTimer = setInterval(() => {
    if (!pet) return
    // 8/5：自动演示只在待机状态触发——用户手动切换动作后锁定，验证/观看不被随机切换打断
    // P3-4: 提醒横幅显示期间也暂停随机行为（提醒是用户关注的焦点，宠物别抢戏）
    if (currentAction !== 'idle' || bigBubbleOn || focusOn) return
    const candidates = Object.entries(pet.actions).filter(([name, act]) => {
      return textures[name] && name !== currentAction && (act.weight ?? 0) > 0
    })
    if (candidates.length === 0) return

    const total = candidates.reduce((s, [n, a]) => s + effectiveWeight(n, a.weight ?? 0, pet?.temperament), 0)
    let r = Math.random() * total
    for (const [name, act] of candidates) {
      r -= effectiveWeight(name, act.weight ?? 0, pet?.temperament)
      if (r <= 0) {
        requestAction(name, 'random')
        break
      }
    }
  }, 12000)
}

// ================= 启动 =================
// P0-2：可见的错误反馈（不透明卡片，替代透明窗口里的静默失败）
function showFatal(msg: string) {
  const bubble = document.getElementById('bubble')!
  bubble.textContent = '⚠️ ' + msg
  bubble.classList.remove('hidden')
  bubble.style.background = 'rgba(255,255,255,0.98)'
  bubble.style.maxWidth = '280px'
  bubble.style.whiteSpace = 'normal'
}

init().catch(err => {
  console.error('PetPet 启动失败', err)
  showFatal(err?.message || '启动失败')
})
