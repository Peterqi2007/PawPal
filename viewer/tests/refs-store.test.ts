// refs-store 参考图库测试（对应 viewer/refs-store.cjs）
// 覆盖产品规则（首张=设定图、设定图唯一）与安全边界（大小/格式/解码/文件名净化）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createRefsStore,
  sanitizeName,
  sanitizeGroupName,
  normalizeRoles,
  MAX_FILE_BYTES,
  MAX_ITEMS,
  MAX_GROUPS,
  DEFAULT_GROUP_NAME
} from '../refs-store.cjs'
import type { RefsStore, RefItem } from '../refs-store.cjs'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// 假缩略图生成器：只认 PNG 魔数，把魔数换成固定宽高——
// 真实现由主进程注入 nativeImage，单测里不需要 Electron
function fakeThumb(buf: Buffer) {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return null
  return { data: Buffer.from('thumb-bytes'), ext: '.jpg', width: 800, height: 600 }
}

function png(width = 4, height = 4) {
  // 只需魔数（解码由注入的 thumbMaker 负责），尺寸信息用来断言透传
  const head = Buffer.alloc(16)
  PNG_MAGIC.copy(head, 0)
  head.writeUInt32BE(width, 8)
  head.writeUInt32BE(height, 12)
  return head
}

let root: string
let store: RefsStore

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'petpet-refs-'))
  store = createRefsStore(root, { thumbMaker: fakeThumb })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('导入与角色规则（首张 = 设定图）', () => {
  it('首张导入自动成为设定图', () => {
    const r = store.addFromBuffer(png(), 'dog-front.png')
    expect(r.ok).toBe(true)
    expect(r.item?.role).toBe('setup')
    expect(store.list()).toHaveLength(1)
  })

  it('第二张起为姿势参考图', () => {
    store.addFromBuffer(png(), 'a.png')
    const second = store.addFromBuffer(png(), 'b.png')
    const third = store.addFromBuffer(png(), 'c.png')
    expect(second.item?.role).toBe('pose')
    expect(third.item?.role).toBe('pose')
    expect(store.list().filter((it) => it.role === 'setup')).toHaveLength(1)
  })

  it('设定图唯一：顶替后原设定图降级为姿势参考', () => {
    const first = store.addFromBuffer(png(), 'a.png').item as RefItem
    const second = store.addFromBuffer(png(), 'b.png').item as RefItem
    const r = store.setRole(second.id, 'setup')
    expect(r.ok).toBe(true)
    const byId = new Map((r.items || []).map((it) => [it.id, it]))
    expect(byId.get(second.id)?.role).toBe('setup')
    expect(byId.get(first.id)?.role).toBe('pose')
  })

  it('唯一设定图不能被直接取消（避免库失去形象锚点）', () => {
    const only = store.addFromBuffer(png(), 'a.png').item as RefItem
    const r = store.setRole(only.id, 'pose')
    expect(r.ok).toBe(false)
    expect(store.getItem(only.id)?.role).toBe('setup')
  })

  it('删除设定图后，最早一张自动补位', () => {
    const a = store.addFromBuffer(png(), 'a.png').item as RefItem
    store.addFromBuffer(png(), 'b.png')
    store.addFromBuffer(png(), 'c.png')
    const r = store.remove(a.id)
    expect(r.ok).toBe(true)
    const setups = (r.items || []).filter((it) => it.role === 'setup')
    expect(setups).toHaveLength(1)
    // b 比 c 早，故 b 补位
    expect(setups[0].originalName).toBe('b.png')
  })

  it('索引持久化：新实例读到同一批图片，且能修复脏数据（双设定图）', () => {
    store.addFromBuffer(png(), 'a.png')
    store.addFromBuffer(png(), 'b.png')
    // 手工破坏索引：把两张都写成 setup
    const idx = JSON.parse(fs.readFileSync(path.join(root, 'refs.json'), 'utf8'))
    idx.items.forEach((it: RefItem) => { it.role = 'setup' })
    fs.writeFileSync(path.join(root, 'refs.json'), JSON.stringify(idx))

    const again = createRefsStore(root, { thumbMaker: fakeThumb })
    const items = again.list()
    expect(items).toHaveLength(2)
    expect(items.filter((it) => it.role === 'setup')).toHaveLength(1)
  })
})

