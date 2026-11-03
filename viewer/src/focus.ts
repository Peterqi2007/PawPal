// 专注态的渲染副作用（纯函数，可单测）
//
// A 组只负责"桌宠怎么表现"，专注的计时与设置卡归 B 组（docs/handoff/README.md §5 C5）。

export interface FocusEffects {
  /** 是否暂停随机行为与行为链转移 */
  pauseRandom: boolean
  /** 施加在 .pet-stage 上的 CSS filter；空串表示不施加 */
  filter: string
  /** 是否显示疲倦/休息态标记（供将来扩展，当前只用于 aria 说明） */
  resting: boolean
}

export const FOCUS_FILTER = 'brightness(0.82) saturate(0.55)'

export function applyFocusState(entering: boolean): FocusEffects {
  return {
    pauseRandom: entering,
    filter: entering ? FOCUS_FILTER : '',
    resting: entering
  }
}

/** 统一描述给 aria-label / 调试日志用 */
export function focusLabel(entering: boolean, petName: string): string {
  return entering ? `${petName}（专注中）` : `${petName}（桌面宠物）`
}
