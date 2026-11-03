// 人格气泡文案池（纯数据 + 纯函数，可单测）
//
// persona：pet.json 的「说话风格」字段（温柔 / 傲娇 / 搞笑）——注意与 temperament
// （气质倾向对象，调制行为权重）是两件事，见 docs/08 §2.1。
// 缺失 persona 时返回 undefined，调用方回退 pet.json 的 bubbles 池。

export type Persona = '温柔' | '傲娇' | '搞笑'
export type BubbleScene = 'head' | 'feed' | 'water' | 'focusEnd'

export const PERSONAS: Persona[] = ['温柔', '傲娇', '搞笑']

export const SCENES: BubbleScene[] = ['head', 'feed', 'water', 'focusEnd']

/** 3 人格 × 4 场景（每场景 3 条，避免连续重复） */
export const PERSONA_POOLS: Record<Persona, Record<BubbleScene, string[]>> = {
  温柔: {
    head: ['好舒服～', '再摸摸嘛', '呼噜呼噜…'],
    feed: ['谢谢！好好吃', '慢慢吃，别急', '吃饱饱啦～'],
    water: ['喝水时间到啦', '咕嘟咕嘟～', '记得也要照顾好自己'],
    focusEnd: ['辛苦啦，休息一下', '我一直陪着你哦', '起来动一动吧～']
  },
  傲娇: {
    head: ['哼，才不是想被摸', '……手别停', '就、就一下下哦'],
    feed: ['勉强还算好吃', '别以为我被收买了', '下次要更好的'],
    water: ['水放这儿就行了', '我又不是不会自己喝', '……谢谢'],
    focusEnd: ['总算结束了？', '别以为我在等你', '下次专心一点啦']
  },
  搞笑: {
    head: ['摸头使我快乐', '再摸下去要秃了', '这手法，专业！'],
    feed: ['干饭人干饭魂', '一口一个不吱声', '这顿我记你一辈子'],
    water: ['吨吨吨吨吨', '我是个水做的狗', '喝完这杯还有三杯'],
    focusEnd: ['下班！虽然我没上班', '专注时长已达标', '给我也放个假呗']
  }
}

export function isPersona(v: unknown): v is Persona {
  return typeof v === 'string' && (PERSONAS as string[]).includes(v)
}

export function isScene(v: unknown): v is BubbleScene {
  return typeof v === 'string' && (SCENES as string[]).includes(v)
}

/** 取某人格某场景的候选文案；人格/场景非法返回 undefined（调用方回退 bubbles） */
export function bubblesFor(persona: unknown, scene: BubbleScene): string[] | undefined {
  if (!isPersona(persona) || !isScene(scene)) return undefined
  const pool = PERSONA_POOLS[persona][scene]
  return pool && pool.length > 0 ? pool : undefined
}

/**
 * 抽一条：优先避开上一条（last），池中只有 1 条时允许重复。
 * rng 可注入，便于单测（默认 Math.random）。
 */
export function pickBubble(
  persona: unknown,
  scene: BubbleScene,
  rng: () => number = Math.random,
  last?: string
): string | undefined {
  const pool = bubblesFor(persona, scene)
  if (!pool) return undefined
  const candidates = pool.length > 1 && last ? pool.filter((t) => t !== last) : pool
  const idx = Math.min(candidates.length - 1, Math.max(0, Math.floor(rng() * candidates.length)))
  return candidates[idx]
}
