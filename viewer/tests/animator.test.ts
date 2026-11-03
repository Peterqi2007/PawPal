// animator 测试（对应 viewer/animator.cjs）
// 重点验证「边缘连通域抠图」不误删内部白色（白胸脯/白腿），这是 docs/07 里色度抠图的老坑
import { describe, it, expect } from 'vitest'
import {
  CHROMA_KEY,
  MAX_SHEET_WIDTH,
  buildActionSpec,
  chromaKeyAlpha,
  detectGreenBackground,
  edgeFloodAlpha,
  greenRatioOfBitmap,
  layoutSheet,
  safeSlug,
  sampleTimes,
  trimBounds,
  validateSheet
} from '../animator.cjs'

const W = 40
const H = 40

/** 造一张 RGBA 图：绿背景 + 中央棕色块 + 棕色块内一块纯白 */
function makeFrame() {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const inBlob = x >= 12 && x < 28 && y >= 12 && y < 28
      const inWhite = x >= 18 && x < 22 && y >= 18 && y < 22
      if (inWhite) {
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
      } else if (inBlob) {
        data[i] = 150; data[i + 1] = 75; data[i + 2] = 0
      } else {
        data[i] = 0; data[i + 1] = 200; data[i + 2] = 0 // 绿幕
      }
      data[i + 3] = 255
    }
  }
  return data
}

const alphaAt = (data: Uint8ClampedArray, x: number, y: number) => data[(y * W + x) * 4 + 3]

describe('边缘连通域抠图', () => {
  it('绿幕被清除，主体保留', () => {
    const data = makeFrame()
    const r = edgeFloodAlpha(data, W, H, { tolerance: 60 })
    expect(r.removed).toBeGreaterThan(0)
    expect(alphaAt(data, 0, 0)).toBe(0) // 左上角背景
    expect(alphaAt(data, 39, 39)).toBe(0) // 右下角背景
    expect(alphaAt(data, 15, 15)).toBe(255) // 棕色主体
  })

  it('主体内部的纯白不会被误删（关键：与边缘不连通）', () => {
    const data = makeFrame()
    edgeFloodAlpha(data, W, H, { tolerance: 60 })
    expect(alphaAt(data, 19, 19)).toBe(255) // 白胸脯
  })

  it('背景色来自四边采样，前景干扰不影响判定', () => {
    const data = makeFrame()
    // 在中央放一块很亮的区域（模拟高光），不应被当成背景
    const r = edgeFloodAlpha(data, W, H, { tolerance: 60 })
    expect(r.bg[1]).toBeGreaterThan(150) // 绿通道占优 → 判定为绿幕
    expect(alphaAt(data, 20, 20)).toBe(255)
  })

  it('全同色画面：全部清空后 trimBounds 返回 null', () => {
    const flat = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      flat[i * 4] = 10; flat[i * 4 + 1] = 10; flat[i * 4 + 2] = 10; flat[i * 4 + 3] = 255
    }
    edgeFloodAlpha(flat, W, H, { tolerance: 42 })
    expect(trimBounds(flat, W, H)).toBeNull()
  })
})

describe('绿幕抠图（chroma）', () => {
  /** 纯绿 #00C800 背景 + 棕色主体 + 主体内白色 */
  function makeGreenFrame() {
    const data = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        const inBlob = x >= 12 && x < 28 && y >= 12 && y < 28
        const inWhite = x >= 18 && x < 22 && y >= 18 && y < 22
        if (inWhite) {
          data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
        } else if (inBlob) {
          data[i] = 150; data[i + 1] = 75; data[i + 2] = 0
        } else {
          data[i] = 0; data[i + 1] = 200; data[i + 2] = 0 // 绿幕
        }
        data[i + 3] = 255
      }
    }
    return data
  }

  it('绿幕被整片清除，主体与内部白色保留', () => {
    const data = makeGreenFrame()
    const r = chromaKeyAlpha(data, W, H, { tolerance: 110, feather: 0 })
    expect(r.removed).toBeGreaterThan(0)
    expect(alphaAt(data, 0, 0)).toBe(0)
    expect(alphaAt(data, 39, 39)).toBe(0)
    expect(alphaAt(data, 15, 15)).toBe(255) // 棕毛
    expect(alphaAt(data, 19, 19)).toBe(255) // 白斑
  })

  it('自动拾取键色：实际绿不是 #00C800 也能抠干净', () => {
    // 模型实测输出过的深绿 #00861E，带明暗渐变
    const dark = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        const inBlob = x >= 12 && x < 28 && y >= 12 && y < 28
        const shade = 1 - (y / H) * 0.25 // 上亮下暗
        if (inBlob) {
          dark[i] = 150; dark[i + 1] = 75; dark[i + 2] = 0
        } else {
          dark[i] = 0
          dark[i + 1] = Math.round(134 * shade)
          dark[i + 2] = Math.round(30 * shade)
        }
        dark[i + 3] = 255
      }
    }
    const r = chromaKeyAlpha(dark, W, H, { feather: 0 }) // 不传 keyColor → 自动
    expect(r.removed).toBeGreaterThan(W * H * 0.6)
    expect(alphaAt(dark, 0, 0)).toBe(0) // 亮处
    expect(alphaAt(dark, 0, H - 1)).toBe(0) // 暗处（旧实现在这里会留绿）
    expect(alphaAt(dark, 20, 20)).toBe(255) // 棕色主体保留
  })

  it('显式指定键色时不会误删其它色（灰底保持不透明）', () => {
    const gray = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      gray[i * 4] = 128; gray[i * 4 + 1] = 128; gray[i * 4 + 2] = 128; gray[i * 4 + 3] = 255
    }
    const r = chromaKeyAlpha(gray, W, H, { keyColor: [0, 200, 0], tolerance: 60, feather: 0 })
    expect(r.removed).toBe(0)
    expect(alphaAt(gray, 0, 0)).toBe(255)
  })

  it('detectGreenBackground 能区分绿幕与灰底', () => {
    expect(detectGreenBackground(makeGreenFrame(), W, H)).toBeGreaterThan(0.8)
    const gray = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      gray[i * 4] = 128; gray[i * 4 + 1] = 128; gray[i * 4 + 2] = 128; gray[i * 4 + 3] = 255
    }
    expect(detectGreenBackground(gray, W, H)).toBeLessThan(0.3)
  })

  it('绿幕模式同样能裁出主体边界', () => {
    const data = makeGreenFrame()
    chromaKeyAlpha(data, W, H, { tolerance: 110, feather: 0 })
    const box = trimBounds(data, W, H)
    expect(box).toEqual({ x: 12, y: 12, width: 16, height: 16 })
  })
})

