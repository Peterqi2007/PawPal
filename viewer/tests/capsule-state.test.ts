// B-2 胶囊视图模型单测（对应 viewer/capsule-state.cjs）
// 覆盖：空态、数值百分比、打卡 3/3 与溢出、专注态、日期标签、状态点优先级
import { describe, it, expect } from 'vitest'
import { buildCapsuleModel, dateLabel, clampPct, CHECKIN_MAX } from '../capsule-state.cjs'

const NOW = new Date(2026, 10, 3, 20, 0, 0).getTime() // 2026-11-03 周二
const PET = { id: 'dev-pet', name: '自测狗' }
const STATS = { date: '2026-11-03', mood: 75, satiety: 40, checkins: 1, moodToday: 15, deviceId: 'd' }

describe('空态', () => {
  it('没有宠物/数值时给提示而不是空白', () => {
    const m = buildCapsuleModel({ stats: null, pet: null, now: NOW })
    expect(m.hasPet).toBe(false)
    expect(m.hasStats).toBe(false)
    expect(m.name).toBe('还没有宠物')
    expect(m.moodText).toBe('—')
    expect(m.satietyText).toBe('—')
    expect(m.checkinText).toBe('0/3')
    expect(m.emptyHint).toContain('还没有宠物')
    expect(m.focusing).toBe(false)
  })

  it('有宠物还没数值：名称正常显示，数值占位', () => {
    const m = buildCapsuleModel({ stats: null, pet: PET, now: NOW })
    expect(m.hasPet).toBe(true)
    expect(m.name).toBe('自测狗')
    expect(m.mood).toBe(0)
    expect(m.emptyHint).toBe('')
  })
})

describe('数值与打卡', () => {
  it('百分比原样透传，钳制 0–100', () => {
    const m = buildCapsuleModel({ stats: STATS, pet: PET, now: NOW })
    expect(m.mood).toBe(75)
    expect(m.satiety).toBe(40)
    expect(clampPct(140)).toBe(100)
    expect(clampPct(-3)).toBe(0)
    expect(clampPct('bad')).toBe(0)
  })

  it('打卡显示 min(n,3)/3，超出部分单独给溢出数', () => {
    const m1 = buildCapsuleModel({ stats: { ...STATS, checkins: 2 }, pet: PET, now: NOW })
    expect(m1.checkinText).toBe('2/3')
    expect(m1.checkinDots).toEqual([true, true, false])
    expect(m1.checkinOverflow).toBe(0)

    const m2 = buildCapsuleModel({ stats: { ...STATS, checkins: 5 }, pet: PET, now: NOW })
    expect(m2.checkinText).toBe(`${CHECKIN_MAX}/3`)
    expect(m2.checkinDots.every(Boolean)).toBe(true)
    expect(m2.checkinOverflow).toBe(2)
  })

  it('状态点优先级：专注 > 打卡未满 > 正常', () => {
    expect(buildCapsuleModel({ stats: { ...STATS, checkins: 0 }, pet: PET, now: NOW }).statusDot).toBe('pending')
    expect(buildCapsuleModel({ stats: { ...STATS, checkins: 3 }, pet: PET, now: NOW }).statusDot).toBe('idle')
    const focus = { endAt: NOW + 60_000, minutes: 1, startedAt: NOW - 60_000 }
    expect(buildCapsuleModel({ stats: STATS, pet: PET, focus, now: NOW }).statusDot).toBe('focus')
  })
})

describe('专注态', () => {
  it('显示 FOCUS mm:ss 与进度', () => {
    const focus = { endAt: NOW + 90_000, minutes: 5, startedAt: NOW - 210_000 }
    const m = buildCapsuleModel({ stats: STATS, pet: PET, focus, now: NOW })
    expect(m.focusing).toBe(true)
    expect(m.focusText).toBe('FOCUS 01:30')
    expect(m.focusRemainText).toBe('01:30')
    expect(m.focusProgress).toBeCloseTo(0.7, 5)
  })

  it('会话已到期：不再算专注（胶囊回常规态）', () => {
    const focus = { endAt: NOW - 1, minutes: 5, startedAt: NOW - 300_000 }
    const m = buildCapsuleModel({ stats: STATS, pet: PET, focus, now: NOW })
    expect(m.focusing).toBe(false)
    expect(m.focusText).toBe('')
    expect(m.statusDot).not.toBe('focus')
  })
})

describe('日期标签', () => {
  it('MM / DD 周X', () => {
    expect(dateLabel(new Date(2026, 10, 3))).toBe('11 / 03 周二')
    expect(dateLabel(new Date(2026, 0, 9))).toBe('01 / 09 周五')
    const m = buildCapsuleModel({ stats: STATS, pet: PET, now: NOW })
    expect(m.dateLabel).toBe('11 / 03 周二')
  })
})
