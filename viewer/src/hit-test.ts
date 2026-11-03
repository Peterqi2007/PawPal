// 左键分区命中判定（纯函数，可单测）
//
// 目标：点头部 = 摸头，点身体 = 喂食，点透明区 = 无反应。
// 判定顺序：① 是否在精灵包围盒内 → ② 该点 alpha 是否不透明 → ③ 上半区算头部
// 之所以要 alpha：桌宠四周是大片透明（fixture 里 52%~89% 透明），只按包围盒判定会让
// 用户在"空气"上点头也有反应。

export type HitRegion = 'head' | 'body'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** 头部占包围盒高度的比例（头顶到 40% 处） */
export const HEAD_RATIO = 0.4
/** alpha 低于该值视为透明（0-255） */
export const ALPHA_THRESHOLD = 16
/** 归一化坐标以外的快速失败阈值 */
const EPS = 1e-6

export function insideBounds(bounds: Bounds, x: number, y: number): boolean {
  if (!(bounds.width > 0) || !(bounds.height > 0)) return false
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height
}

/**
 * 屏幕/视口坐标 → canvas 布局坐标（PIXI 坐标系）。
 *
 * 为什么需要：桌宠有"呼吸/左右平移"动效，它作用在 canvas 的包装层（.pet-stage）上，
 * 会改变 getBoundingClientRect()（最多 ±3px 平移 + 1.5% 缩放），
 * 而 sprite.getBounds() 是**未变换**的布局坐标。直接用 clientX/clientY 比对，
 * 在头/身边界处会出现几个像素的错判（实测把"摸头"判成了"喂食"）。
 */
export function toLayoutPoint(input: {
  clientX: number
  clientY: number
  rectLeft: number
  rectTop: number
  rectWidth: number
  rectHeight: number
  layoutWidth: number
  layoutHeight: number
}): { x: number; y: number } {
  const {
    clientX, clientY, rectLeft, rectTop, rectWidth, rectHeight, layoutWidth, layoutHeight
  } = input
  const sx = rectWidth > 0 && layoutWidth > 0 ? rectWidth / layoutWidth : 1
  const sy = rectHeight > 0 && layoutHeight > 0 ? rectHeight / layoutHeight : 1
  return { x: (clientX - rectLeft) / sx, y: (clientY - rectTop) / sy }
}

/** 屏幕坐标 → 纹理归一化坐标（0-1）；越界返回 null */
export function toUv(bounds: Bounds, x: number, y: number): { u: number; v: number } | null {
  if (!insideBounds(bounds, x, y)) return null
  const u = (x - bounds.x) / bounds.width
  const v = (y - bounds.y) / bounds.height
  if (u < -EPS || u > 1 + EPS || v < -EPS || v > 1 + EPS) return null
  return { u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) }
}

/** 从 size×size 的 alpha 图里按归一化坐标取值（最近邻） */
export function alphaAt(map: Uint8ClampedArray, size: number, u: number, v: number): number {
  if (!map || size <= 0 || map.length < size * size) return 255 // 图不可用时按不透明处理（退化为区域判定）
  const cx = Math.min(size - 1, Math.max(0, Math.floor(u * size)))
  const cy = Math.min(size - 1, Math.max(0, Math.floor(v * size)))
  return map[cy * size + cx]
}

export function shouldReact(alpha: number, threshold = ALPHA_THRESHOLD): boolean {
  return alpha >= threshold
}

/** 按包围盒上下分区（与 alpha 无关） */
export function regionOf(bounds: Bounds, y: number, headRatio = HEAD_RATIO): HitRegion {
  const cut = bounds.y + bounds.height * headRatio
  return y < cut ? 'head' : 'body'
}

export interface NormBBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * 从 alpha 缩略图里求"主体实际占据的范围"（归一化坐标）。
 * 为什么需要：精灵表四周是大片透明（fixture 里 52%~89%），
 * 按整帧切 40% 会把"背上的空气"判成头、把真正的头判成身体。
 */
export function alphaBBox(map: Uint8ClampedArray, size: number, threshold = ALPHA_THRESHOLD): NormBBox | null {
  if (!map || size <= 0 || map.length < size * size) return null
  let x0 = size, y0 = size, x1 = -1, y1 = -1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (map[y * size + x] >= threshold) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0 || y1 < 0) return null // 全透明
  return { x0: x0 / size, y0: y0 / size, x1: (x1 + 1) / size, y1: (y1 + 1) / size }
}

/**
 * 完整判定：在包围盒内 + 该点不透明 + 分区。
 * 有 alpha 图时，头/身分界按**主体实际范围**算（不是整帧），否则按整帧。
 * alphaMap 为 null 时退化为"只按区域判定"（素材不含 alpha 的老包）。
 */
export function resolveHit(
  bounds: Bounds,
  x: number,
  y: number,
  alphaMap: Uint8ClampedArray | null = null,
  opts: { headRatio?: number; threshold?: number; mapSize?: number } = {}
): HitRegion | null {
  const uv = toUv(bounds, x, y)
  if (!uv) return null
  const size = opts.mapSize || 64
  const threshold = opts.threshold ?? ALPHA_THRESHOLD
  const headRatio = opts.headRatio ?? HEAD_RATIO
  if (alphaMap) {
    const alpha = alphaAt(alphaMap, size, uv.u, uv.v)
    if (!shouldReact(alpha, threshold)) return null
    const bb = alphaBBox(alphaMap, size, threshold)
    if (bb && bb.y1 > bb.y0) {
      const cut = bounds.y + (bb.y0 + (bb.y1 - bb.y0) * headRatio) * bounds.height
      return y < cut ? 'head' : 'body'
    }
  }
  return regionOf(bounds, y, headRatio)
}

/**
 * 把 RGBA 像素缩到 size×size 的 alpha 图（供上面的判定使用）。
 * 抽成纯函数便于单测：输入/输出都不依赖 canvas。
 */
export function buildAlphaMap(rgba: Uint8ClampedArray, width: number, height: number, size = 64): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size)
  if (!rgba || width <= 0 || height <= 0) return out
  for (let y = 0; y < size; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / size))
    for (let x = 0; x < size; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / size))
      out[y * size + x] = rgba[(sy * width + sx) * 4 + 3]
    }
  }
  return out
}
