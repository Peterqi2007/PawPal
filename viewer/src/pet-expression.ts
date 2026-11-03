// 数值 → 桌宠表情/姿态（纯函数，可单测）
//
// 口径（docs/handoff/B-状态与专注.md 第 3 节）：
//   饱腹 < 30 → 瘫倒喊饿；饱腹 > 80 → 开心跳跃
//   心情 < 30 → 背对/冒乌云；心情 > 80 → 冒爱心
// "不做重度养成"：不随时间掉、不惩罚、不会死，所以这里只做**表现**，不产生新的数值。

export type MoodFace = 'sad' | 'happy' | 'normal'

export interface PetExpression {
  /** 瘫倒（饱腹过低）：整个精灵旋转躺下 */
  collapsed: boolean
  /** 开心跳跃（饱腹充足） */
  jump: boolean
  /** 心情表情 */
  moodFace: MoodFace
  /** 头顶浮层 emoji（'' 表示不显示） */
  overlay: '' | 'cloud' | 'hearts'
  /** 状态切换时的一次性气泡文案（'' 表示不冒泡） */
  bubble: string
}

export const LOW_SATIETY = 30
export const HIGH_SATIETY = 80
export const LOW_MOOD = 30
export const HIGH_MOOD = 80

export const BUBBLE_HUNGRY = '饿…饿扁了…'
export const BUBBLE_HAPPY_FULL = '吃得好饱，开心！'
export const BUBBLE_SAD = '有点不开心…摸摸我嘛'
export const BUBBLE_LOVED = '最喜欢你啦！'

const EMPTY: PetExpression = { collapsed: false, jump: false, moodFace: 'normal', overlay: '', bubble: '' }

/** 只吃数值，不碰 DOM —— 渲染层拿结果去加 class */
export function expressionOf(stats: { mood?: number; satiety?: number } | null | undefined): PetExpression {
  if (!stats || typeof stats !== 'object') return { ...EMPTY }
  const satiety = Number(stats.satiety)
  const mood = Number(stats.mood)
  if (!Number.isFinite(satiety) || !Number.isFinite(mood)) return { ...EMPTY }

  const collapsed = satiety < LOW_SATIETY
  const jump = satiety > HIGH_SATIETY
  const moodFace: MoodFace = mood < LOW_MOOD ? 'sad' : mood > HIGH_MOOD ? 'happy' : 'normal'

  return {
    collapsed,
    jump,
    moodFace,
    overlay: moodFace === 'sad' ? 'cloud' : moodFace === 'happy' ? 'hearts' : '',
    bubble: collapsed ? BUBBLE_HUNGRY : moodFace === 'sad' ? BUBBLE_SAD : ''
  }
}

/**
 * 比较前后两个数值，决定"刚跨过阈值"时才冒的文案（避免每次加 5 都冒一次）。
 * 返回 '' 表示这次变化不需要额外气泡。
 */
export function thresholdBubble(
  prev: { mood?: number; satiety?: number } | null | undefined,
  next: { mood?: number; satiety?: number } | null | undefined
): string {
  if (!next) return ''
  const before = prev && Number.isFinite(Number(prev.satiety)) && Number.isFinite(Number(prev.mood))
    ? prev
    : null
  const prevSatiety = before ? Number(before.satiety) : NaN
  const prevMood = before ? Number(before.mood) : NaN
  const satiety = Number(next.satiety)
  const mood = Number(next.mood)
  if (!Number.isFinite(satiety) || !Number.isFinite(mood)) return ''

  // 饿肚子优先级最高
  if (satiety < LOW_SATIETY) return Number.isFinite(prevSatiety) && prevSatiety < LOW_SATIETY ? '' : BUBBLE_HUNGRY
  if (Number.isFinite(prevSatiety) && prevSatiety < LOW_SATIETY) return BUBBLE_HAPPY_FULL
  if (satiety > HIGH_SATIETY && Number.isFinite(prevSatiety) && prevSatiety <= HIGH_SATIETY) return BUBBLE_HAPPY_FULL
  if (mood < LOW_MOOD && !(Number.isFinite(prevMood) && prevMood < LOW_MOOD)) return BUBBLE_SAD
  if (mood > HIGH_MOOD && (!Number.isFinite(prevMood) || prevMood <= HIGH_MOOD)) return BUBBLE_LOVED
  return ''
}