describe('安全边界（fail-closed）', () => {
  it('无法解码的伪图片被拒（改后缀的 txt）', () => {
    const r = store.addFromBuffer(Buffer.from('this is not a png'), 'fake.png')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/无法解码/)
    expect(store.list()).toHaveLength(0)
  })

  it('超过单张 10MB 上限被拒（且不会落盘）', () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1)
    PNG_MAGIC.copy(big, 0)
    const r = store.addFromBuffer(big, 'big.png')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/上限/)
    expect(store.list()).toHaveLength(0)
  })

  it('非白名单扩展名被拒', () => {
    const r = store.addFromBuffer(png(), 'evil.exe')
    expect(r.ok).toBe(false)
    expect(store.list()).toHaveLength(0)
  })

  it('空文件被拒', () => {
    expect(store.addFromBuffer(Buffer.alloc(0), 'a.png').ok).toBe(false)
    expect(store.list()).toHaveLength(0)
  })

  it('原始文件名被净化：零宽/控制字符剥离、路径分隔符替换、超长截断', () => {
    expect(sanitizeName('a\u200b\u202eb.png')).toBe('ab.png')
    expect(sanitizeName('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(sanitizeName('x'.repeat(200)).length).toBe(80)
    expect(sanitizeName('')).toBe('未命名图片')
  })

  it('文件名带控制字符也不影响落盘路径（id 由模块生成，不拼用户文件名）', () => {
    const r = store.addFromBuffer(png(), 'dog\u0000\r\n\t.png')
    expect(r.ok).toBe(true)
    const item = r.item as RefItem
    expect(item.id).toMatch(/^r_[0-9a-z_]+$/)
    expect(path.basename(item.file)).toBe(item.file) // 不含路径分隔符
    expect(fs.existsSync(path.join(root, 'images', item.file))).toBe(true)
  })

  it('数量上限：超过 MAX_ITEMS 拒绝导入', () => {
    for (let i = 0; i < MAX_ITEMS; i++) {
      expect(store.addFromBuffer(png(), `p${i}.png`).ok).toBe(true)
    }
    const over = store.addFromBuffer(png(), 'one-more.png')
    expect(over.ok).toBe(false)
    expect(over.error).toMatch(/最多/)
    expect(store.list()).toHaveLength(MAX_ITEMS)
  })
})

describe('读取与统计', () => {
  it('getThumb 返回缩略图字节；非法 id 返回 null（路径穿越防护）', () => {
    const item = store.addFromBuffer(png(), 'a.png').item as RefItem
    expect(store.getThumb(item.id)?.toString()).toBe('thumb-bytes')
    expect(store.getThumb('../refs.json')).toBeNull()
    expect(store.getThumb('r_不合法')).toBeNull()
  })

  it('stats 统计张数、体积与设定图数量', () => {
    store.addFromBuffer(png(), 'a.png')
    store.addFromBuffer(png(), 'b.png')
    const s = store.stats()
    expect(s.count).toBe(2)
    expect(s.setupCount).toBe(1)
    expect(s.bytes).toBeGreaterThan(0)
  })

  it('normalizeRoles 对空数组安全，且能把缺角色的项补成唯一设定图', () => {
    expect(normalizeRoles([])).toEqual([])
    const items = [
      { id: 'r_1', addedAt: 2, role: 'pose' },
      { id: 'r_2', addedAt: 1, role: 'pose' }
    ] as RefItem[]
    const out = normalizeRoles(items)
    expect(out.filter((it) => it.role === 'setup')).toHaveLength(1)
    expect(out.find((it) => it.role === 'setup')?.id).toBe('r_2') // addedAt 更早者
  })
})

