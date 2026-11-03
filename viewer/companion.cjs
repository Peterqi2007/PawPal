// Part A：陪伴交互的主进程侧（偏好 / persona 回写 / 数值 IPC 门面）
//
// 契约出处：docs/handoff/README.md §5
//   C1  pet.json 可选 persona（装配后由 attachPersona 回写）
//   C2  ~/.petpet/state/<petId>.json —— 数值唯一真源（主进程 JSON + deviceId，不用 localStorage）
//   C3  IPC：stats:get / stats:patch / prefs:get / prefs:set
//
// 协作边界（合并 Part B 后）：
//   **数值状态机与落盘由 viewer/stats-store.cjs 提供**（B 组交付，含跨天重置、
//   摸头每日上限、打卡前 3 次计分、负向心情、原子写与坏档留证）。
//   本文件只保留 A 组独有的东西：偏好开关、音效日志、persona 回写，
//   外加一层薄的 delta 适配（把 A 的 {feed:true} 语义翻译成 stats-store 的增量口径），
//   避免两套规则并存导致"同一次点击加两次分"。
//
// 数值规则（以后者为准）：见 stats-store.cjs 顶部注释。
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const statsStoreModule = require('./stats-store.cjs')

const {
  DEFAULT_STATE,
  MOOD_DAILY_CAP,
  PAT_MOOD,
  FEED_SATIETY,
  CHECKIN_SATIETY,
  CHECKIN_MOOD,
  CHECKIN_SCORING,
  applyDelta,
  todayStr
} = statsStoreModule

const MOOD_INIT = DEFAULT_STATE.mood
const SATIETY_INIT = DEFAULT_STATE.satiety
const MOOD_MAX = 100
const SATIETY_MAX = 100
const PET_MOOD_GAIN = PAT_MOOD
const FEED_SATIETY_GAIN = FEED_SATIETY
const CHECKIN_SATIETY_GAIN = CHECKIN_SATIETY
const CHECKIN_MOOD_GAIN = CHECKIN_MOOD
const CHECKIN_DAILY_SCORING = CHECKIN_SCORING
const PERSONAS = ['温柔', '傲娇', '搞笑']
const PET_ID_RE = /^[a-z0-9_-]+$/

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

/** 全新的当日状态（deviceId 只生成一次，重置时保留） */
function newState(today) {
  return {
    date: today,
    mood: MOOD_INIT,
    satiety: SATIETY_INIT,
    checkins: 0,
    moodToday: 0,
    deviceId: crypto.randomUUID()
  }
}

/** 跨天重置：date 不匹配 → 回初始值（deviceId 保留，便于将来统计同设备） */
function dailyReset(state, today) {
  if (state && state.date === today) return { state, reset: false }
  const base = newState(today)
  if (state && typeof state.deviceId === 'string' && state.deviceId) base.deviceId = state.deviceId
  return { state: base, reset: true }
}

/**
 * A 的 delta 方言 → stats-store 的增量口径（纯函数）。
 * A: { feed?: true, checkin?: true, mood?: number }
 * B: { satiety?: number, mood?: number, checkin?: true }
 */
function normalizeDelta(delta) {
  const rejected = []
  if (!delta || typeof delta !== 'object') {
    return { toDelta: {}, rejected: ['delta 必须是对象'] }
  }
  const allowed = ['feed', 'checkin', 'mood', 'satiety', 'missPenalty']
  for (const key of Object.keys(delta)) {
    if (!allowed.includes(key)) rejected.push(key)
  }
  const toDelta = {}
  if (delta.feed === true) toDelta.satiety = (toDelta.satiety || 0) + FEED_SATIETY_GAIN
  if (delta.checkin === true) toDelta.checkin = true
  if (delta.missPenalty === true) toDelta.missPenalty = true
  if (typeof delta.satiety === 'number' && Number.isFinite(delta.satiety)) {
    toDelta.satiety = (toDelta.satiety || 0) + delta.satiety
  }
  if (typeof delta.mood === 'number' && Number.isFinite(delta.mood)) {
    toDelta.mood = delta.mood
  } else if ('mood' in delta) {
    rejected.push('mood')
  }
  return { toDelta, rejected }
}

/**
 * 应用一次数值变更（纯函数，node 直测）。
 * 规则全部委托 stats-store.applyDelta；这里只负责 A 的返回形状（applied/capped/rejected），
 * 调用方（日志、单测）不用关心底层换过实现。
 * @param {object} state  当前状态（已 ensureToday）
 * @param {object} delta  { feed?: true, checkin?: true, mood?: number, satiety?: number }
 * @returns {{state: object, applied: object, capped: object, rejected: string[]}}
 */
function applyStatsPatch(state, delta) {
  const { toDelta, rejected } = normalizeDelta(delta)
  const base = state && typeof state === 'object' ? state : newState(todayStr())
  const next = applyDelta(base, toDelta)
  const applied = {
    mood: (next.mood || 0) - (base.mood || 0),
    satiety: (next.satiety || 0) - (base.satiety || 0),
    checkins: (next.checkins || 0) - (base.checkins || 0)
  }
  const wantedMood = Number(toDelta.mood) || 0
  const capped = {
    // 封顶 或 当日摸头额度用尽（加不上去）都算 capped，调用方据此挑文案
    mood: next.mood >= MOOD_MAX || (wantedMood > 0 && applied.mood < wantedMood),
    satiety: next.satiety >= SATIETY_MAX
  }
  return { state: next, applied, capped, rejected }
}

