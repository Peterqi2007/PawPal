// 专注态渲染副作用单测（对应 viewer/src/focus.ts）
import { describe, it, expect } from 'vitest'
import { applyFocusState, focusLabel, FOCUS_FILTER } from '../src/focus'

describe('applyFocusState', () => {
  it('进入专注：暂停随机 + 变暗滤镜 + 休息态', () => {
    const fx = applyFocusState(true)
    expect(fx.pauseRandom).toBe(true)
    expect(fx.filter).toBe(FOCUS_FILTER)
    expect(fx.resting).toBe(true)
  })

  it('退出专注：恢复随机 + 无滤镜', () => {
    const fx = applyFocusState(false)
    expect(fx.pauseRandom).toBe(false)
    expect(fx.filter).toBe('')
    expect(fx.resting).toBe(false)
  })
})

describe('focusLabel', () => {
  it('专注中/普通两种 aria 文案', () => {
    expect(focusLabel(true, '豆豆')).toContain('专注中')
    expect(focusLabel(false, '豆豆')).toBe('豆豆（桌面宠物）')
  })
})
