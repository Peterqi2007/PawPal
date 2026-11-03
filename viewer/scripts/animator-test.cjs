#!/usr/bin/env node
// 动画绘制自测：在真实 Electron 隐藏窗口里跑一遍「帧序列 → 抠图 → 裁剪 → 横排拼表」。
// 不依赖网络与视频文件；验证的是精灵表生成链路本身。
//
// 用法（viewer 目录）：npx electron scripts/animator-test.cjs [输出png路径]
'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')

require(path.join(__dirname, '..', 'main.js'))
const { app, BrowserWindow, nativeImage } = require('electron')

const OUT = process.argv[2] || path.join(os.tmpdir(), 'petpet-animator-sheet.png')
const CELL = 256
const FRAMES = 6

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(ok ? `✅ ${name}${detail ? ' — ' + detail : ''}` : `❌ ${name}${detail ? ' — ' + detail : ''}`)
}

// 在页面里合成 6 帧：绿幕 + 位置轻微移动的棕色主体 + 主体内部一块纯白（模拟白胸脯）
const PAGE_SCRIPT = `(async () => {
  const W = 320, H = 240, N = ${FRAMES}
  const canvases = []
  for (let i = 0; i < N; i++) {
    const c = document.createElement('canvas')
    c.width = W; c.height = H
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#00c800'          // 绿幕
    ctx.fillRect(0, 0, W, H)
    const cx = 120 + i * 12            // 主体横向漂移
    ctx.fillStyle = '#96510a'          // 棕色主体
    ctx.beginPath()
    ctx.ellipse(cx, 150, 70, 46, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ffffff'          // 白胸脯（在主体内部，不与边缘连通）
    ctx.beginPath()
    ctx.ellipse(cx + 10, 165, 26, 20, 0, 0, Math.PI * 2)
    ctx.fill()
    canvases.push(c)
  }
  return await window.__animator.buildFromCanvases({ canvases, cell: ${CELL}, tolerance: 60, feather: 1 })
})()`

async function run() {
  await app.whenReady()
  const win = new BrowserWindow({
    show: false,
    width: 480,
    height: 360,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  await win.loadFile(path.join(__dirname, '..', 'animator.html'))

  const res = await win.webContents.executeJavaScript(PAGE_SCRIPT)
  check('精灵表生成成功', res && res.ok, res && res.error)
  if (!res || !res.ok) {
    win.destroy()
    return 1
  }

  check('总宽 = 帧数 × 单帧', res.width === FRAMES * CELL, `${res.width}×${res.height}`)
  check('单帧尺寸正确', res.width / res.height === FRAMES && res.height === CELL, `cell=${res.cell}`)
  check('返回了 PNG dataURL', String(res.sheetDataUrl).startsWith('data:image/png;base64,'))

  // 用 nativeImage 解码回来做像素断言（BGRA 顺序，每像素 4 字节）
  const img = nativeImage.createFromDataURL(res.sheetDataUrl)
  const { width, height } = img.getSize()
  const bmp = img.toBitmap()
  const alphaAt = (x, y) => bmp[(y * width + x) * 4 + 3]
  const at = (x, y) => {
    const i = (y * width + x) * 4
    return [bmp[i + 2], bmp[i + 1], bmp[i]] // BGR -> RGB
  }

  check('PNG 解码尺寸一致', width === res.width && height === res.height, `${width}×${height}`)
  check('四角背景已透明（抠图生效）',
    alphaAt(2, 2) === 0 && alphaAt(width - 3, 2) === 0 && alphaAt(2, height - 3) === 0,
    `a=${alphaAt(2, 2)},${alphaAt(width - 3, 2)},${alphaAt(2, height - 3)}`)

  // 第 1 帧中心有主体（不透明且偏棕）
  const cx = Math.round(CELL / 2)
  const cy = Math.round(CELL * 0.62)
  const [r, g, b] = at(cx, cy)
  check('第 1 帧中心为主体像素（不透明）', alphaAt(cx, cy) > 200, `a=${alphaAt(cx, cy)}`)
  check('主体像素不是绿幕色（说明抠图没把主体吃掉）', !(g > 150 && r < 90 && b < 90), `rgb=${r},${g},${b}`)

  // 第 2 帧同一位置应当也有主体（横向漂移后仍居中绘制）
  const [r2, g2, b2] = at(cx + CELL, cy)
  check('第 2 帧同样有主体', alphaAt(cx + CELL, cy) > 200, `rgb=${r2},${g2},${b2}`)

  fs.writeFileSync(OUT, Buffer.from(String(res.sheetDataUrl).split(',')[1], 'base64'))
  console.log(`\n精灵表已保存: ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`)
  win.destroy()
  return 0
}

app.whenReady().then(async () => {
  let code = 1
  try {
    code = await run()
  } catch (e) {
    console.error('❌ 异常:', e && e.stack ? e.stack : e)
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '🎉 全部通过' : '⚠️ 失败 ' + failed.length + ' 项'}（共 ${results.length} 项）`)
  app.exit(failed.length === 0 ? code : 1)
})
