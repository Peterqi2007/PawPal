// 点击分区 → 交互意图 单测（对应 viewer/src/tap-action.ts）
// 回归：方案 C 之后，点身体绝不能再产生数值变化（只给提示）
import { describe, it, expect } from 'vitest'
import { tapIntent, FEED_HINT } from '../src/tap-action'

describe('tapIntent', () => {
  it('头部 → 摸头', () => {
    expect(tapIntent('head')).toBe('pat')
  })

  it('身体 → 只给提示（不喂食）', () => {
    expect(tapIntent('body')).toBe('hint')
  })

  it('未知/空区域按提示处理（宁可不动数值）', () => {
    expect(tapIntent(null)).toBe('hint')
    expect(tapIntent(undefined)).toBe('hint')
  })

  it('提示文案指明了喂食入口', () => {
    expect(FEED_HINT).toContain('已完成')
  })
})
