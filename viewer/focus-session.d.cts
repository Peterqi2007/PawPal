// focus-session.cjs 的类型声明（供 TS 侧测试/渲染层引用）
export declare const MIN_MINUTES: number
export declare const MAX_MINUTES: number

export declare function parseMinutes(raw: unknown):
  | { ok: true; minutes: number }
  | { ok: false; error: string }

export declare function remainingMs(endAt: unknown, now?: number): number
export declare function formatCountdown(ms: number): string
export declare function endAtFromMinutes(minutes: unknown, now?: number):
  | { ok: true; endAt: number; minutes: number }
  | { ok: false; error: string }

export interface FocusSession {
  endAt: number
  minutes: number
  startedAt: number
}

export declare function normalizeFocus(raw: unknown, now?: number): FocusSession | null
export declare function focusProgress(
  session: { startedAt?: number; endAt: number } | null,
  now?: number
): number
