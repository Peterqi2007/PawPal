// 提醒音效（薄封装，失败静默）
//
// 约束：
// - 音效是本地文件（viewer/assets/ding.wav），不走网络
// - 自动播放策略：主进程已设 autoplayPolicy: no-user-gesture-required，
//   同时首次指针手势会调用 unlockAudio() 双保险
// - 任何异常都不许打断提醒流程：返回状态，由调用方上报日志

export type AudioStatus = 'played' | 'failed'

export const DEFAULT_DING = './assets/ding.wav'

let el: HTMLAudioElement | null = null

function ensureEl(src: string): HTMLAudioElement | null {
  if (el) return el
  try {
    el = new Audio(src)
    el.preload = 'auto'
    el.volume = 0.6
  } catch {
    el = null
  }
  return el
}

/** 首次用户手势后调用：把音频元素载入，避免某些平台的懒加载拦截 */
export function unlockAudio(src = DEFAULT_DING): void {
  const a = ensureEl(src)
  if (!a) return
  try { a.load() } catch { /* ignore */ }
}

/** 播一声；不抛异常 */
export async function playDing(src = DEFAULT_DING): Promise<AudioStatus> {
  const a = ensureEl(src)
  if (!a) return 'failed'
  try {
    a.currentTime = 0
    await a.play()
    return 'played'
  } catch {
    return 'failed'
  }
}
