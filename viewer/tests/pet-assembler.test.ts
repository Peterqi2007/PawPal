// pet-assembler 测试（对应 viewer/pet-assembler.cjs）
// 覆盖：精灵表尺寸推断、宠物包装配、id 冲突加序号、超宽拒绝、动作名解析
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import {
  MAX_SHEET_WIDTH,
  assemblePet,
  collectSheets,
  inferSheetMeta,
  safeId
} from '../pet-assembler.cjs'

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Buffer) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** 生成 width×height 的纯色 PNG（尺寸用于帧数推断，像素内容不重要） */
function makePng(width: number, height: number) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

let animDir: string
let petsRoot: string

beforeEach(() => {
  animDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petpet-anim-'))
  petsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'petpet-pets-'))
})

afterEach(() => {
  fs.rmSync(animDir, { recursive: true, force: true })
  fs.rmSync(petsRoot, { recursive: true, force: true })
})

describe('精灵表尺寸推断', () => {
  it('由宽高推断帧数与单帧尺寸', () => {
    const p = path.join(animDir, 'idle-sheet.png')
    fs.writeFileSync(p, makePng(512, 128)) // 4 帧 × 128
    const meta = inferSheetMeta(p)
    expect(meta.ok).toBe(true)
    expect(meta.frames).toBe(4)
    expect(meta.cell).toBe(128)
  })

  it('总宽超 16384 拒绝（WebGL 纹理上限）', () => {
    const p = path.join(animDir, 'wide-sheet.png')
    fs.writeFileSync(p, makePng(MAX_SHEET_WIDTH + 100, 8))
    const meta = inferSheetMeta(p)
    expect(meta.ok).toBe(false)
    expect(meta.error).toContain('16384')
  })

  it('宽高不成整数帧 → 拒绝', () => {
    const p = path.join(animDir, 'odd-sheet.png')
    fs.writeFileSync(p, makePng(300, 128))
    expect(inferSheetMeta(p).ok).toBe(false)
  })

  it('非 PNG 文件 → 拒绝而不是抛异常', () => {
    const p = path.join(animDir, 'bad-sheet.png')
    fs.writeFileSync(p, 'not a png')
    expect(inferSheetMeta(p).ok).toBe(false)
  })
})

describe('动作扫描与命名', () => {
  it('collectSheets 只认 <action>-sheet.png，idle 排最前', () => {
    fs.writeFileSync(path.join(animDir, 'run-sheet.png'), makePng(128, 32))
    fs.writeFileSync(path.join(animDir, 'idle-sheet.png'), makePng(128, 32))
    fs.writeFileSync(path.join(animDir, 'ignore.txt'), 'x')
    fs.writeFileSync(path.join(animDir, 'idle-source.mp4'), 'x')
    const sheets = collectSheets(animDir)
    expect(sheets.map((s) => s.action)).toEqual(['idle', 'run'])
  })

  it('safeId 过滤非 ASCII，空名回落 pet', () => {
    expect(safeId('豆豆')).toBe('pet')
    expect(safeId('Dou Dou')).toBe('dou-dou')
    expect(safeId('')).toBe('pet')
  })
})

describe('宠物包装配', () => {
  function seedSheets() {
    fs.writeFileSync(path.join(animDir, 'idle-sheet.png'), makePng(512, 128))
    return collectSheets(animDir)
  }

  it('写出 v3 契约的 pet.json 并拷贝精灵表', () => {
    const r = assemblePet({ petsRoot, name: '豆豆', sheets: seedSheets(), idHint: 'pet-58e5f3' })
    expect(r.ok).toBe(true)
    expect(r.id).toBe('pet-58e5f3')
    const dir = path.join(petsRoot, r.id as string)
    expect(fs.existsSync(path.join(dir, 'pet.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'idle-sheet.png'))).toBe(true)

    const pet = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'))
    expect(pet.version).toBe(3)
    expect(pet.name).toBe('豆豆')
    expect(pet.cellWidth).toBe(128)
    expect(pet.actions.idle.frames).toBe(4)
    expect(pet.actions.idle.fps).toBe(5)
    expect(pet.actions.idle.frameWidth).toBe(128)
    expect(pet.actions.idle.weight).toBe(100) // idle 权重最高
    expect(pet.actions.idle.diary.text).toContain('{name}')
  })

  it('已存在同名宠物包时自动加序号，不覆盖', () => {
    const first = assemblePet({ petsRoot, name: '豆豆', sheets: seedSheets(), idHint: 'doudou' })
    expect(first.id).toBe('doudou')
    const second = assemblePet({ petsRoot, name: '豆豆', sheets: seedSheets(), idHint: 'doudou' })
    expect(second.ok).toBe(true)
    expect(second.id).toBe('doudou-2')
    expect(fs.existsSync(path.join(petsRoot, 'doudou', 'pet.json'))).toBe(true)
    expect(fs.existsSync(path.join(petsRoot, 'doudou-2', 'pet.json'))).toBe(true)
  })

  it('没有任何精灵表 → 明确报错', () => {
    const r = assemblePet({ petsRoot, name: '豆豆', sheets: [], idHint: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('动画')
  })

  it('精灵表超宽时整体拒绝，不留下半成品目录', () => {
    fs.writeFileSync(path.join(animDir, 'huge-sheet.png'), makePng(MAX_SHEET_WIDTH + 8, 8))
    const r = assemblePet({ petsRoot, name: '豆豆', sheets: collectSheets(animDir), idHint: 'bad' })
    expect(r.ok).toBe(false)
    expect(fs.existsSync(path.join(petsRoot, 'bad'))).toBe(false)
  })
})
