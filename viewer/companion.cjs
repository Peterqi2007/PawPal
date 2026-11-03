// Part A：陪伴交互的主进程侧（数值 / 偏好 / persona 回写）
//
// 契约出处：docs/handoff/README.md §5
//   C1  pet.json 可选 persona（装配后由 attachPersona 回写）
//   C2  ~/.petpet/state/<petId>.json —— 数值唯一真源（主进程 JSON + deviceId，不用 localStorage）
//   C3  IPC：stats:get / stats:patch / prefs:get / prefs:set
//
// 边界（本轮冻结）：不读写 refs.*（图库一行不许动）、不改 pet-assembler.cjs，
// 只在装配产物目录里读改写 pet.json 一个字段。
//
// 数值规则（常识优先，不制造焦虑）：
//   饱腹 初始 50，喂食/打卡 +20，封顶 100
//   心情 初始 60，摸头 +5（每日合计上限 15），打卡 +10，封顶 100
//   只升不降，无时间衰减；跨天（本地日期）重置为初始值
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const MOOD_INIT = 60
const SATIETY_INIT = 50
const MOOD_MAX = 100
const SATIETY_MAX = 100
const PET_MOOD_GAIN = 5
const MOOD_DAILY_CAP = 15
const FEED_SATIETY_GAIN = 20
const CHECKIN_SATIETY_GAIN = 20
const CHECKIN_MOOD_GAIN = 10
const PERSONAS = ['温柔', '傲娇', '搞笑']
const PET_ID_RE = /^[a-z0-9_-]+$/

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

/** 本地日期字符串 YYYY-MM-DD（跨天判定用本地时区，不用 UTC） */
function todayStr(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
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
 * 应用一次数值变更（纯函数，node 直测）。
 * @param {object} state  当前状态（已 ensureToday）
 * @param {object} delta  { feed?: true, checkin?: true, mood?: number }
 * @returns {{state: object, applied: object, capped: object, rejected: string[]}}
 */
function applyStatsPatch(state, delta) {
  const rejected = []
  if (!delta || typeof delta !== 'object') {
    return { state, applied: {}, capped: {}, rejected: ['delta 必须是对象'] }
  }
  const next = { ...state }
  const applied = { mood: 0, satiety: 0, checkins: 0 }
  const capped = { mood: false, satiety: false }

  const allowed = ['feed', 'checkin', 'mood']
  for (const key of Object.keys(delta)) {
    if (!allowed.includes(key)) rejected.push(key)
  }

  if (delta.feed === true) {
    const before = next.satiety
    next.satiety = clamp(before + FEED_SATIETY_GAIN, 0, SATIETY_MAX)
    applied.satiety += next.satiety - before
    if (next.satiety >= SATIETY_MAX) capped.satiety = true
  }

  if (delta.checkin === true) {
    const sBefore = next.satiety
    next.satiety = clamp(sBefore + CHECKIN_SATIETY_GAIN, 0, SATIETY_MAX)
    applied.satiety += next.satiety - sBefore
    const mBefore = next.mood
    next.mood = clamp(mBefore + CHECKIN_MOOD_GAIN, 0, MOOD_MAX)
    applied.mood += next.mood - mBefore
    next.checkins = (Number(next.checkins) || 0) + 1
    applied.checkins = 1
    if (next.satiety >= SATIETY_MAX) capped.satiety = true
    if (next.mood >= MOOD_MAX) capped.mood = true
  }

  if (typeof delta.mood === 'number') {
    if (!Number.isFinite(delta.mood) || delta.mood <= 0) {
      rejected.push('mood')
    } else {
      // 摸头有每日上限；打卡加的心不占这个额度
      const quota = Math.max(0, MOOD_DAILY_CAP - (Number(next.moodToday) || 0))
      const gain = Math.min(delta.mood, quota, MOOD_MAX - next.mood)
      if (gain <= 0) {
        capped.mood = true
      } else {
        next.mood = clamp(next.mood + gain, 0, MOOD_MAX)
        next.moodToday = clamp((Number(next.moodToday) || 0) + gain, 0, MOOD_DAILY_CAP)
        applied.mood += gain
        if (next.moodToday >= MOOD_DAILY_CAP) capped.mood = true
      }
    }
  }

  return { state: next, applied, capped, rejected }
}

/** 宽松读取 JSON（不存在/损坏都返回 null，由调用方决定重建） */
function readJsonTolerant(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * 数值存储（~/.petpet/state/<petId>.json）。
 * 原子写：先写 .tmp 再 rename，避免中途退出留下半截 JSON。
 */
function createStatsStore({ root, now = () => new Date() }) {
  const pathOf = (petId) => path.join(root, `${petId}.json`)

  function writeAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  /** 读取并保证是"今天"的状态；损坏文件改名留证后重建 */
  function read(petId) {
    if (!PET_ID_RE.test(String(petId || ''))) return { ok: false, error: '非法 petId' }
    const file = pathOf(petId)
    const today = todayStr(now())
    let raw = readJsonTolerant(file)
    if (raw === null && fs.existsSync(file)) {
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* ignore */ }
    }
    let state = raw && typeof raw === 'object' ? raw : newState(today)
    // 字段补全（旧文件/手改文件不至于让 UI 崩）
    for (const [k, v] of Object.entries(newState(today))) {
      if (state[k] === undefined) state[k] = v
    }
    const reset = dailyReset(state, today)
    state = reset.state
    if (reset.reset || raw === null) {
      try { writeAtomic(file, state) } catch (e) { console.error('[PetPet][数值] 初始化失败', e) }
    }
    return { ok: true, state, reset: reset.reset }
  }

  function patch(petId, delta) {
    const cur = read(petId)
    if (!cur.ok) return cur
    const out = applyStatsPatch(cur.state, delta)
    try {
      writeAtomic(pathOf(petId), out.state)
    } catch (e) {
      console.error('[PetPet][数值] 落盘失败', e)
      return { ok: false, error: '写入失败' }
    }
    return { ok: true, state: out.state, applied: out.applied, capped: out.capped, rejected: out.rejected }
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
  const { ipcMain, app, readUiState, writeUiState } = deps
  const root = path.join(app.getPath('home'), '.petpet', 'state')
  const statsStore = createStatsStore({ root })

  const soundEnabled = () => {
    let ui = {}
    try { ui = readUiState() || {} } catch { ui = {} }
    return ui.sound !== false // 缺省开启
  }

  ipcMain.handle('stats:get', (_evt, petId) => {
    const r = statsStore.read(petId)
    return r.ok ? { ok: true, state: r.state } : r
  })

  ipcMain.handle('stats:patch', (_evt, petId, delta) => {
    const r = statsStore.patch(petId, delta)
    if (r.ok) {
      console.log('[PetPet][数值]', petId, JSON.stringify(r.applied), '→', JSON.stringify({
        mood: r.state.mood, satiety: r.state.satiety, checkins: r.state.checkins
      }))
    }
    return r
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
  PERSONAS,
  // 纯函数
  clamp,
  todayStr,
  newState,
  dailyReset,
  applyStatsPatch,
  // 存储与主进程注册
  createStatsStore,
  attachPersona,
  registerPetCompanion
}
