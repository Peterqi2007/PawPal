// 左键分区命中判定单测（对应 viewer/src/hit-test.ts）
// 覆盖：包围盒内外、头身分界、透明区判定、归一化坐标、alpha 缩略图构建
import { describe, it, expect } from 'vitest'
import {
  HEAD_RATIO,
  ALPHA_THRESHOLD,
  insideBounds,
  toUv,
  alphaAt,
  shouldReact,
  regionOf,
  resolveHit,
  buildAlphaMap,
  alphaBBox,
  toLayoutPoint
} from '../src/hit-test'

const box = { x: 100, y: 100, width: 200, height: 200 }

describe('insideBounds', () => {
  it('内部/四边为真，外部为假', () => {
    expect(insideBounds(box, 150, 150)).toBe(true)
    expect(insideBounds(box, 100, 100)).toBe(true)
    expect(insideBounds(box, 300, 300)).toBe(true)
    expect(insideBounds(box, 99, 150)).toBe(false)
    expect(insideBounds(box, 301, 150)).toBe(false)
  })

  it('零尺寸不做判定', () => {
    expect(insideBounds({ x: 0, y: 0, width: 0, height: 10 }, 0, 5)).toBe(false)
  })
})

describe('toUv', () => {
  it('中心为 0.5', () => {
    const uv = toUv(box, 200, 200)
    expect(uv).not.toBeNull()
    expect(uv!.u).toBeCloseTo(0.5, 5)
    expect(uv!.v).toBeCloseTo(0.5, 5)
  })

  it('越界返回 null', () => {
    expect(toUv(box, 0, 0)).toBeNull()
  })
})

describe('regionOf', () => {
  it('按 HEAD_RATIO 切头/身', () => {
    const cut = box.y + box.height * HEAD_RATIO
    expect(regionOf(box, cut - 1)).toBe('head')
    expect(regionOf(box, cut + 1)).toBe('body')
  })
})

describe('alphaAt / shouldReact', () => {
  it('最近邻取值', () => {
    const map = new Uint8ClampedArray(4 * 4)
    map[0] = 0
    map[3] = 255 // 右上角
    expect(alphaAt(map, 4, 0.0, 0.0)).toBe(0)
    expect(alphaAt(map, 4, 0.99, 0.0)).toBe(255)
  })

  it('阈值：低于 ALPHA_THRESHOLD 视为透明', () => {
    expect(shouldReact(ALPHA_THRESHOLD - 1)).toBe(false)
    expect(shouldReact(ALPHA_THRESHOLD)).toBe(true)
  })

  it('map 尺寸不符时按不透明处理（退化为区域判定）', () => {
    expect(alphaAt(new Uint8ClampedArray(2), 8, 0.5, 0.5)).toBe(255)
  })
})

describe('resolveHit', () => {
  const opaque = new Uint8ClampedArray(64 * 64).fill(255)
  const clear = new Uint8ClampedArray(64 * 64).fill(0)

  it('不透明 + 上部 = head', () => {
    expect(resolveHit(box, 200, 120, opaque)).toBe('head')
  })

  it('不透明 + 下部 = body', () => {
    expect(resolveHit(box, 200, 280, opaque)).toBe('body')
  })

  it('透明区不响应（返回 null）', () => {
    expect(resolveHit(box, 200, 200, clear)).toBeNull()
  })

  it('头身分界按主体实际范围算（不是整帧）', () => {
    // 主体只占垂直中段 30%~70%：分界应落在 30% + 40%*40% = 46% 处
    const size = 64
    const map = new Uint8ClampedArray(size * size)
    for (let y = Math.floor(size * 0.3); y < size * 0.7; y++) {
      for (let x = 0; x < size; x++) map[y * size + x] = 255
    }
    const topY = box.y + box.height * 0.4 // 40%：按整帧算应为 head，按主体算应为 head 也算；取 50% 判 body
    expect(resolveHit(box, 200, topY, map)).toBe('head')
    const midY = box.y + box.height * 0.5 // 50%：整帧判 body，主体算仍是 body
    expect(resolveHit(box, 200, midY, map)).toBe('body')
    // 0.75 处落在主体之外 → 透明，不响应
    expect(resolveHit(box, 200, box.y + box.height * 0.75, map)).toBeNull()
  })

  it('包围盒外不响应', () => {
    expect(resolveHit(box, 10, 10, opaque)).toBeNull()
  })

  it('无 alpha 图时退化为区域判定', () => {
    expect(resolveHit(box, 200, 120, null)).toBe('head')
    expect(resolveHit(box, 200, 280, null)).toBe('body')
  })
})

describe('toLayoutPoint（动效变换 → 布局坐标）', () => {
  it('无缩放无平移时直通', () => {
    const r = toLayoutPoint({ clientX: 100, clientY: 50, rectLeft: 0, rectTop: 0, rectWidth: 288, rectHeight: 288, layoutWidth: 288, layoutHeight: 288 })
    expect(r).toEqual({ x: 100, y: 50 })
  })

  it('包装层缩放 1.015 + 偏移 -1 时换算回布局坐标', () => {
    const r = toLayoutPoint({
      clientX: 100, clientY: 150,
      rectLeft: -1, rectTop: -1, rectWidth: 288 * 1.015, rectHeight: 288 * 1.015,
      layoutWidth: 288, layoutHeight: 288
    })
    expect(r.x).toBeCloseTo((100 + 1) / 1.015, 3)
    expect(r.y).toBeCloseTo((150 + 1) / 1.015, 3)
  })

  it('非法尺寸不除零', () => {
    const r = toLayoutPoint({ clientX: 10, clientY: 20, rectLeft: 0, rectTop: 0, rectWidth: 0, rectHeight: 0, layoutWidth: 0, layoutHeight: 0 })
    expect(r).toEqual({ x: 10, y: 20 })
  })
})

describe('alphaBBox', () => {
  it('全不透明 = 整个范围', () => {
    const map = new Uint8ClampedArray(4 * 4).fill(255)
    expect(alphaBBox(map, 4)).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 })
  })

  it('全透明 = null', () => {
    expect(alphaBBox(new Uint8ClampedArray(4 * 4), 4)).toBeNull()
  })

  it('窄条只覆盖该条', () => {
    const size = 8
    const map = new Uint8ClampedArray(size * size)
    for (let y = 2; y < 6; y++) for (let x = 0; x < size; x++) map[y * size + x] = 255
    const bb = alphaBBox(map, size)!
    expect(bb.y0).toBeCloseTo(2 / 8, 5)
    expect(bb.y1).toBeCloseTo(6 / 8, 5)
  })
})

describe('buildAlphaMap', () => {  it('从 RGBA 提取 alpha 并降采样', () => {
    const w = 4
    const h = 4
    const rgba = new Uint8ClampedArray(w * h * 4)
    // 左上 2×2 不透明，其余透明
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) rgba[(y * w + x) * 4 + 3] = 255
    }
    const map = buildAlphaMap(rgba, w, h, 4)
    expect(map.length).toBe(16)
    expect(map[0]).toBe(255)
    expect(map[15]).toBe(0)
  })

  it('空输入返回全零而非崩溃', () => {
    const map = buildAlphaMap(new Uint8ClampedArray(0), 0, 0, 2)
    expect(map.length).toBe(4)
    expect(Array.from(map)).toEqual([0, 0, 0, 0])
  })
})
