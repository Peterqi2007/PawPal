#!/usr/bin/env node
// 装配验证：把当前分组的动画产物装配成宠物包 → 自动切换 → 截取桌面宠物窗口
'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')

require(path.join(__dirname, '..', 'main.js'))
const { app, BrowserWindow, ipcMain } = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = process.argv[2] || path.join(os.tmpdir(), 'pet-assembled.png')

async function waitForWindow(pred, timeoutMs = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const w = BrowserWindow.getAllWindows().find(pred)
    if (w) return w
    await sleep(200)
  }
  return null
}

async function run() {
  await app.whenReady()
  await sleep(700)
  ipcMain.emit('refs:open')
  const refs = await waitForWindow((w) => w.webContents.getURL().includes('refs.html'))
  if (!refs) throw new Error('参考图库窗口未打开')
  await sleep(900)

  const gid = process.argv[3] || null
  const res = await refs.webContents.executeJavaScript(
    `window.refsAPI.assemblePet(${JSON.stringify(gid)})`
  )
  if (!res || !res.ok) {
    console.error('❌ 装配失败:', res && res.error)
    return 1
  }
  console.log('✅ 已装配:', res.petId)
  console.log('   目录:', res.dir)
  console.log('   动作:', (res.actions || []).join(', '))

  const petJsonPath = path.join(res.dir, 'pet.json')
  const petJson = JSON.parse(fs.readFileSync(petJsonPath, 'utf8'))
  console.log('   pet.json:', JSON.stringify({
    version: petJson.version,
    id: petJson.id,
    name: petJson.name,
    cell: `${petJson.cellWidth}x${petJson.cellHeight}`,
    actions: Object.keys(petJson.actions)
  }))
  const a = petJson.actions.idle || petJson.actions[Object.keys(petJson.actions)[0]]
  console.log(`   动作详情: frames=${a.frames} fps=${a.fps} frame=${a.frameWidth}x${a.frameHeight} weight=${a.weight}`)

  // 等主窗口切到新宠物并渲染几帧
  await sleep(2600)
  // 按 URL 找桌宠窗，不要依赖窗口标题（标题跟着产品名走，改名后这里会静默失效）
  const petWin = BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && /(^|\/)index\.html$/.test(w.webContents.getURL())
  )
  if (petWin) {
    const img = await petWin.webContents.capturePage()
    fs.writeFileSync(OUT, img.toPNG())
    console.log('   桌面宠物截图:', OUT)
  } else {
    console.log('   （未找到宠物主窗口，跳过截图）')
  }
  return 0
}

app.whenReady().then(async () => {
  let code = 1
  try {
    code = await run()
  } catch (e) {
    console.error('❌ 异常:', e && e.stack ? e.stack : e)
  }
  app.exit(code)
})
