// B-3 专注模式纯逻辑单测（对应 viewer/focus-session.cjs）
// 覆盖：分钟解析边界、倒计时格式化、剩余时间、过期归档、进度
import { describe, it, expect } from 'vitest'
import {
  MIN_MINUTES,
  MAX_MINUTES,
  parseMinutes,
  remainingMs,
  formatCountdown,
  endAtFromMinutes,
  normalizeFocus,
  focusProgress
} from '../focus-session.cjs'

describe('parseMinutes 输入校验', () => {
  it('接受 1–180 的整数，也接受带"分钟"后缀的写法', () => {
    expect(parseMinutes('25')).toEqual({ ok: true, minutes: 25 })
    expect(parseMinutes(45)).toEqual({ ok: true, minutes: 45 })
    expect(parseMinutes(' 30 ')).toEqual({ ok: true, minutes: 30 })
    expect(parseMinutes('60分钟')).toEqual({ ok: true, minutes: 60 })
    expect(parseMinutes(MIN_MINUTES)).toEqual({ ok: true, minutes: MIN_MINUTES })
    expect(parseMinutes(MAX_MINUTES)).toEqual({ ok: true, minutes: MAX_MINUTES })
  })

  it('拒绝空值', () => {
    for (const v of ['', '   ', null, undefined]) {
      expect(parseMinutes(v).ok).toBe(false)
    }
  })

  it('拒绝 0、负数、超过 180', () => {
    expect(parseMinutes('0')).toEqual({ ok: false, error: expect.stringContaining('至少') })
    expect(parseMinutes('-5').ok).toBe(false)
    expect(parseMinutes('181')).toEqual({ ok: false, error: expect.stringContaining('最多') })
  })

  it('拒绝小数与非数字', () => {
    expect(parseMinutes('1.5').ok).toBe(false)
    expect(parseMinutes('abc').ok).toBe(false)
    expect(parseMinutes('1e3').ok).toBe(false)
  })
})

describe('formatCountdown', () => {
  it('常规 MM:SS', () => {
    expect(formatCountdown(0)).toBe('00:00')
    expect(formatCountdown(1000)).toBe('00:01')
    expect(formatCountdown(59_000)).toBe('00:59')
    expect(formatCountdown(60_000)).toBe('01:00')
    expect(formatCountdown(25 * 60_000)).toBe('25:00')
  })

  it('向上取整：剩 800ms 显示 00:01 而不是 00:00', () => {
    expect(formatCountdown(800)).toBe('00:01')
    expect(formatCountdown(1)).toBe('00:01')
  })

  it('负数归零，不出现负号', () => {
    expect(formatCountdown(-5000)).toBe('00:00')
  })

  it('超过一小时给 H:MM:SS', () => {
    expect(formatCountdown(3600_000)).toBe('1:00:00')
    expect(formatCountdown(3600_000 + 65_000)).toBe('1:01:05')
  })
})

describe('remainingMs / endAtFromMinutes', () => {
  it('剩余时间按 endAt 差值算，负数归零', () => {
    expect(remainingMs(10_000, 4000)).toBe(6000)
    expect(remainingMs(10_000, 12_000)).toBe(0)
    expect(remainingMs('bad', 0)).toBe(0)
  })

  it('结束时刻 = now + 分钟数', () => {
    const r = endAtFromMinutes(25, 1_000_000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.endAt).toBe(1_000_000 + 25 * 60_000)
  })

  it('非法分钟数不产生结束时刻', () => {
    expect(endAtFromMinutes('0', 0).ok).toBe(false)
    expect(endAtFromMinutes('999', 0).ok).toBe(false)
  })
})

describe('normalizeFocus 重启恢复', () => {
  it('未到期：原样恢复并补齐字段', () => {
    const now = 1_000_000
    const s = normalizeFocus({ endAt: now + 60_000, minutes: 1, startedAt: now - 1000 }, now)
    expect(s).not.toBeNull()
    expect(s?.endAt).toBe(now + 60_000)
    expect(s?.minutes).toBe(1)
    expect(s?.startedAt).toBe(now - 1000)
  })

  it('已到期 / 非法数据 → null（调用方负责清文件）', () => {
    const now = 1_000_000
    expect(normalizeFocus({ endAt: now - 1, minutes: 1 }, now)).toBeNull()
    expect(normalizeFocus({ endAt: 'bad' }, now)).toBeNull()
    expect(normalizeFocus(null, now)).toBeNull()
  })

  it('缺 startedAt 时按剩余时间反推，进度仍可用', () => {
    const now = 1_000_000
    const s = normalizeFocus({ endAt: now + 30_000, minutes: 1 }, now)
    expect(s?.startedAt).toBe(now)
  })
})

describe('focusProgress', () => {
  it('0 → 1 线性推进，越界钳制', () => {
    const s = { startedAt: 0, endAt: 60_000 }
    expect(focusProgress(s, 0)).toBe(0)
    expect(focusProgress(s, 30_000)).toBeCloseTo(0.5, 5)
    expect(focusProgress(s, 90_000)).toBe(1)
    expect(focusProgress(null, 0)).toBe(0)
  })
})
