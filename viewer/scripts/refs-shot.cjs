#!/usr/bin/env node
// 参考图库界面截图脚本（用于设计验收，不参与 CI）
//
// 用法（viewer 目录）：
//   npx electron scripts/refs-shot.cjs [输出png路径]
//
// 流程：启动真实主进程 → 打开参考图库窗口 → 用临时库演示「两只宠物两个分组」
//      → capturePage 截图 → 删除临时库 → 退出。
// 隔离：库目录指向临时目录（PETPET_REFS_DIR），不触碰真实用户库。

'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEMP_REFS = fs.mkdtempSync(path.join(os.tmpdir(), 'petpet-refs-shot-'))
process.env.PETPET_REFS_DIR = TEMP_REFS

require(path.join(__dirname, '..', 'main.js'))
const { app, BrowserWindow, ipcMain } = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = process.argv[2] || path.join(os.tmpdir(), 'refs-ui.png')
const REPO = path.resolve(__dirname, '..', '..')

// 用仓库里的真实示例照片，比纯色块更能反映真实观感
const DOUDOU = ['redshao/real-photo-1.jpg', 'redshao/real-photo-2.jpg', 'redshao/real-photo-3.jpg']
const BAOBAO = ['baobao/real-photo-face.jpg', 'baobao/real-photo-full.jpg']

function payloadOf(rels) {
  return rels.map((rel) => ({
    name: path.basename(rel).replace(/^real-photo-/, '照片-'),
    dataUrl: `data:image/jpeg;base64,${fs.readFileSync(path.join(REPO, 'examples', rel)).toString('base64')}`
  }))
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

async function run() {
  await app.whenReady()
  await sleep(600)
  ipcMain.emit('refs:open')
  const win = await waitForWindow((w) => w.webContents.getURL().includes('refs.html'))
  if (!win) throw new Error('参考图库窗口未能打开')
  await sleep(900)

  const evalIn = (expr) => win.webContents.executeJavaScript(expr)

  // 分组一（自动创建）：红苕的照片
  const s0 = await evalIn('window.refsAPI.state()')
  const g1 = s0.activeGroupId
  const r1 = await evalIn(`window.refsAPI.addFiles(${JSON.stringify(payloadOf(DOUDOU))}, ${JSON.stringify(g1)})`)
  console.log('分组一导入:', r1.added, '张')

  // 分组二（手动新建）：包包的照片
  const created = await evalIn("window.refsAPI.createGroup('包包')")
  const g2 = created.activeGroupId
  const r2 = await evalIn(`window.refsAPI.addFiles(${JSON.stringify(payloadOf(BAOBAO))}, ${JSON.stringify(g2)})`)
  console.log('分组二导入:', r2.added, '张')

  // 切回分组一，展示「多组并存 + 当前组画廊」
  await evalIn(`window.refsAPI.activateGroup(${JSON.stringify(g1)})`)

  const done = new Promise((r) => win.webContents.once('did-finish-load', r))
  win.webContents.reload()
  await done
  await sleep(1600)

  const img = await win.webContents.capturePage()
  fs.writeFileSync(OUT, img.toPNG())
  console.log('截图已保存:', OUT)
}

app.whenReady().then(async () => {
  let code = 0
  try {
    await run()
  } catch (e) {
    console.error('截图失败:', e && e.stack ? e.stack : e)
    code = 1
  }
  try {
    fs.rmSync(TEMP_REFS, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  app.exit(code)
})
