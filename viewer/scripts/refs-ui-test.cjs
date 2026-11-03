#!/usr/bin/env node
// PetPet 参考图库端到端测试（分组 + 导入 → 落盘 → 缩略图渲染 → 角色规则）
//
// 用法（viewer 目录）：
//   npx electron scripts/refs-ui-test.cjs
//
// 覆盖链路：
//   1. 空库自动创建默认分组（无需用户先建组）
//   2. preload 真实 API → IPC → refs-store 校验 → nativeImage 解码 → 落盘
//   3. 组内首张自动为设定图 / 其余为姿势参考图
//   4. 新建分组后导入按组隔离，且**每组各自拥有唯一设定图**
//   5. 重载窗口后从索引读回并渲染：分组胶囊 / 徽章 / 高亮 / 缩略图
//   6. refs.json v2 结构 + images/ 的真实磁盘状态
//
// 测试隔离：库目录指向临时目录（PETPET_REFS_DIR），不污染真实用户库。

'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')
const zlib = require('zlib')

// 必须在 require main.js 之前设置
const TEMP_REFS = fs.mkdtempSync(path.join(os.tmpdir(), 'petpet-refs-e2e-'))
process.env.PETPET_REFS_DIR = TEMP_REFS
// 配置也指向临时文件：确保测试期间「没有密钥」，点击重绘只会走提示分支，绝不会真调接口
process.env.PETPET_ARK_CONFIG = path.join(TEMP_REFS, 'ark.json')
delete process.env.ARK_API_KEY

require(path.join(__dirname, '..', 'main.js'))
const { app, BrowserWindow, ipcMain } = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 运行时生成合法 PNG（不依赖外部夹具；手抄 base64 曾导致 IDAT CRC 损坏）──
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function makePng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const off = y * (width * 3 + 1)
    raw[off] = 0
    for (let x = 0; x < width; x++) {
      raw[off + 1 + x * 3] = r
      raw[off + 2 + x * 3] = g
      raw[off + 3 + x * 3] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

const PNG_DATA_URL = 'data:image/png;base64,' + makePng(64, 48, [240, 133, 31]).toString('base64')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(ok ? `✅ ${name}` : `❌ ${name}${detail ? ' — ' + detail : ''}`)
}

function readIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(TEMP_REFS, 'refs.json'), 'utf8'))
    return { groups: raw.groups || [], items: raw.items || [], version: raw.version }
  } catch {
    return { groups: [], items: [], version: null }
  }
}

async function waitForWindow(pred, timeoutMs = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const w = BrowserWindow.getAllWindows().find(pred)
    if (w) return w
    await sleep(200)
  }
  return null
}

async function reloadAndWait(win) {
  const done = new Promise((res) => win.webContents.once('did-finish-load', res))
  win.webContents.reload()
  await done
  await sleep(700)
}

// 在渲染进程里执行并取回结果
function evalIn(win, expr) {
  return win.webContents.executeJavaScript(expr)
}

