// 提醒队列（纯 reducer，可单测）
//
// 背景：提醒可能同时到点（多条），原先用常显条换行堆叠；改成头顶大气泡后，
// 一次只显示一条，其余排队 —— 给用户"还有 N 条"的明确预期，且不会丢提醒。

export type ReminderKind = 'feed' | 'water' | 'custom'

export interface ReminderEntry {
  id: string
  text: string
  kind?: ReminderKind
}

export interface QueueState {
  items: ReminderEntry[]
  currentId: string | null
}

export function createQueue(): QueueState {
  return { items: [], currentId: null }
}

/** 入队：同 id 覆盖；队列原本为空时设为当前 */
export function enqueue(q: QueueState, entry: ReminderEntry): QueueState {
  const items = q.items.filter((it) => it.id !== entry.id).concat([entry])
  const currentId = q.currentId && items.some((it) => it.id === q.currentId) ? q.currentId : entry.id
  return { items, currentId }
}

export function currentOf(q: QueueState): ReminderEntry | null {
  if (!q.currentId) return null
  return q.items.find((it) => it.id === q.currentId) || null
}

/** 当前之外还排着的条数（大气泡上的「还有 N 条」） */
export function pendingCount(q: QueueState): number {
  return q.currentId ? Math.max(0, q.items.length - 1) : q.items.length
}

/** 移除某条（默认移除当前）；移除后若有下一条自动顶上来，否则清空 */
export function dismiss(q: QueueState, id?: string): QueueState {
  const target = id || q.currentId
  if (!target) return q
  const items = q.items.filter((it) => it.id !== target)
  if (items.length === 0) return { items, currentId: null }
  if (q.currentId === target) return { items, currentId: items[0].id }
  return { items, currentId: q.currentId }
}

export function isEmpty(q: QueueState): boolean {
  return q.items.length === 0
}
