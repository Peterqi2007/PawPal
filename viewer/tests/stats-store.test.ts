// B-1 数值系统单测（饱和/心情/打卡/跨天/落盘安全）
import { describe, it, expect, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const requireCjs = createRequire(import.meta.url)
const {
  createStatsStore,
  applyDelta,
  todayStr,
  DEFAULT_STATE,
  PAT_MOOD,
  MOOD_DAILY_CAP
} = requireCjs('../stats-store.cjs')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pawpal-stats-'))
}

// 可拨动的时钟，用来模拟跨天
type Clock = (() => Date) & { set: (v: string) => void }

function clock(iso: string): Clock {
  const box = { d: new Date(iso) }
  const fn = (() => box.d) as Clock
  fn.set = (v: string) => {
    box.d = new Date(v)
  }
  return fn
}

describe('applyDelta 纯函数', () => {
  it('初始值 饱腹 50 / 心情 60 / 打卡 0', () => {
    const s = { date: '2026-11-03', ...DEFAULT_STATE, deviceId: 'x' }
    const next = applyDelta(s, {})
    expect(next.satiety).toBe(50)
    expect(next.mood).toBe(60)
    expect(next.checkins).toBe(0)
  })

  it('摸头 +5 心情', () => {
    const next = applyDelta({ satiety: 50, mood: 60, checkins: 0, moodToday: 0 }, { mood: 5 })
    expect(next.mood).toBe(65)
    expect(next.moodToday).toBe(5)
    expect(PAT_MOOD).toBe(5)
  })

  it('摸头每日最多 +15（第 4 次起不再加）', () => {
    let s = { satiety: 50, mood: 60, checkins: 0, moodToday: 0 }
    for (let i = 0; i < 4; i++) s = applyDelta(s, { mood: 5 })
    expect(s.mood).toBe(60 + MOOD_DAILY_CAP)
    expect(s.moodToday).toBe(15)
  })

  it('心情负向不受每日上限限制', () => {
    const s = { satiety: 50, mood: 60, checkins: 0, moodToday: 15 }
    expect(applyDelta(s, { mood: -10 }).mood).toBe(50)
  })

  it('喂食 +20 饱腹，且钳制在 100', () => {
    expect(applyDelta({ satiety: 50, mood: 60, checkins: 0, moodToday: 0 }, { satiety: 20 }).satiety).toBe(70)
    expect(applyDelta({ satiety: 95, mood: 60, checkins: 0, moodToday: 0 }, { satiety: 20 }).satiety).toBe(100)
  })

  it('打卡 +20 饱腹 / +10 心情 / 次数 +1（前 3 次计分）', () => {
    const next = applyDelta({ satiety: 50, mood: 60, checkins: 0, moodToday: 0 }, { checkin: true })
    expect(next.satiety).toBe(70)
    expect(next.mood).toBe(70)
    expect(next.checkins).toBe(1)
  })

  it('每次打卡都 +20 饱腹；当天第 2 次起不再加心情', () => {
    const next = applyDelta({ satiety: 70, mood: 80, checkins: 3, moodToday: 0 }, { checkin: true })
    expect(next.checkins).toBe(4)
    expect(next.satiety).toBe(90)   // 打卡一直有饱腹收益（喂食/喂水都算）
    expect(next.mood).toBe(80)      // 但心情只在当天第一次给
  })

  it('当天第一次打卡才 +10 心情', () => {
    const first = applyDelta({ satiety: 50, mood: 60, checkins: 0, moodToday: 0 }, { checkin: true })
    expect(first.satiety).toBe(70)
    expect(first.mood).toBe(70)
    const second = applyDelta(first, { checkin: true })
    expect(second.satiety).toBe(90)
    expect(second.mood).toBe(70)
  })

  it('漏点惩罚：心情/饱腹各 -30，保底 0', () => {
    const r = applyDelta({ satiety: 100, mood: 20, checkins: 1, moodToday: 0 }, { missPenalty: true })
    expect(r.satiety).toBe(70)
    expect(r.mood).toBe(0)      // 20 - 30 → 夹到 0，不出现负数
    expect(r.checkins).toBe(1)  // 打卡次数不受影响
  })

  it('漏点惩罚不吃心情每日额度（moodToday 不变）', () => {
    const r = applyDelta({ satiety: 80, mood: 60, checkins: 0, moodToday: 5 }, { missPenalty: true })
    expect(r.moodToday).toBe(5)
  })

  it('非法 delta（非对象 / 非数字）不改变状态', () => {
    const s = { satiety: 50, mood: 60, checkins: 0, moodToday: 0 }
    expect(applyDelta(s, null)).toEqual(s)
    expect(applyDelta(s, 'oops')).toEqual(s)
    expect(applyDelta(s, { mood: 'abc', satiety: NaN })).toEqual(s)
  })
})

