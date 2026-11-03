// 单击判定（纯函数，可单测）
//
// 事故背景（2026-11-03）：桌宠的 downPos 一直保留上一次按下的坐标，
// 于是"没有按下、只收到一次抬起"也会被当成点击（离旧坐标 <6px 就算），
// 表现为"没点它，饱腹值却自己在涨"。判定必须满足：有这次按下 + 抬起离按下够近。

export interface PointerPos {
  x: number
  y: number
}

export const CLICK_MAX_DIST = 6

/**
 * 这次抬起算不算一次点击。
 * @param down 本次按下的位置；null 表示没有配对按下（抬起是孤立的，必须忽略）
 * @param up   抬起位置
 */
export function isClickGesture(
  down: PointerPos | null | undefined,
  up: PointerPos | null | undefined,
  maxDist = CLICK_MAX_DIST
): boolean {
  if (!down || !up) return false
  const dx = Number(up.x) - Number(down.x)
  const dy = Number(up.y) - Number(down.y)
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false
  return Math.hypot(dx, dy) < maxDist
}