async function run() {
  await app.whenReady()
  await sleep(800)

  ipcMain.emit('refs:open')
  const win = await waitForWindow((w) => w.webContents.getURL().includes('refs.html'))
  if (!win) throw new Error('参考图库窗口未能打开')
  check('参考图库窗口已打开', true, `${win.getSize().join('×')}`)
  await reloadAndWait(win)

  // 1. 空库自动建默认分组
  const s0 = await evalIn(win, 'window.refsAPI.state()')
  check('空库自动创建默认分组', s0.groups.length === 1 && s0.groups[0].name === '我的宠物',
    JSON.stringify(s0.groups.map((g) => g.name)))
  check('自动建组已落盘（refs.json 存在）', fs.existsSync(path.join(TEMP_REFS, 'refs.json')))
  const g1 = s0.activeGroupId

  // 2. 导入两张到默认分组
  const add1 = await evalIn(win, `window.refsAPI.addFiles([
    { name: 'dou-front.png', dataUrl: '${PNG_DATA_URL}' },
    { name: 'dou-pose.png',  dataUrl: '${PNG_DATA_URL}' }
  ], ${JSON.stringify(g1)})`)
  const mine1 = add1.items.filter((it) => it.originalName.startsWith('dou-'))
  check('默认分组导入 2 张成功', add1.added === 2, JSON.stringify(add1.errors || []))
  check('组内首张自动为设定图', mine1[0] && mine1[0].role === 'setup', mine1[0] && mine1[0].role)
  check('组内其余为姿势参考图', mine1.slice(1).every((it) => it.role === 'pose'),
    mine1.slice(1).map((it) => it.role).join(','))

  // 3. 新建分组 → 自动切到新分组且为空
  const created = await evalIn(win, "window.refsAPI.createGroup('E2E-第二只')")
  check('新建分组成功并切换过去', created.ok && created.groups.length === 2
    && created.items.length === 0 && created.activeGroupId === created.groups[1].id,
    `活跃=${created.activeGroupId}`)
  const g2 = created.activeGroupId

  // 4. 新分组导入 1 张 → 它应是**本组**的设定图（跨组互不影响）
  const add2 = await evalIn(win, `window.refsAPI.addFiles([
    { name: 'bao-front.png', dataUrl: '${PNG_DATA_URL}' }
  ], ${JSON.stringify(g2)})`)
  const mine2 = add2.items.filter((it) => it.originalName === 'bao-front.png')
  check('新分组首张也是设定图（角色按组独立）', mine2.length === 1 && mine2[0].role === 'setup',
    mine2[0] && mine2[0].role)

  const s1 = await evalIn(win, `window.refsAPI.state(${JSON.stringify(g1)})`)
  check('原分组设定图未被新分组顶替', s1.items.filter((it) => it.role === 'setup').length === 1
    && s1.items.length === 2, `设定图 ${s1.items.filter((it) => it.role === 'setup').length} 张`)

  // 5. 重载后渲染：分组胶囊 + 当前分组画廊
  await reloadAndWait(win)
  const dom = await evalIn(win, `({
    chips: [...document.querySelectorAll('.chip')].map(c => c.textContent),
    activeChips: document.querySelectorAll('.chip.is-active').length,
    activeName: (document.querySelector('.chip.is-active') || {}).textContent || '',
    cards: document.querySelectorAll('.ref').length,
    badges: [...document.querySelectorAll('.badge')].map(b => b.textContent),
    setupCards: document.querySelectorAll('.ref.is-setup').length,
    imgs: [...document.querySelectorAll('.thumb img')].map(i => i.getAttribute('src') || ''),
    dropTarget: (document.getElementById('dropTarget') || {}).textContent || ''
  })`)
  check('分组胶囊渲染出 2 个', dom.chips.length === 2, dom.chips.join(' | '))
  check('同时只有一个分组处于选中态', dom.activeChips === 1, dom.activeName)
  check('画廊只显示当前分组（第二组 1 张）', dom.cards === 1, `卡片 ${dom.cards} 张`)
  check('当前分组徽章为设定图', dom.badges.length === 1 && dom.badges[0] === '设定图', dom.badges.join(','))
  check('设定图高亮唯一', dom.setupCards === 1)
  check('缩略图为真实图片 dataURL', dom.imgs.length === 1 && dom.imgs[0].startsWith('data:image'))
  check('上传区提示当前目标分组', dom.dropTarget.includes('E2E-第二只'), dom.dropTarget)

  // 6. 切换到第一组 → 画廊变 2 张，且设定图仍是 dou-front
  await evalIn(win, "document.querySelectorAll('.chip')[0].click()")
  await sleep(900)
  const dom2 = await evalIn(win, `({
    cards: document.querySelectorAll('.ref').length,
    badges: [...document.querySelectorAll('.badge')].map(b => b.textContent),
    setupCards: document.querySelectorAll('.ref.is-setup').length,
    firstName: (document.querySelector('.ref .name') || {}).textContent || '',
    activeName: (document.querySelector('.chip.is-active') || {}).textContent || ''
  })`)
  check('点击分组胶囊可切换画廊', dom2.cards === 2 && dom2.activeName.includes('我的宠物'),
    `${dom2.activeName} / ${dom2.cards} 张`)
  check('切换后徽章仍正确（1 设定图 + 1 姿势参考）',
    dom2.setupCards === 1 && dom2.badges.includes('姿势参考图'), dom2.badges.join(' | '))
  check('第一组首张仍是设定图', dom2.firstName === 'dou-front.png', dom2.firstName)

  // 7. AI 重绘入口：按钮 / 就绪度 / 未配置密钥时的点击路径（全程不联网）
  const redrawDom = await evalIn(win, `({
    hasBtn: !!document.getElementById('redraw'),
    label: (document.getElementById('redraw') || {}).textContent || '',
    ready: (document.getElementById('ready') || {}).textContent || '',
    hasPanel: !!document.getElementById('arkPanel'),
    panelHidden: !!document.getElementById('arkPanel') && document.getElementById('arkPanel').classList.contains('hidden')
  })`)
  check('重绘按钮存在', redrawDom.hasBtn && redrawDom.label.includes('重绘'), redrawDom.label)
  check('就绪度提示还差 2 张姿势参考图', redrawDom.ready.includes('还差 2 张'), redrawDom.ready)
  check('生成设置面板存在且默认折叠', redrawDom.hasPanel && redrawDom.panelHidden)

  await evalIn(win, "document.getElementById('redraw').click()")
  await sleep(700)
  const afterClick = await evalIn(win, `({
    hint: (document.getElementById('hint') || {}).textContent || '',
    panelHidden: document.getElementById('arkPanel').classList.contains('hidden')
  })`)
  check('未配置密钥时点击给出提示（不联网）', afterClick.hint.includes('API Key'), afterClick.hint)
  check('提示后自动展开生成设置', afterClick.panelHidden === false)

  // 8. 磁盘结构
  const idx = readIndex()
  const images = fs.readdirSync(path.join(TEMP_REFS, 'images'))
  check('索引已升级为 v2（含 groups）', idx.version === 2 && idx.groups.length === 2, `version=${idx.version}`)
  check('每条图片都带 group 字段', idx.items.length === 3 && idx.items.every((it) => !!it.group))
  check('原图副本 + 缩略图都已落盘', idx.items.every((it) => images.includes(it.file) && images.includes(it.thumb)),
    `images/ 共 ${images.length} 个文件`)

  // 8. 清理（临时库整体删除）
  fs.rmSync(TEMP_REFS, { recursive: true, force: true })
  check('临时测试库已清理', !fs.existsSync(TEMP_REFS))
}

app.whenReady().then(async () => {
  let code = 0
  try {
    await run()
  } catch (e) {
    console.error('❌ 测试异常:', e && e.stack ? e.stack : e)
    code = 1
    try {
      fs.rmSync(TEMP_REFS, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '🎉 全部通过' : '⚠️ 失败 ' + failed.length + ' 项'}（共 ${results.length} 项）`)
  app.exit(failed.length === 0 ? code : 1)
})
