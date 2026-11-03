#!/usr/bin/env node
// 用已下载的 mp4 重跑本地拼表（不花钱），验证修复后的链路
'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')

require(path.join(__dirname, '..', 'main.js'))
const { app, BrowserWindow, ipcMain } = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForWindow(pred, timeoutMs = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const w = BrowserWindow.getAllWindows().find(pred)
    if (w) return w
    await sleep(200)
  }
  return null
}

app.whenReady().then(async () => {
  await sleep(700)
  ipcMain.emit('refs:open')
  const win = await waitForWindow((w) => w.webContents.getURL().includes('refs.html'))
  if (!win) {
    console.error('参考图库窗口未打开')
    return app.exit(1)
  }
  await sleep(900)

  const dirName = process.argv[2] || 'pet'
  const action = process.argv[3] || 'idle'
  const res = await win.webContents.executeJavaScript(
    `window.refsAPI.reextractAnim(${JSON.stringify(dirName)}, ${JSON.stringify(action)})`
  )
  if (!res || !res.ok) {
    console.error('❌ 重抽失败:', res && res.error)
    return app.exit(1)
  }
  console.log('✅ 精灵表已重建:', res.sheetPath)
  console.log('   尺寸:', res.frames * res.cell + 'x' + res.cell, '（帧数', res.frames, '× cell', res.cell, '）')
  console.log('   抠图模式:', res.keyMode, ' 四边绿色占比:', res.greenRatio)
  const out = path.join(os.tmpdir(), 'reextract-preview.png')
  fs.writeFileSync(out, Buffer.from(String(res.preview).split(',')[1], 'base64'))
  console.log('   预览已存:', out)
  app.exit(0)
})
