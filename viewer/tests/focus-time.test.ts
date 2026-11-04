// B-3 专注模式时间逻辑单测（分钟校验 / 剩余 / 倒计时格式）
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const requireCjs = createRequire(import.meta.url)
const { parseMinutes, remaining, formatCountdown, MIN_MINUTES, MAX_MINUTES } = requireCjs('../focus-time.cjs')

describe('parseMinutes', () => {
  it('接受字符串与数字形式，允许首尾空格', () => {
    expect(parseMinutes('25')).toBe(25)
    expect(parseMinutes(25)).toBe(25)
    expect(parseMinutes(' 45 ')).toBe(45)
    expect(parseMinutes('005')).toBe(5)
  })

  it('拒绝空串 / 非数字 / 小数 / 非字符串输入', () => {
    expect(parseMinutes('')).toBe(null)
    expect(parseMinutes('abc')).toBe(null)
    expect(parseMinutes('1.5')).toBe(null)
    expect(parseMinutes(2.5)).toBe(null)
    expect(parseMinutes(null)).toBe(null)
    expect(parseMinutes(undefined)).toBe(null)
  })

  it('边界：1 与 180 合法，0 / 负数 / 181 非法', () => {
    expect(parseMinutes(MIN_MINUTES)).toBe(1)
    expect(parseMinutes(MAX_MINUTES)).toBe(180)
    expect(parseMinutes('0')).toBe(null)
    expect(parseMinutes(-5)).toBe(null)
    expect(parseMinutes('181')).toBe(null)
    expect(parseMinutes('1000')).toBe(null)
  })
})

describe('formatCountdown', () => {
  it('0 与负数都显示 00:00', () => {
    expect(formatCountdown(0)).toBe('00:00')
    expect(formatCountdown(-1000)).toBe('00:00')
    expect(formatCountdown(NaN)).toBe('00:00')
  })

  it('25 分钟整显示 25:00，过了 1 秒才变 24:59', () => {
    expect(formatCountdown(25 * 60 * 1000)).toBe('25:00')
    expect(formatCountdown(1499000)).toBe('24:59')
  })

  it('不足一分钟按秒向上取整', () => {
    expect(formatCountdown(1000)).toBe('00:01')
    expect(formatCountdown(999)).toBe('00:01')
    expect(formatCountdown(1)).toBe('00:01')
    expect(formatCountdown(59000)).toBe('00:59')
  })

  it('超过 99 分钟分钟位不截断（180:00）', () => {
    expect(formatCountdown(180 * 60 * 1000)).toBe('180:00')
    expect(formatCountdown(100 * 60 * 1000 + 5000)).toBe('100:05')
  })
})

describe('remaining', () => {
  it('按 endAt - now 计算，已过期钳到 0', () => {
    expect(remaining(1000, 0)).toBe(1000)
    expect(remaining(1000, 400)).toBe(600)
    expect(remaining(1000, 1500)).toBe(0)
  })

  it('now 省略时取当前时间，非法 endAt 返回 0', () => {
    const now = Date.now()
    expect(remaining(now + 60000)).toBeGreaterThan(59000)
    expect(remaining('abc')).toBe(0)
  })
})
