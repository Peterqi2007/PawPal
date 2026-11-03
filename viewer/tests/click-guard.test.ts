// 单击判定单测（对应 viewer/src/click-guard.ts）
// 这是"没点它，饱腹值却自己在涨"那个事故的回归测试
import { describe, it, expect } from 'vitest'
import { isClickGesture, CLICK_MAX_DIST } from '../src/click-guard'

describe('isClickGesture', () => {
  it('正常点击：有按下、抬起位置几乎相同 → true', () => {
    expect(isClickGesture({ x: 100, y: 100 }, { x: 101, y: 101 })).toBe(true)
  })

  it('没有配对的按下（孤立抬起）→ false（事故根因）', () => {
    expect(isClickGesture(null, { x: 100, y: 100 })).toBe(false)
    expect(isClickGesture(undefined, { x: 100, y: 100 })).toBe(false)
  })

  it('抬起位置缺失 → false', () => {
    expect(isClickGesture({ x: 100, y: 100 }, null)).toBe(false)
  })

  it('移动超过阈值算拖拽，不算点击', () => {
    expect(isClickGesture({ x: 100, y: 100 }, { x: 100 + CLICK_MAX_DIST, y: 100 })).toBe(false)
    expect(isClickGesture({ x: 100, y: 100 }, { x: 130, y: 100 })).toBe(false)
  })

  it('阈值内（严格小于）仍算点击', () => {
    expect(isClickGesture({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(true) // 距离 5
  })

  it('非法数值不崩 → false', () => {
    expect(isClickGesture({ x: NaN, y: 0 }, { x: 0, y: 0 })).toBe(false)
    expect(isClickGesture({ x: 0, y: 0 }, { x: 'a' as unknown as number, y: 0 })).toBe(false)
  })
})
