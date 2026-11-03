// 窗口落位单测（对应 viewer/window-fit.cjs）
// 覆盖：窗口夹回工作区（右键菜单已改为系统按光标定位，不再需要自己算）
import { describe, it, expect } from 'vitest'
import { clampToWorkArea } from '../window-fit.cjs'

const WORK = { x: 0, y: 0, width: 1536, height: 912 }

describe('clampToWorkArea', () => {
  it('完全在屏内时原样返回', () => {
    expect(clampToWorkArea({ x: 100, y: 100, width: 320, height: 320 }, WORK))
      .toEqual({ x: 100, y: 100, width: 320, height: 320 })
  })

  it('右侧/底部越界时平移回来（这是实测事故：窗口被推到 1556，屏只有 1536）', () => {
    const r = clampToWorkArea({ x: 1236, y: 656, width: 320, height: 320 }, WORK)
    expect(r.x).toBe(1216)   // 1536 - 320
    expect(r.y).toBe(592)    // 912 - 320
  })

  it('负坐标夹回左上角', () => {
    expect(clampToWorkArea({ x: -50, y: -20, width: 320, height: 320 }, WORK))
      .toMatchObject({ x: 0, y: 0 })
  })

  it('矩形比工作区还大时按左上角对齐，不产生负坐标', () => {
    expect(clampToWorkArea({ x: 50, y: 50, width: 2000, height: 1000 }, WORK))
      .toMatchObject({ x: 0, y: 0 })
  })

  it('多屏：工作区原点是负数时也对', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1080 }
    expect(clampToWorkArea({ x: -2000, y: 50, width: 320, height: 320 }, left))
      .toMatchObject({ x: -1920, y: 50 })
  })
})