describe('来源标记（AI 重绘 vs 用户导入）', () => {
  it('默认 source 为 upload', () => {
    const item = store.addFromBuffer(png(), 'a.png').item as RefItem
    expect(item.source).toBe('upload')
  })

  it('显式传 source=ai 时入库并持久化', () => {
    const item = store.addFromBuffer(png(), '重绘-1.png', undefined, { source: 'ai' }).item as RefItem
    expect(item.source).toBe('ai')
    const again = createRefsStore(root, { thumbMaker: fakeThumb })
    expect(again.getItem(item.id)?.source).toBe('ai')
  })

  it('老索引缺 source 字段时按 upload 补默认值', () => {
    const item = store.addFromBuffer(png(), 'old.png').item as RefItem
    const idx = JSON.parse(fs.readFileSync(path.join(root, 'refs.json'), 'utf8'))
    delete idx.items.find((it: RefItem) => it.id === item.id).source
    fs.writeFileSync(path.join(root, 'refs.json'), JSON.stringify(idx))
    const again = createRefsStore(root, { thumbMaker: fakeThumb })
    expect(again.getItem(item.id)?.source).toBe('upload')
  })
})

describe('多宠物分组（设定图按组唯一）', () => {
  it('空库自动创建一个默认分组（不需要用户先建组）', () => {
    const s = store.state()
    expect(s.groups).toHaveLength(1)
    expect(s.groups[0].name).toBe(DEFAULT_GROUP_NAME)
    expect(s.activeGroupId).toBe(s.groups[0].id)
    expect(s.items).toHaveLength(0)
    // 自动建的分组要落盘，下次打开还在
    expect(fs.existsSync(path.join(root, 'refs.json'))).toBe(true)
  })

  it('新建分组后，导入按分组隔离（state 只返回当前分组）', () => {
    const a = store.createGroup('豆豆').group!
    const b = store.createGroup('包包').group!
    store.addFromBuffer(png(), 'dou1.png', a.id)
    store.addFromBuffer(png(), 'dou2.png', a.id)
    store.addFromBuffer(png(), 'bao1.png', b.id)

    expect(store.state(a.id).items).toHaveLength(2)
    expect(store.state(b.id).items).toHaveLength(1)
    expect(store.state(a.id).activeGroupId).toBe(a.id)
    // 分组列表带各自计数
    const counts = new Map(store.state().groups.map((g) => [g.id, g.count]))
    expect(counts.get(a.id)).toBe(2)
    expect(counts.get(b.id)).toBe(1)
  })

  it('每个分组各自有且仅有一张设定图（互不顶替）', () => {
    const a = store.createGroup('A').group!
    const b = store.createGroup('B').group!
    const a1 = store.addFromBuffer(png(), 'a1.png', a.id).item as RefItem
    const b1 = store.addFromBuffer(png(), 'b1.png', b.id).item as RefItem
    // 两组的首张都应是设定图
    expect(a1.role).toBe('setup')
    expect(b1.role).toBe('setup')

    // 在 A 组里顶替，不影响 B 组
    const a2 = store.addFromBuffer(png(), 'a2.png', a.id).item as RefItem
    store.setRole(a2.id, 'setup')
    expect(store.getItem(a1.id)?.role).toBe('pose')
    expect(store.getItem(b1.id)?.role).toBe('setup')
  })

  it('删除某组设定图后只在该组内补位，其它组不受影响', () => {
    const a = store.createGroup('A').group!
    const b = store.createGroup('B').group!
    const a1 = store.addFromBuffer(png(), 'a1.png', a.id).item as RefItem
    store.addFromBuffer(png(), 'a2.png', a.id)
    const b1 = store.addFromBuffer(png(), 'b1.png', b.id).item as RefItem

    store.remove(a1.id)
    const aItems = store.state(a.id).items
    expect(aItems.filter((it) => it.role === 'setup')).toHaveLength(1)
    expect(aItems.find((it) => it.role === 'setup')?.originalName).toBe('a2.png')
    // B 组原设定图保持不变
    expect(store.getItem(b1.id)?.role).toBe('setup')
  })

  it('不能把组内唯一设定图直接取消（错误信息限定在本组）', () => {
    const a = store.createGroup('A').group!
    const only = store.addFromBuffer(png(), 'a1.png', a.id).item as RefItem
    const r = store.setRole(only.id, 'pose')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/同组/)
  })

  it('分组名净化 + 重名复用已有分组（不产生重复分组）', () => {
    expect(sanitizeGroupName('  豆\u200b豆  ')).toBe('豆豆')
    expect(sanitizeGroupName('')).toBe('未命名分组')
    expect(sanitizeGroupName('x'.repeat(60)).length).toBe(30)

    const first = store.createGroup('豆豆')
    const again = store.createGroup('豆豆')
    expect(again.ok).toBe(true)
    expect(again.existed).toBe(true)
    expect(again.group?.id).toBe(first.group?.id)
    expect(store.groups().filter((g) => g.name === '豆豆')).toHaveLength(1)
  })

  it('分组数量上限：超过 MAX_GROUPS 拒绝新建', () => {
    const base = store.state().groups.length // 含自动创建的默认分组
    for (let i = 0; i < MAX_GROUPS - base; i++) {
      expect(store.createGroup(`组${i}`).ok).toBe(true)
    }
    const over = store.createGroup('再来一个')
    expect(over.ok).toBe(false)
    expect(over.error).toMatch(/最多/)
    expect(store.state().groups).toHaveLength(MAX_GROUPS)
  })

  it('v1 索引（无 groups / group 字段）自动迁移到默认分组', () => {
    fs.mkdirSync(path.join(root, 'images'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'refs.json'),
      JSON.stringify({
        version: 1,
        items: [
          { id: 'r_aaa', file: 'r_aaa.png', thumb: 'r_aaa.jpg', originalName: 'old.png', role: 'setup', width: 8, height: 8, bytes: 10, addedAt: 1 },
          { id: 'r_bbb', file: 'r_bbb.png', thumb: 'r_bbb.jpg', originalName: 'old2.png', role: 'setup', width: 8, height: 8, bytes: 10, addedAt: 2 }
        ]
      })
    )
    const migrated = createRefsStore(root, { thumbMaker: fakeThumb })
    const s = migrated.state()
    expect(s.groups).toHaveLength(1)
    expect(s.items).toHaveLength(2)
    // 迁移后同组内只保留一张设定图（最早那张）
    expect(s.items.filter((it) => it.role === 'setup')).toHaveLength(1)
    expect(s.items.find((it) => it.role === 'setup')?.id).toBe('r_aaa')
    // 已回写为 v2 结构
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'refs.json'), 'utf8'))
    expect(raw.version).toBe(2)
    expect(Array.isArray(raw.groups)).toBe(true)
  })
})

