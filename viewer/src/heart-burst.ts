// 开心喷发：心情 > 80 时从头部长出一串爱心，向外飞散并快速淡出（纯逻辑，可单测）
//
// 为什么单独抽出来：粒子的角度/距离/生命周期都是可测的参数，
// 渲染层只负责按这些参数创建 DOM 并交给 Web Animations 播放。
// 随机数可注入（seed），测试才能稳定断言。

export const HEART_BURST_MS = 10_000 // 一次喷发持续 10 秒（产品口径）
export const HEART_GLYPH = '💗'

export interface HeartParticle {
  /** 起点的水平偏移（px，相对头心） */
  x: number
  /** 飞行距离（px） */
  distance: number
  /** 水平/垂直方向的单位分量（抛物线用） */
  dirX: number
  dirY: number
  /** 字号（px） */
  size: number
  /** 该粒子出现时刻（相对喷发开始的 ms） */
  startAt: number
  /** 单粒子生命周期（ms）——越快淡出越"喷发" */
  life: number
  /** 初始旋转角度（deg） */
  rotate: number
  /** 水平摆动幅度（px） */
  sway: number
}

/** 可注入的伪随机（默认 Math.random；测试传固定序列） */
export type Rng = () => number

/**
 * 生成本次喷发的全部粒子。
 * 粒子按 startAt 排序铺满 durationMs，最后一个粒子的 life 一定在 durationMs 内结束。
 */
export function heartBurstSpec(opts: {
  count?: number
  durationMs?: number
  rng?: Rng
} = {}): HeartParticle[] {
  const count = Math.max(1, Math.floor(opts.count ?? 80))
  const durationMs = Math.max(1000, Math.floor(opts.durationMs ?? HEART_BURST_MS))
  const rng: Rng = opts.rng || Math.random
  const out: HeartParticle[] = []

  for (let i = 0; i < count; i++) {
    const life = 820 + Math.round(rng() * 560) // 0.8–1.4s：飞出去就淡掉一大半
    // 起点沿头顶横向散开（头顶不是一个点，是一条弧）
    const x = Math.round((rng() - 0.5) * 46)
    // 扇形向上：-65°~65°（0° = 正上方）
    const angle = (rng() - 0.5) * (Math.PI * 2 * (65 / 360))
    const distance = 40 + Math.round(rng() * 60)
    const size = 12 + Math.round(rng() * 12)
    const rotate = Math.round((rng() - 0.5) * 40)
    const sway = Math.round((rng() - 0.5) * 16)

    // 开头 6 颗同时爆开（喷发感），其余均匀铺开 + 轻微抖动
    const slot = durationMs / count
    const startAt = i < 6
      ? Math.round(rng() * 160)
      : Math.round(Math.min(durationMs - life, i * slot + rng() * slot * 0.6))

    out.push({
      x,
      distance,
      dirX: Math.sin(angle),
      dirY: -Math.cos(angle), // 屏幕坐标：向上是负
      size,
      startAt: Math.max(0, startAt),
      life,
      rotate,
      sway
    })
  }

  return out.sort((a, b) => a.startAt - b.startAt)
}

/** 粒子在 t 时刻的进度 0..1（超出生命周期返回 null，表示该移除） */
export function particleProgress(p: HeartParticle, t: number): number | null {
  if (t < p.startAt) return null
  const local = t - p.startAt
  if (local > p.life) return -1 // 已结束（调用方据此跳过）
  return Math.min(1, Math.max(0, local / p.life))
}

/** 透明度曲线：前 15% 保持，之后快速变淡（"运动过程中快速变淡"） */
export function heartOpacity(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  if (p <= 0.15) return 1
  const v = 1 - (p - 0.15) / 0.55 // 0.7 处到底
  return v <= 1e-6 ? 0 : v
}

/** 结束位置（px，相对起点；y 向上为负） */
export function heartEnd(p: HeartParticle): { x: number; y: number } {
  return { x: Math.round(p.dirX * p.distance), y: Math.round(p.dirY * p.distance) }
}
