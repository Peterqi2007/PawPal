// 人格气泡池单测（对应 viewer/src/persona-bubbles.ts）
// 覆盖：人格校验、池完整性、随机抽取、避开上一条、缺省回退
import { describe, it, expect } from 'vitest'
import { PERSONAS, SCENES, PERSONA_POOLS, isPersona, bubblesFor, pickBubble } from '../src/persona-bubbles'

describe('人格与场景枚举', () => {
  it('3 种人格 / 4 个场景', () => {
    expect(PERSONAS).toEqual(['温柔', '傲娇', '搞笑'])
    expect(SCENES).toEqual(['head', 'feed', 'water', 'focusEnd'])
  })

  it('isPersona 只认可三种', () => {
    expect(isPersona('温柔')).toBe(true)
    expect(isPersona('温柔 ')).toBe(false)
    expect(isPersona(undefined)).toBe(false)
    expect(isPersona('暴躁')).toBe(false)
  })

  it('每个池都非空（12 个池）', () => {
    for (const p of PERSONAS) {
      for (const s of SCENES) {
        expect(PERSONA_POOLS[p][s].length).toBeGreaterThanOrEqual(3)
      }
    }
  })
})

describe('bubblesFor', () => {
  it('合法人格返回池', () => {
    expect(bubblesFor('傲娇', 'head')!.length).toBeGreaterThan(0)
  })

  it('非法人格/场景返回 undefined（调用方回退 pet.bubbles）', () => {
    expect(bubblesFor(undefined, 'head')).toBeUndefined()
    expect(bubblesFor('暴躁', 'head')).toBeUndefined()
  })
})

describe('pickBubble', () => {
  it('按 rng 选取（不越界）', () => {
    expect(pickBubble('温柔', 'feed', () => 0)).toBe(PERSONA_POOLS['温柔'].feed[0])
    expect(pickBubble('温柔', 'feed', () => 0.9999)).toBe(PERSONA_POOLS['温柔'].feed[2])
  })

  it('避开上一条（池中多条时）', () => {
    const first = PERSONA_POOLS['搞笑'].water[0]
    for (let i = 0; i < 5; i++) {
      expect(pickBubble('搞笑', 'water', () => 0, first)).not.toBe(first)
    }
  })

  it('非法人格返回 undefined', () => {
    expect(pickBubble('暴躁', 'head')).toBeUndefined()
  })

  it('4 个场景都能取到文案', () => {
    for (const s of SCENES) {
      expect(typeof pickBubble('温柔', s)).toBe('string')
    }
  })
})