describe('deleteGroup', () => {
  it('删掉分组时连组内图片文件一起清理', () => {
    const store = createRefsStore(root, { thumbMaker: fakeThumb })
    const a = store.createGroup('测试组')
    const b = store.createGroup('保留组')
    const buf = png()
    const r1 = store.addFromBuffer(buf, 'x.png', a.group!.id)
    const r2 = store.addFromBuffer(buf, 'y.png', b.group!.id)
    expect(r1.ok && r2.ok).toBe(true)

    const del = store.deleteGroup(a.group!.id)
    expect(del.ok).toBe(true)
    expect(del.removed?.items).toBe(1)
    expect(del.removed?.files).toBe(2) // 原图 + 缩略图

    const after = store.state()
    expect(after.groups.map((g) => g.name)).not.toContain('测试组')
    expect(after.items.every((it) => it.group === b.group!.id)).toBe(true)
    expect(fs.existsSync(path.join(store.imagesDir, r1.item!.file))).toBe(false)
    expect(fs.existsSync(path.join(store.imagesDir, r2.item!.file))).toBe(true)
  })

  it('拒绝删除最后一个分组（图库不能空）', () => {
    const store = createRefsStore(root, { thumbMaker: fakeThumb })
    const only = store.state().groups[0]
    const del = store.deleteGroup(only.id)
    expect(del.ok).toBe(false)
    expect(del.error).toBe('至少保留一个分组')
    expect(store.state().groups).toHaveLength(1)
  })

  it('分组不存在 / 标识非法时返回错误而不是抛异常', () => {
    const store = createRefsStore(root, { thumbMaker: fakeThumb })
    expect(store.deleteGroup('g_not_exist').ok).toBe(false)
    expect(store.deleteGroup('../../etc').ok).toBe(false)
  })

  it('删掉当前选中分组后，lastGroupId 落到剩下的组', () => {
    const store = createRefsStore(root, { thumbMaker: fakeThumb })
    const a = store.createGroup('A 组')
    store.createGroup('B 组')
    store.setActiveGroup(a.group!.id)
    store.deleteGroup(a.group!.id)
    const after = store.state()
    expect(after.groups).toHaveLength(1)
    expect(after.activeGroupId).toBe(after.groups[0].id)
  })
})
