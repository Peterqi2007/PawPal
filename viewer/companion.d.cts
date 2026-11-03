// Part A 陪伴交互模块的类型声明（companion.cjs 的 TS 包装）
// 对应契约：docs/handoff/README.md §5 C2/C3

export const MOOD_INIT: number
export const SATIETY_INIT: number
export const MOOD_MAX: number
export const SATIETY_MAX: number
export const PET_MOOD_GAIN: number
export const MOOD_DAILY_CAP: number
export const FEED_SATIETY_GAIN: number
export const CHECKIN_SATIETY_GAIN: number
export const CHECKIN_MOOD_GAIN: number
export const PERSONAS: string[]

export interface PetStats {
  date: string
  mood: number
  satiety: number
  checkins: number
  moodToday: number
  deviceId: string
}

export interface StatsDelta {
  feed?: true
  checkin?: true
  mood?: number
}

export interface StatsPatchResult {
  state: PetStats
  applied: { mood: number; satiety: number; checkins: number }
  capped: { mood: boolean; satiety: boolean }
  rejected: string[]
}

export function clamp(n: number, min: number, max: number): number
export function todayStr(now?: Date): string
export function newState(today: string): PetStats
export function dailyReset(state: PetStats | null, today: string): { state: PetStats; reset: boolean }
export function applyStatsPatch(state: PetStats, delta: StatsDelta | null): StatsPatchResult

export interface StatsStore {
  read(petId: string): { ok: true; state: PetStats; reset: boolean } | { ok: false; error: string }
  patch(petId: string, delta: StatsDelta | null):
    | ({ ok: true } & StatsPatchResult)
    | { ok: false; error: string }
  pathOf(petId: string): string
}

export function createStatsStore(opts: { root: string; now?: () => Date }): StatsStore

export function attachPersona(dir: string, persona: string): { ok: boolean; unchanged?: boolean; error?: string }

export function registerPetCompanion(deps: {
  ipcMain: unknown
  app: { getPath(name: string): string }
  readUiState: () => Record<string, unknown>
  writeUiState: (patch: Record<string, unknown>) => void
}): {
  statsStore: StatsStore
  attachPersona: typeof attachPersona
  soundEnabled: () => boolean
}
