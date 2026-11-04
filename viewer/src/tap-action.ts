// 点击分区 → 交互意图（纯函数，可单测）
//
// 2026-11-04 产品决定（方案 C）：**喂食只在提醒的 [已完成] 里发生**。
// 之前点身体直接 +20 饱腹，误触就会偷偷喂饱，数值失去意义。
// 现在：
//   头部 → 摸头（心情 +5，每日合计上限 15）
//   身体 → 只给提示气泡，不产生任何数值变化
// 判定逻辑放这里，渲染层只管按结果执行。

export type TapRegion = 'head' | 'body'
export type TapIntent = 'pat' | 'hint'

/** 身体点击的提示文案：告诉用户喂食入口在哪 */
export const FEED_HINT = '想喂我？点提醒里的「已完成」就好啦～'

export function tapIntent(region: TapRegion | null | undefined): TapIntent {
  return region === 'head' ? 'pat' : 'hint'
}
