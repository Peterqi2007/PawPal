// 提醒队列单测（对应 viewer/src/reminder-queue.ts）
// 覆盖：入队/去重/当前项/待办计数/出队顶上
import { describe, it, expect } from 'vitest'
import { createQueue, enqueue, currentOf, pendingCount, dismiss, isEmpty } from '../src/reminder-queue'

const a = { id: 'r1', text: '喂水', kind: 'water' as const }
const b = { id: 'r2', text: '喂食', kind: 'feed' as const }

describe('入队与当前项', () => {
  it('空队列入队后成为当前项', () => {
    const q = enqueue(createQueue(), a)
    expect(currentOf(q)).toEqual(a)
    expect(pendingCount(q)).toBe(0)
    expect(isEmpty(q)).toBe(false)
  })

  it('多条排队：当前不变，计数递增', () => {
    let q = enqueue(createQueue(), a)
    q = enqueue(q, b)
    expect(currentOf(q)!.id).toBe('r1')
    expect(pendingCount(q)).toBe(1)
  })

  it('同 id 重复入队不重复堆积', () => {
    let q = enqueue(createQueue(), a)
    q = enqueue(q, { ...a, text: '喂水（改）' })
    expect(q.items.length).toBe(1)
    expect(currentOf(q)!.text).toBe('喂水（改）')
    expect(pendingCount(q)).toBe(0)
  })
})

describe('出队', () => {
  it('点完成移除当前，下一条顶上', () => {
    let q = enqueue(enqueue(createQueue(), a), b)
    q = dismiss(q)
    expect(currentOf(q)!.id).toBe('r2')
    expect(pendingCount(q)).toBe(0)
  })

  it('最后一条完成后清空', () => {
    let q = enqueue(createQueue(), a)
    q = dismiss(q)
    expect(isEmpty(q)).toBe(true)
    expect(currentOf(q)).toBeNull()
    expect(pendingCount(q)).toBe(0)
  })

  it('指定 id 删除非当前项不影响当前项', () => {
    let q = enqueue(enqueue(createQueue(), a), b)
    q = dismiss(q, 'r2')
    expect(currentOf(q)!.id).toBe('r1')
    expect(pendingCount(q)).toBe(0)
  })

  it('空队列 dismiss 不崩溃', () => {
    const q = dismiss(createQueue())
    expect(isEmpty(q)).toBe(true)
  })
})

describe('不可变性', () => {
  it('enqueue/dismiss 都返回新对象（旧状态不被改写）', () => {
    const empty = createQueue()
    const q1 = enqueue(empty, a)
    expect(empty.items.length).toBe(0)
    const q2 = dismiss(q1)
    expect(q1.items.length).toBe(1)
    expect(q2.items.length).toBe(0)
  })
})
