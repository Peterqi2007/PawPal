// 数值 → 桌宠表现 单测（对应 viewer/src/pet-expression.ts）
// 口径：饱腹<30 瘫倒喊饿；>80 开心跳跃；心情<30 背对冒乌云；>80 冒爱心
import { describe, it, expect } from 'vitest'
import {
  expressionOf,
  thresholdBubble,
  LOW_SATIETY,
  HIGH_SATIETY,
  LOW_MOOD,
  HIGH_MOOD,
  BUBBLE_HUNGRY,
  BUBBLE_HAPPY_FULL,
  BUBBLE_SAD,
  BUBBLE_LOVED
} from '../src/pet-expression'

describe('expressionOf 阈值', () => {
  it('饱腹 < 30 瘫倒并喊饿', () => {
    const e = expressionOf({ mood: 60, satiety: 29 })
    expect(e.collapsed).toBe(true)
    expect(e.jump).toBe(false)
    expect(e.bubble).toBe(BUBBLE_HUNGRY)
  })

  it('饱腹 30 不算低（边界不瘫倒）', () => {
    expect(expressionOf({ mood: 60, satiety: LOW_SATIETY }).collapsed).toBe(false)
  })

  it('饱腹 > 80 开心跳跃', () => {
    const e = expressionOf({ mood: 60, satiety: 81 })
    expect(e.jump).toBe(true)
    expect(e.collapsed).toBe(false)
  })

  it('饱腹 80 不跳跃（严格大于）', () => {
    expect(expressionOf({ mood: 60, satiety: HIGH_SATIETY }).jump).toBe(false)
  })

  it('心情 < 30 背对 + 乌云', () => {
    const e = expressionOf({ mood: 29, satiety: 60 })
    expect(e.moodFace).toBe('sad')
    expect(e.overlay).toBe('cloud')
    expect(e.bubble).toBe(BUBBLE_SAD)
  })

  it('心情 > 80 冒爱心', () => {
    const e = expressionOf({ mood: 81, satiety: 60 })
    expect(e.moodFace).toBe('happy')
    expect(e.overlay).toBe('hearts')
  })

  it('中间区间什么都不做', () => {
    expect(expressionOf({ mood: LOW_MOOD, satiety: HIGH_SATIETY }))
      .toEqual({ collapsed: false, jump: false, moodFace: 'normal', overlay: '', bubble: '' })
    expect(expressionOf({ mood: 60, satiety: 60 }).overlay).toBe('')
  })

  it('饿肚子优先于难过（只冒一条气泡）', () => {
    const e = expressionOf({ mood: 10, satiety: 10 })
    expect(e.collapsed).toBe(true)
    expect(e.moodFace).toBe('sad')
    expect(e.bubble).toBe(BUBBLE_HUNGRY)
  })

  it('空值/非法值不崩，返回空表现', () => {
    for (const v of [null, undefined, {} as never, { mood: 'x' } as never]) {
      expect(expressionOf(v as never)).toEqual({
        collapsed: false, jump: false, moodFace: 'normal', overlay: '', bubble: ''
      })
    }
  })
})

describe('thresholdBubble 只在跨过阈值时冒泡', () => {
  it('跌到 30 以下才喊饿，继续低不重复喊', () => {
    expect(thresholdBubble({ mood: 60, satiety: 40 }, { mood: 60, satiety: 20 })).toBe(BUBBLE_HUNGRY)
    expect(thresholdBubble({ mood: 60, satiety: 20 }, { mood: 60, satiety: 15 })).toBe('')
  })

  it('从饥饿状态被喂饱时给一次正反馈', () => {
    expect(thresholdBubble({ mood: 60, satiety: 20 }, { mood: 60, satiety: 60 })).toBe(BUBBLE_HAPPY_FULL)
  })

  it('刚超过 80 时说一次"吃得好饱"', () => {
    expect(thresholdBubble({ mood: 60, satiety: 79 }, { mood: 60, satiety: 90 })).toBe(BUBBLE_HAPPY_FULL)
    expect(thresholdBubble({ mood: 60, satiety: 85 }, { mood: 60, satiety: 95 })).toBe('')
  })

  it('心情跌到 30 以下才难过，涨过 80 才示爱', () => {
    expect(thresholdBubble({ mood: 40, satiety: 60 }, { mood: 25, satiety: 60 })).toBe(BUBBLE_SAD)
    expect(thresholdBubble({ mood: 25, satiety: 60 }, { mood: 20, satiety: 60 })).toBe('')
    expect(thresholdBubble({ mood: 75, satiety: 60 }, { mood: 85, satiety: 60 })).toBe(BUBBLE_LOVED)
  })

  it('没有上一次数据时按"从正常跌到异常"处理：会提示饿（启动路径由调用方传 bubble:false 抑制）', () => {
    expect(thresholdBubble(null, { mood: 20, satiety: 20 })).toBe(BUBBLE_HUNGRY)
    expect(thresholdBubble(null, { mood: 20, satiety: 60 })).toBe(BUBBLE_SAD)
    expect(thresholdBubble(null, { mood: 60, satiety: 60 })).toBe('')
  })
})