/**
 * 数值存储（~/.petpet/state/<petId>.json）。
 * 落盘与原子写由 stats-store 负责；这里保持 A 的 {ok, state, applied, capped, rejected} 形状，
 * 并额外校验 petId（stats-store 会把非法 id 兜到 default，A 的调用方需要明确报错）。
 */
function createStatsStore({ root, now = () => new Date() }) {
  // root 就是 state 目录本身（A 的语义），显式传给 stats-store，避免它去猜父目录
  const store = statsStoreModule.createStatsStore({ stateDir: root, now })
  const pathOf = (petId) => path.join(root, `${petId}.json`)

  function read(petId) {
    if (!PET_ID_RE.test(String(petId || ''))) return { ok: false, error: '非法 petId' }
    // stats-store.get 会自动跨天重置并落盘；这里只需要把"发生了重置"如实报给调用方
    let prevDate = null
    try {
      const raw = JSON.parse(fs.readFileSync(pathOf(petId), 'utf-8'))
      prevDate = raw && raw.date ? String(raw.date) : null
    } catch {
      prevDate = null // 首次运行或坏档：交给 store 重建
    }
    const state = store.get(petId)
    return { ok: true, state, reset: prevDate !== null && prevDate !== todayStr(now()) }
  }

  function patch(petId, delta) {
    const cur = read(petId)
    if (!cur.ok) return cur
    const { toDelta, rejected } = normalizeDelta(delta)
    const before = cur.state
    const after = store.patch(petId, toDelta)
    const applied = {
      mood: (after.mood || 0) - (before.mood || 0),
      satiety: (after.satiety || 0) - (before.satiety || 0),
      checkins: (after.checkins || 0) - (before.checkins || 0)
    }
    const capped = { mood: after.mood >= MOOD_MAX, satiety: after.satiety >= SATIETY_MAX }
    return { ok: true, state: after, applied, capped, rejected }
  }

  return { read, patch, pathOf }
}

/** 装配产物回写 persona（只读 profile、只写 pet.json，不碰图库任何文件） */
function attachPersona(dir, persona) {
  if (!dir || !PERSONAS.includes(persona)) return { ok: false, error: 'persona 非法' }
  const file = path.join(dir, 'pet.json')
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (json.persona === persona) return { ok: true, unchanged: true }
    json.persona = persona
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf-8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/**
 * 注册 Part A 的主进程能力。
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {import('electron').App} deps.app
 * @param {(patch: object) => void} deps.writeUiState  复用现有的 ui-state.json 写入口
 * @param {() => object} deps.readUiState
 * @returns {{statsStore: object, attachPersona: Function, soundEnabled: () => boolean}}
 */
function registerPetCompanion(deps) {
  const { ipcMain, app, readUiState, writeUiState, onStatsChange } = deps
  const root = path.join(app.getPath('home'), '.petpet', 'state')
  const statsStore = createStatsStore({ root })

  const soundEnabled = () => {
    let ui = {}
    try { ui = readUiState() || {} } catch { ui = {} }
    return ui.sound !== false // 缺省开启
  }

  // 返回形状同时兼容两代调用方：A 的渲染层读 r.state，B 的潜在调用方读 r.mood/r.satiety
  ipcMain.handle('stats:get', (_evt, petId) => {
    const r = statsStore.read(petId)
    return r.ok ? { ok: true, state: r.state, ...r.state } : r
  })

  ipcMain.handle('stats:patch', (_evt, petId, delta) => {
    const r = statsStore.patch(petId, delta)
    if (r.ok) {
      console.log('[PetPet][数值]', petId, JSON.stringify(r.applied), '→', JSON.stringify({
        mood: r.state.mood, satiety: r.state.satiety, checkins: r.state.checkins
      }))
      // B 组约定：数值变了广播 capsule:refresh，胶囊不自己算分（docs/handoff/B §B2）
      if (typeof onStatsChange === 'function') {
        try { onStatsChange(petId, r.state) } catch (e) { console.error('[PetPet][数值] 刷新回调失败', e) }
      }
    }
    return r.ok ? { ...r, ...r.state } : r
  })

  // 渲染层无法写 ~/.petpet/petpet.log（那只重定向了主进程 console），
  // 音效结果在这里落一行，便于排障与"到底响没响"的可验证性
  ipcMain.on('audio:report', (_evt, status, detail) => {
    console.log('[PetPet][音效]', String(status || 'unknown'), detail ? String(detail) : '')
  })

  ipcMain.handle('prefs:get', () => ({ sound: soundEnabled() }))

  ipcMain.handle('prefs:set', (_evt, patch) => {
    const next = {}
    if (patch && typeof patch === 'object' && typeof patch.sound === 'boolean') next.sound = patch.sound
    if (Object.keys(next).length > 0) {
      try { writeUiState(next) } catch (e) { console.error('[PetPet][偏好] 保存失败', e) }
    }
    return { ok: true, sound: soundEnabled() }
  })

  return { statsStore, attachPersona, soundEnabled }
}

module.exports = {
  // 常量（测试与文档共用，避免两处写歪）
  MOOD_INIT,
  SATIETY_INIT,
  MOOD_MAX,
  SATIETY_MAX,
  PET_MOOD_GAIN,
  MOOD_DAILY_CAP,
  FEED_SATIETY_GAIN,
  CHECKIN_SATIETY_GAIN,
  CHECKIN_MOOD_GAIN,
  CHECKIN_DAILY_SCORING,
  PERSONAS,
  // 纯函数
  clamp,
  todayStr,
  newState,
  dailyReset,
  normalizeDelta,
  applyStatsPatch,
  // 存储与主进程注册
  createStatsStore,
  attachPersona,
  registerPetCompanion
}
