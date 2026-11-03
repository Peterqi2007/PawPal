// B-1 数值系统：饱腹 / 心情 / 打卡（docs/B-状态与专注.md）
// 设计约束：
// 1) 纯状态机 + 可注入 now()，不依赖 Electron，vitest 直接测
// 2) 原子写：先写 .tmp 再 rename，避免半截文件
// 3) 文件 0600；宠物 id 走白名单，防路径穿越
// 4) 坏档不静默清空：备份成 .corrupt-<ts> 后重建默认值
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const DEFAULT_STATE = Object.freeze({ satiety: 50, mood: 60, checkins: 0, moodToday: 0 })

const SCORE_MIN = 0
const SCORE_MAX = 100
const PAT_MOOD = 5 // 摸头 +5 心情
const MOOD_DAILY_CAP = 15 // 摸头每日最多 +15
const CHECKIN_SATIETY = 20 // 打卡 +20 饱腹
const CHECKIN_MOOD = 10 // 打卡 +10 心情
const CHECKIN_SCORING = 3 // 每日前 3 次打卡计分
const FEED_SATIETY = 20 // 喂食 +20 饱腹

// 本地时区的 YYYY-MM-DD（用户按自己的"今天"重置，不用 UTC）
function todayStr(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function clampScore(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return SCORE_MIN
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, Math.round(v)))
}

// 目录名白名单：与 security-utils.safePetId 同口径，非法 id 落到 default
function safeId(id) {
  return typeof id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(id) ? id : 'default'
}

function freshState(date, deviceId) {
  return { date, ...DEFAULT_STATE, deviceId }
}

// 读取后归一：数值全部钳制；日期不是今天就整组重置（device_id 保留）
function normalizeState(raw, date, deviceId) {
  const src = raw && typeof raw === 'object' ? raw : {}
  if (src.date !== date) return freshState(date, deviceId || src.deviceId)
  return {
    date,
    satiety: clampScore(src.satiety ?? DEFAULT_STATE.satiety),
    mood: clampScore(src.mood ?? DEFAULT_STATE.mood),
    checkins: Math.max(0, Math.floor(Number(src.checkins) || 0)),
    moodToday: Math.max(0, Math.round(Number(src.moodToday) || 0)),
    deviceId: deviceId || src.deviceId
  }
}

// 纯函数：把一次增量应用到状态上，返回新对象（不改入参）
function applyDelta(state, delta) {
  const out = { ...state }
  const d = delta && typeof delta === 'object' ? delta : {}

  // 打卡：前 3 次计分，第 4 次起只计数（不惩罚，也不再加分）
  if (d.checkin) {
    if (out.checkins < CHECKIN_SCORING) {
      out.satiety = clampScore(out.satiety + CHECKIN_SATIETY)
      out.mood = clampScore(out.mood + CHECKIN_MOOD)
    }
    out.checkins = Math.max(0, Math.floor(out.checkins)) + 1
  }

  // 心情：正向受每日上限约束，负向（A 组做低落反馈用）不受限
  if (d.mood != null) {
    const want = Math.round(Number(d.mood))
    if (Number.isFinite(want) && want > 0) {
      const room = Math.max(0, MOOD_DAILY_CAP - out.moodToday)
      const gain = Math.min(want, room)
      out.mood = clampScore(out.mood + gain)
      out.moodToday += gain
    } else if (Number.isFinite(want) && want < 0) {
      out.mood = clampScore(out.mood + want)
    }
  }

  // 饱腹：喂食 / 喝水走这里
  if (d.satiety != null) {
    const want = Math.round(Number(d.satiety))
    if (Number.isFinite(want)) out.satiety = clampScore(out.satiety + want)
  }

  return out
}

function createStatsStore(options = {}) {
  // 契约 C2：状态落 ~/.petpet/state/<petId>.json（与 reminders.json 同根目录）
  // stateDir 可显式指定：A 组的门面（companion.cjs）已经持有 state 目录，直接传进来
  // 比"传 baseDir 再让它反推"更不容易错位。
  const baseDir = options.baseDir || path.join(os.homedir(), '.petpet')
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const statsDir = options.stateDir || path.join(baseDir, 'state')
  const deviceFile = path.join(statsDir, 'device-id.txt')
  let deviceId = null

  function ensureDeviceId() {
    if (deviceId) return deviceId
    try {
      const raw = fs.readFileSync(deviceFile, 'utf8').trim()
      if (/^[a-z0-9-]{8,64}$/i.test(raw)) {
        deviceId = raw
        return deviceId
      }
    } catch (e) {
      /* 首次运行，落到下面生成 */
    }
    deviceId = crypto.randomUUID()
    try {
      fs.mkdirSync(statsDir, { recursive: true })
      fs.writeFileSync(deviceFile, deviceId, { mode: 0o600 })
    } catch (e) {
      console.error('[stats] device-id 写入失败:', e)
    }
    return deviceId
  }

  function fileFor(petId) {
    const file = path.join(statsDir, `${safeId(petId)}.json`)
    // 纵深防御：safeId 已保证无分隔符，这里再确认没跑出 stats 目录
    if (!file.startsWith(statsDir + path.sep)) throw new Error('非法 stats 路径')
    return file
  }

  // 返回 { state, dirty }：dirty 表示需要落盘（跨天重置 / 首次运行）
  function read(petId) {
    const file = fileFor(petId)
    const today = todayStr(now())
    const id = ensureDeviceId()
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // 坏档先留证据，再重建，绝不静默丢数据
        try {
          fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
        } catch (_) {
          /* 备份失败也不阻塞启动 */
        }
      }
      return { state: freshState(today, id), dirty: true }
    }
    const state = normalizeState(raw, today, id)
    return { state, dirty: raw.date !== today || !raw.deviceId }
  }

  function write(petId, state) {
    const file = fileFor(petId)
    fs.mkdirSync(statsDir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  return {
    get(petId) {
      const { state, dirty } = read(petId)
      if (dirty) write(petId, state)
      return { ...state }
    },
    patch(petId, delta) {
      const { state } = read(petId)
      const next = applyDelta(state, delta)
      write(petId, next)
      return { ...next }
    },
    reset(petId) {
      const state = freshState(todayStr(now()), ensureDeviceId())
      write(petId, state)
      return { ...state }
    }
  }
}

module.exports = {
  createStatsStore,
  applyDelta,
  normalizeState,
  clampScore,
  todayStr,
  safeId,
  DEFAULT_STATE,
  PAT_MOOD,
  MOOD_DAILY_CAP,
  CHECKIN_SATIETY,
  CHECKIN_MOOD,
  CHECKIN_SCORING,
  FEED_SATIETY
}
