// B-3 专注模式的时间逻辑：分钟校验、剩余计算、倒计时格式化
//
// 这里只做纯数学，不碰 Electron / 文件系统（和 stats-store.cjs 一样可被 vitest 直接 require）。
// 主进程（focus.cjs）与胶囊渲染层都用同一套规则，避免「设置卡能填 200 分钟、胶囊显示 200:00」这种不一致。
'use strict'

const MIN_MINUTES = 1
const MAX_MINUTES = 180

// '25' / 25 / ' 45 ' → 数字；空串、小数、0、负数、>180、非数字 → null
function parseMinutes(input) {
  if (typeof input === 'number') {
    if (!Number.isInteger(input)) return null
    return input >= MIN_MINUTES && input <= MAX_MINUTES ? input : null
  }
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (!/^\d{1,3}$/.test(s)) return null
  const n = Number(s)
  return n >= MIN_MINUTES && n <= MAX_MINUTES ? n : null
}

// 剩余毫秒：给已过期的 endAt 返回 0（不返回负数，调用方不用再钳）
function remaining(endAt, now) {
  const end = Number(endAt)
  const cur = now === undefined ? Date.now() : Number(now)
  if (!Number.isFinite(end) || !Number.isFinite(cur)) return 0
  return Math.max(0, Math.round(end - cur))
}

// mm:ss。向上取整：刚开始的 25:00 完整显示 1 秒再跳 24:59，不会一开就变 24:59
function formatCountdown(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '00:00'
  const total = Math.ceil(n / 1000)
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

module.exports = {
  parseMinutes,
  remaining,
  formatCountdown,
  MIN_MINUTES,
  MAX_MINUTES
}
