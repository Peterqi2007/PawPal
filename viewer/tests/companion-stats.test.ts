// Part A 数值系统单测（对应 viewer/companion.cjs）
// 覆盖：初始值、喂食/打卡/摸头的数值规则、每日上限、跨天重置、落盘与损坏恢复、persona 回写
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  MOOD_INIT,
  SATIETY_INIT,
  MOOD_MAX,
  SATIETY_MAX,
  MOOD_DAILY_CAP,
  FEED_SATIETY_GAIN,
  CHECKIN_SATIETY_GAIN,
  CHECKIN_MOOD_GAIN,
  newState,
  todayStr,
  dailyReset,
  applyStatsPatch,
  createStatsStore,
  attachPersona
} from '../companion.cjs'
import type { PetStats } from '../companion.d.cts'

let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petpet-stats-'))
})
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

const base = (over: Partial<PetStats> = {}): PetStats => ({
  date: '2026-11-03', mood: MOOD_INIT, satiety: SATIETY_INIT, checkins: 0, moodToday: 0, deviceId: 'dev-1', ...over
})

describe('初始状态', () => {
  it('心情 60 / 饱腹 50 / 打卡 0', () => {
    const s = newState('2026-11-03')
    expect(s.mood).toBe(MOOD_INIT)
    expect(s.satiety).toBe(SATIETY_INIT)
    expect(s.checkins).toBe(0)
    expect(s.moodToday).toBe(0)
    expect(s.date).toBe('2026-11-03')
    expect(s.deviceId.length).toBeGreaterThan(10)
  })

  it('todayStr 用本地日期（YYYY-MM-DD）', () => {
    expect(todayStr(new Date(2026, 10, 3))).toBe('2026-11-03')
    expect(todayStr(new Date(2026, 0, 9))).toBe('2026-01-09')
  })
})

describe('跨天重置', () => {
  it('同一天不重置', () => {
    const s = base({ mood: 90 })
    const r = dailyReset(s, '2026-11-03')
    expect(r.reset).toBe(false)
    expect(r.state.mood).toBe(90)
  })

  it('换天重置为初始值，但保留 deviceId', () => {
    const s = base({ mood: 90, satiety: 88, checkins: 2, moodToday: 10, deviceId: 'keep-me' })
    const r = dailyReset(s, '2026-11-04')
    expect(r.reset).toBe(true)
    expect(r.state.mood).toBe(MOOD_INIT)
    expect(r.state.satiety).toBe(SATIETY_INIT)
    expect(r.state.checkins).toBe(0)
    expect(r.state.deviceId).toBe('keep-me')
  })
})

describe('applyStatsPatch 数值规则', () => {
  it('喂食口径已收敛：{feed:true} 被拒绝（只认打卡）', () => {
    const r = applyStatsPatch(base(), { feed: true } as never)
    expect(r.rejected).toContain('feed')
    expect(r.state.satiety).toBe(SATIETY_INIT)
  })

  it('打卡：饱腹 +20（现为唯一喂食入口）', () => {
    const r = applyStatsPatch(base(), { checkin: true })
    expect(r.state.satiety).toBe(SATIETY_INIT + FEED_SATIETY_GAIN)
    expect(r.applied.satiety).toBe(FEED_SATIETY_GAIN)
  })

  it('打卡封顶 100（超出部分不累计）', () => {
    const r = applyStatsPatch(base({ satiety: 95 }), { checkin: true })
    expect(r.state.satiety).toBe(SATIETY_MAX)
    expect(r.applied.satiety).toBe(5)
    expect(r.capped.satiety).toBe(true)
  })

  it('打卡：饱腹 +20、心情 +10、打卡次数 +1', () => {
    const r = applyStatsPatch(base(), { checkin: true })
    expect(r.state.satiety).toBe(SATIETY_INIT + CHECKIN_SATIETY_GAIN)
    expect(r.state.mood).toBe(MOOD_INIT + CHECKIN_MOOD_GAIN)
    expect(r.state.checkins).toBe(1)
    expect(r.state.moodToday).toBe(0) // 打卡加的心不占"摸头额度"
  })

  it('摸头：心情 +5，并计入 moodToday', () => {
    const r = applyStatsPatch(base(), { mood: 5 })
    expect(r.state.mood).toBe(MOOD_INIT + 5)
    expect(r.state.moodToday).toBe(5)
    expect(r.capped.mood).toBe(false)
  })

  it('摸头每日上限 15：额度用完后不再增加', () => {
    const r1 = applyStatsPatch(base({ moodToday: 10 }), { mood: 5 })
    expect(r1.state.moodToday).toBe(MOOD_DAILY_CAP)
    expect(r1.applied.mood).toBe(5)

    const r2 = applyStatsPatch(r1.state, { mood: 5 })
    expect(r2.applied.mood).toBe(0)
    expect(r2.state.mood).toBe(r1.state.mood)
    expect(r2.capped.mood).toBe(true)
  })

  it('心情封顶 100', () => {
    const r = applyStatsPatch(base({ mood: 98, moodToday: 0 }), { mood: 5 })
    expect(r.state.mood).toBe(MOOD_MAX)
    expect(r.applied.mood).toBe(2)
  })

  it('未知字段被拒绝且不改数值', () => {
    const r = applyStatsPatch(base(), { checkin: true, hacker: 999 } as never)
    expect(r.rejected).toContain('hacker')
    expect(r.state.satiety).toBe(SATIETY_INIT + FEED_SATIETY_GAIN)
  })

  it('负向心情：合并 Part B 规则后允许，且不占每日摸头额度', () => {
    const neg = applyStatsPatch(base(), { mood: -10 })
    expect(neg.rejected).not.toContain('mood')
    expect(neg.state.mood).toBe(MOOD_INIT - 10)
    expect(neg.state.moodToday).toBe(0)
  })

  it('delta 为 null 时不改动', () => {
    const s = base()
    const r = applyStatsPatch(s, null)
    expect(r.state.mood).toBe(s.mood)
    expect(r.rejected.length).toBeGreaterThan(0)
  })
})