describe('createStatsStore 落盘', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpDir()
  })

  it('首次 get 生成默认值并落盘', () => {
    const store = createStatsStore({ baseDir: dir })
    const s = store.get('runtol')
    expect(s.satiety).toBe(50)
    expect(s.mood).toBe(60)
    expect(fs.existsSync(path.join(dir, 'state', 'runtol.json'))).toBe(true)
    expect(typeof s.deviceId).toBe('string')
    expect(s.deviceId.length).toBeGreaterThan(8)
  })

  it('patch 落盘后可读回，且没有残留 .tmp', () => {
    const store = createStatsStore({ baseDir: dir })
    store.get('runtol')
    store.patch('runtol', { mood: 5, satiety: 20 })
    const again = store.get('runtol')
    expect(again.mood).toBe(65)
    expect(again.satiety).toBe(70)
    const files = fs.readdirSync(path.join(dir, 'state'))
    expect(files.some((f: string) => f.endsWith('.tmp'))).toBe(false)
  })

  it('跨天自动重置分数，device_id 保留', () => {
    const now = clock('2026-11-03T10:00:00')
    const store = createStatsStore({ baseDir: dir, now })
    const first = store.get('runtol')
    store.patch('runtol', { mood: 5, checkin: true })

    now.set('2026-11-04T09:00:00')
    const next = store.get('runtol')
    expect(next.date).toBe('2026-11-04')
    expect(next.satiety).toBe(50)
    expect(next.mood).toBe(60)
    expect(next.checkins).toBe(0)
    expect(next.moodToday).toBe(0)
    expect(next.deviceId).toBe(first.deviceId)
  })

  it('坏档备份成 .corrupt-* 后重建，不静默丢数据', () => {
    const statsDir = path.join(dir, 'state')
    fs.mkdirSync(statsDir, { recursive: true })
    fs.writeFileSync(path.join(statsDir, 'runtol.json'), '{ not json')

    const store = createStatsStore({ baseDir: dir })
    const s = store.get('runtol')
    expect(s.mood).toBe(60)
    const files = fs.readdirSync(statsDir)
    expect(files.some((f: string) => f.includes('.corrupt-'))).toBe(true)
  })

  it('非法宠物 id 落到 default，不会路径穿越', () => {
    const store = createStatsStore({ baseDir: dir })
    store.patch('../../evil', { mood: 5 })
    const statsDir = path.join(dir, 'state')
    expect(fs.existsSync(path.join(statsDir, 'default.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'evil.json'))).toBe(false)
    expect(fs.existsSync(path.join(dir, '..', 'evil.json'))).toBe(false)
  })

  it('todayStr 用本地时区，跨天边界正确', () => {
    expect(todayStr(new Date(2026, 10, 3, 23, 59))).toBe('2026-11-03')
    expect(todayStr(new Date(2026, 10, 4, 0, 1))).toBe('2026-11-04')
  })

  it('连续签到：饱腹到 100 封顶，心情只在第一次 +10', () => {
    const store = createStatsStore({ baseDir: dir })
    store.get('runtol')
    store.patch('runtol', { checkin: true })
    store.patch('runtol', { checkin: true })
    store.patch('runtol', { checkin: true })
    const s = store.get('runtol')
    expect(s.mood).toBe(70)     // 60 + 10（仅首次）
    expect(s.satiety).toBe(100) // 50 → 70 → 90 → 100（封顶）
    expect(s.checkins).toBe(3)
  })
})