describe('首帧绿幕检测（greenRatioOfBitmap）', () => {
  /** 造 BGRA 缓冲：四边填充指定颜色 */
  function makeBgra(w: number, h: number, rgb: [number, number, number]) {
    const buf = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      buf[i * 4] = rgb[2] // B
      buf[i * 4 + 1] = rgb[1] // G
      buf[i * 4 + 2] = rgb[0] // R
      buf[i * 4 + 3] = 255
    }
    return buf
  }

  it('绿幕底 → 占比接近 1', () => {
    expect(greenRatioOfBitmap(makeBgra(64, 64, [0, 200, 0]), 64, 64)).toBeGreaterThan(0.95)
  })

  it('灰底 / 实景 → 占比接近 0', () => {
    expect(greenRatioOfBitmap(makeBgra(64, 64, [128, 128, 128]), 64, 64)).toBeLessThan(0.05)
    expect(greenRatioOfBitmap(makeBgra(64, 64, [90, 120, 60]), 64, 64)).toBeLessThan(0.05)
  })

  it('空缓冲不崩，返回 0', () => {
    expect(greenRatioOfBitmap(new Uint8ClampedArray(0), 0, 0)).toBe(0)
  })
})

describe('裁剪与布局', () => {
  it('trimBounds 只框住非透明区域', () => {
    const data = makeFrame()
    edgeFloodAlpha(data, W, H, { tolerance: 60 })
    const box = trimBounds(data, W, H)
    expect(box).toEqual({ x: 12, y: 12, width: 16, height: 16 })
  })

  it('总宽超过 16384 直接拒绝（WebGL 纹理硬上限）', () => {
    expect(validateSheet(24, 1024).ok).toBe(false)
    expect(validateSheet(24, 1024).error).toContain('16384')
    expect(validateSheet(12, 512).ok).toBe(true)
    expect(MAX_SHEET_WIDTH).toBe(16384)
  })

  it('layoutSheet 给出总宽高与单帧尺寸', () => {
    const l = layoutSheet(12, 512)
    expect(l.ok).toBe(true)
    expect(l.width).toBe(6144)
    expect(l.height).toBe(512)
  })

  it('帧数/尺寸越界给出可读错误', () => {
    expect(validateSheet(2, 512).ok).toBe(false)
    expect(validateSheet(12, 2048).ok).toBe(false)
  })
})

describe('pet.json 动作片段', () => {
  it('字段与 docs/08 契约一致', () => {
    const spec = buildActionSpec({ action: 'idle', frames: 12, cell: 512, fps: 5 })
    expect(spec.file).toBe('idle-sheet.png')
    expect(spec.frames).toBe(12)
    expect(spec.fps).toBe(5)
    expect(spec.frameWidth).toBe(512)
    expect(spec.frameHeight).toBe(512)
    expect(spec.weight).toBe(100) // idle 权重最高，参与随机演示
    expect(spec.diary.text).toContain('{name}')
  })

  it('目录名安全化：中文/空格/特殊字符 → 连字符', () => {
    expect(safeSlug('我的宠物')).toBe('pet')
    expect(safeSlug('Dou Dou!')).toBe('dou-dou')
    expect(safeSlug('')).toBe('pet')
  })
})

describe('抽帧时间点', () => {
  it('取每段中点，避开首尾转场', () => {
    const t = sampleTimes(5, 5)
    expect(t).toHaveLength(5)
    expect(t[0]).toBeCloseTo(0.5, 2)
    expect(t[4]).toBeCloseTo(4.5, 2)
  })

  it('时长非法时返回空数组', () => {
    expect(sampleTimes(0, 5)).toEqual([])
    expect(sampleTimes(NaN, 5)).toEqual([])
  })
})
