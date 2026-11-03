// 爱心喷发单测（对应 viewer/src/heart-burst.ts）
// 覆盖：粒子数量/生命周期不越界、10 秒口径、透明度曲线、结束位置朝外
import { describe, it, expect } from 'vitest'
import {
  HEART_BURST_MS,
  heartBurstSpec,
  heartOpacity,
  heartEnd,
  particleProgress,
  type HeartParticle
} from '../src/heart-burst'

// 固定伪随机，保证断言稳定
function seeded(seed = 42) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

describe('heartBurstSpec', () => {
  it('默认一次喷发跑满 10 秒', () => {
    expect(HEART_BURST_MS).toBe(10_000)
  })

  it('粒子按出现时间排序，且最后一个粒子在窗口内结束', () => {
    const list = heartBurstSpec({ count: 80, rng: seeded() })
    expect(list.length).toBe(80)
    for (let i = 1; i < list.length; i++) {
      expect(list[i].startAt).toBeGreaterThanOrEqual(list[i - 1].startAt)
    }
    const last = list[list.length - 1]
    expect(last.startAt + last.life).toBeLessThanOrEqual(HEART_BURST_MS)
  })

  it('粒子参数都落在合理区间（不会飞出窗口或贴脸）', () => {
    const list = heartBurstSpec({ count: 40, rng: seeded(7) })
    for (const p of list) {
      expect(p.size).toBeGreaterThanOrEqual(12)
      expect(p.size).toBeLessThanOrEqual(24)
      expect(p.distance).toBeGreaterThanOrEqual(40)
      expect(p.distance).toBeLessThanOrEqual(100)
      expect(p.life).toBeGreaterThanOrEqual(820)
      expect(p.life).toBeLessThanOrEqual(1380)
      expect(Math.abs(p.x)).toBeLessThanOrEqual(23)
    }
  })

  it('方向都朝上（屏幕坐标 y 为负），不会喷到脚下', () => {
    const list = heartBurstSpec({ count: 30, rng: seeded(9) })
    for (const p of list) {
      expect(p.dirY).toBeLessThan(-0.4)
      const end = heartEnd(p)
      expect(end.y).toBeLessThan(0)
    }
  })

  it('默认密度够"喷发"（80 颗，开头 6 颗同时爆开）', () => {
    const list = heartBurstSpec({ rng: seeded(11) })
    expect(list.length).toBe(80)
    expect(list.filter((p) => p.startAt <= 200).length).toBeGreaterThanOrEqual(5)
  })

  it('自定义时长也遵守"最后一个粒子在窗口内"', () => {
    const list = heartBurstSpec({ count: 10, durationMs: 3000, rng: seeded(3) })
    const last = list[list.length - 1]
    expect(last.startAt + last.life).toBeLessThanOrEqual(3000)
  })
})

describe('透明度曲线（运动过程中快速变淡）', () => {
  it('前 15% 保持不透明，随后快速衰减到 0', () => {
    expect(heartOpacity(0)).toBe(1)
    expect(heartOpacity(0.15)).toBe(1)
    expect(heartOpacity(0.4)).toBeCloseTo(0.545, 2)
    expect(heartOpacity(0.7)).toBe(0)
    expect(heartOpacity(1)).toBe(0)
  })

  it('越界输入夹到 0..1', () => {
    expect(heartOpacity(-1)).toBe(1)
    expect(heartOpacity(2)).toBe(0)
  })
})

describe('particleProgress', () => {
  const p: HeartParticle = {
    x: 0, distance: 50, dirX: 0, dirY: -1, size: 16, startAt: 1000, life: 1000, rotate: 0, sway: 0
  }

  it('未到出现时刻返回 null', () => {
    expect(particleProgress(p, 500)).toBeNull()
  })

  it('生命周期内返回 0..1，结束后返回 -1', () => {
    expect(particleProgress(p, 1000)).toBe(0)
    expect(particleProgress(p, 1500)).toBeCloseTo(0.5, 5)
    expect(particleProgress(p, 2000)).toBe(1)
    expect(particleProgress(p, 2100)).toBe(-1)
  })
})
