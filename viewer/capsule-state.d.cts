// capsule-state.cjs 的类型声明（供 TS 侧测试引用）
import type { FocusSession } from './focus-session.d.cts'

export interface CapsuleStats {
  date?: string
  mood?: number
  satiety?: number
  checkins?: number
  moodToday?: number
  deviceId?: string
}

export interface CapsuleModel {
  hasPet: boolean
  hasStats: boolean
  petId: string
  name: string
  dateLabel: string
  mood: number
  satiety: number
  moodText: string
  satietyText: string
  checkins: number
  checkinText: string
  checkinDots: boolean[]
  checkinOverflow: number
  focusing: boolean
  focusText: string
  focusRemainText: string
  focusProgress: number
  statusDot: 'focus' | 'pending' | 'idle'
  emptyHint: string
}

export declare function buildCapsuleModel(input: {
  stats?: CapsuleStats | null
  focus?: FocusSession | null
  pet?: { id?: string; name?: string } | null
  now?: number
  date?: Date
}): CapsuleModel

export declare function dateLabel(now?: Date): string
export declare function clampPct(n: unknown): number
export declare const CHECKIN_MAX: number
export declare const WEEKDAYS: string[]
