// B-3 专注模式的纯逻辑（不依赖 Electron / DOM，node 直测）
//
// 设计要点（docs/handoff/B-状态与专注.md §B3）：
// 1) 时间基准是绝对的 endAt 时间戳，不用 setTimeout 累加——休眠/换屏/改系统时间都不会漂
// 2) 倒计时显示值永远由 endAt - now 算，tick 只负责触发重绘
// 3) 分钟数 1..180 的整数；非法输入返回明确错误，界面据此禁用按钮
'use strict'

const MIN_MINUTES = 1
const MAX_MINUTES = 180

/**
 * 解析用户输入的分钟数。
 * 允许 "25"、" 25 "、"25分"；拒绝 0 / 负数 / 超过 180 / 小数 / 非数字。
 * @returns {{ok: true, minutes: number} | {ok: false, error: string}}
 */
function parseMinutes(raw) {
  if (raw === null || raw === undefined) return { ok: false, error: '请填一个分钟数（1–180）' }
  const text = String(raw).trim().replace(/\s*(分钟|分|min)$/i, '')
  if (text === '') return { ok: false, error: '请填一个分钟数（1–180）' }
  if (!/^\d+$/.test(text)) return { ok: false, error: '只能填整数分钟（1–180）' }
  const minutes = Number(text)
  if (!Number.isFinite(minutes)) return { ok: false, error: '只能填整数分钟（1–180）' }
  if (minutes < MIN_MINUTES) return { ok: false, error: `至少 ${MIN_MINUTES} 分钟` }
  if (minutes > MAX_MINUTES) return { ok: false, error: `最多 ${MAX_MINUTES} 分钟` }
  return { ok: true, minutes }
}

/** 剩余毫秒：负数归零（不让界面出现 -00:01） */
function remainingMs(endAt, now = Date.now()) {
  const end = Number(endAt)
  if (!Number.isFinite(end)) return 0
  return Math.max(0, end - now)
}

/**
 * 毫秒 → `MM:SS`（超过一小时给 `H:MM:SS`）。
 * 用 ceil：显示 00:01 时确实还剩不到 1 秒，避免"显示 0 但其实还有 800ms"。
 */
function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000) || 0)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}

/** 结束时刻 = 现在 + 分钟数（唯一的时间换算入口，避免各处各写一遍） */
function endAtFromMinutes(minutes, now = Date.now()) {
  const { ok, minutes: m, error } = parseMinutes(minutes)
  if (!ok) return { ok: false, error }
  return { ok: true, endAt: now + m * 60 * 1000, minutes: m }
}

/**
 * 把落盘的 focus.json 归成可用的会话；过期/非法一律视为"没有专注"。
 * @returns {{endAt:number, minutes:number, startedAt:number} | null}
 */
function normalizeFocus(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null
  const endAt = Number(raw.endAt)
  if (!Number.isFinite(endAt)) return null
  const minutes = Number(raw.minutes)
  const startedAt = Number(raw.startedAt)
  if (remainingMs(endAt, now) <= 0) return null // 已经结束：调用方负责清文件
  return {
    endAt,
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : Math.ceil((endAt - now) / 60000),
    startedAt: Number.isFinite(startedAt) ? startedAt : now
  }
}

/** 专注进度 0..1（胶囊进度条用；已结束给 1） */
function focusProgress(session, now = Date.now()) {
  if (!session || !Number.isFinite(Number(session.endAt))) return 0
  const endAt = Number(session.endAt)
  const startedAt = Number.isFinite(Number(session.startedAt)) ? Number(session.startedAt) : endAt - 1
  const total = endAt - startedAt
  if (!(total > 0)) return 1
  const done = 1 - remainingMs(endAt, now) / total
  return Math.min(1, Math.max(0, done))
}

module.exports = {
  MIN_MINUTES,
  MAX_MINUTES,
  parseMinutes,
  remainingMs,
  formatCountdown,
  endAtFromMinutes,
  normalizeFocus,
  focusProgress
}