describe('createStatsStore 落盘', () => {
  it('首次读取自动建文件并写入初始值', () => {
    const store = createStatsStore({ root: dir, now: () => new Date(2026, 10, 3, 10, 0, 0) })
    const r = store.read('dev-pet')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.state.mood).toBe(MOOD_INIT)
    expect(fs.existsSync(store.pathOf('dev-pet'))).toBe(true)
  })

  it('patch 后落盘，重新读取仍是新值', () => {
    const store = createStatsStore({ root: dir, now: () => new Date(2026, 10, 3, 10, 0, 0) })
    store.patch('dev-pet', { checkin: true })
    const again = store.read('dev-pet')
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.state.satiety).toBe(SATIETY_INIT + FEED_SATIETY_GAIN)
  })

  it('跨天后自动重置', () => {
    let day = 3
    const store = createStatsStore({ root: dir, now: () => new Date(2026, 10, day, 10, 0, 0) })
    store.patch('dev-pet', { mood: 5 })
    day = 4
    const r = store.read('dev-pet')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.state.mood).toBe(MOOD_INIT)
    expect(r.reset).toBe(true)
  })

  it('坏 JSON 不崩溃：改名留证并重建', () => {
    const file = path.join(dir, 'dev-pet.json')
    fs.writeFileSync(file, '{ this is not json', 'utf-8')
    const store = createStatsStore({ root: dir, now: () => new Date(2026, 10, 3, 10, 0, 0) })
    const r = store.read('dev-pet')
    expect(r.ok).toBe(true)
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'))
    expect(backups.length).toBe(1)
  })

  it('非法 petId 直接拒绝（防路径穿越）', () => {
    const store = createStatsStore({ root: dir })
    expect(store.read('../etc/passwd').ok).toBe(false)
    expect(store.patch('a/b', { checkin: true }).ok).toBe(false)
  })

  it('原子写不残留 .tmp 文件', () => {
    const store = createStatsStore({ root: dir, now: () => new Date(2026, 10, 3, 10, 0, 0) })
    store.patch('dev-pet', { checkin: true })
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false)
  })
})

describe('attachPersona 回写', () => {
  it('写入合法 persona', () => {
    const petDir = path.join(dir, 'pet-x')
    fs.mkdirSync(petDir)
    fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify({ version: 3, id: 'pet-x', name: '豆豆' }), 'utf-8')
    expect(attachPersona(petDir, '傲娇').ok).toBe(true)
    const json = JSON.parse(fs.readFileSync(path.join(petDir, 'pet.json'), 'utf-8'))
    expect(json.persona).toBe('傲娇')
    expect(json.name).toBe('豆豆')
  })

  it('非法 persona 拒绝（不写脏数据）', () => {
    const petDir = path.join(dir, 'pet-y')
    fs.mkdirSync(petDir)
    fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify({ version: 3 }), 'utf-8')
    expect(attachPersona(petDir, '暴躁').ok).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(petDir, 'pet.json'), 'utf-8')).persona).toBeUndefined()
  })
})
