#!/usr/bin/env node
// 真实联网端到端：走完整 IPC → Seedream → 入库 的路径验证一次重绘。
// 用法：ARK_API_KEY=... npx electron scripts/refs-live-test.cjs
// 注意：会真实调用一次接口（计费 1 张），并把生成图加入当前分组。
'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')

const KEY = (process.env.ARK_API_KEY || '').trim()

require(path.join(__dirname, '..', 'main.js'))
const { app, BrowserWindow, ipcMain } = require('electron')
const { saveConfig } = require(path.join(__dirname, '..', 'ark-config.cjs'))

const CONFIG = process.env.PETPET_ARK_CONFIG || path.join(os.homedir(), '.petpet', 'ark.json')
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

async function run() {
  await app.whenReady()
  await sleep(700)

  // 1. 配置：以真实配置为基准（端点/模型 ID 跟控制台保持一致），apiKey 可用环境变量覆盖
  const os = require('os')
  const realConfigPath = path.join(os.homedir(), '.petpet', 'ark.json')
  let base = {}
  try {
    base = JSON.parse(fs.readFileSync(realConfigPath, 'utf8'))
  } catch {
    base = {}
  }
  saveConfig(CONFIG, {
    apiKey: KEY || base.apiKey,
    baseUrl: base.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
    model: base.model || 'doubao-seedream-5-0-pro-260628',
    videoModel: base.videoModel || 'doubao-seedance-2-0-260128',
    style: base.style || '皮克斯3D卡通风格'
  })
  console.log('配置已写入:', CONFIG, '(0600)')
  console.log('  端点:', base.baseUrl || '(默认)')
  console.log('  图片模型:', base.model || '(默认)')

  // 2. 打开面板，走渲染层的真实 API
  ipcMain.emit('refs:open')
  const win = await waitForWindow((w) => w.webContents.getURL().includes('refs.html'))
  if (!win) throw new Error('参考图库窗口未打开')
  await sleep(1000)

  // 可选：用仓库示例照片播种（干净库跑成功路径，避免用户测试图触发内容审核）
  if (process.argv.includes('--seed-examples')) {
    const repo = path.resolve(__dirname, '..', '..')
    const rels = [
      'redshao/real-photo-1.jpg',
      'redshao/real-photo-2.jpg',
      'redshao/real-photo-3.jpg',
      'baobao/real-photo-full.jpg'
    ]
    const payload = rels.map((rel) => ({
      name: path.basename(rel),
      dataUrl: `data:image/jpeg;base64,${fs.readFileSync(path.join(repo, 'examples', rel)).toString('base64')}`
    }))
    const seeded = await win.webContents.executeJavaScript(
      `window.refsAPI.addFiles(${JSON.stringify(payload)})`
    )
    console.log('已播种示例照片:', seeded.added, '张', seeded.errors?.length ? seeded.errors : '')
    await sleep(400)
  }

  const state = await win.webContents.executeJavaScript('window.refsAPI.state()')
  const gid = state.activeGroupId
  const s = state.stats
  console.log(`分组「${state.groups.find((g) => g.id === gid)?.name}」: 设定图 ${s.setupCount} / 姿势参考 ${s.poseCount}`)

  // 3. 先 dry-run：确认请求体正确且不花钱
  const dry = await win.webContents.executeJavaScript(
    `window.refsAPI.generate(${JSON.stringify(gid)}, { dryRun: true })`
  )
  console.log('dry-run:', dry.ok ? `ok · 参考图 ${dry.meta.refCount} 张 · ${dry.meta.url}` : `失败 ${dry.error}`)
  if (dry.ok) {
    const body = dry.requestBody
    console.log('  请求体字段:', Object.keys(body).join(', '))
    console.log(`  image 数量: ${Array.isArray(body.image) ? body.image.length : 0}`)
  }

  // 4. 真实生成
  console.log('\n开始真实生成（计费 1 张）…')
  const t0 = Date.now()
  const res = await win.webContents.executeJavaScript(`window.refsAPI.generate(${JSON.stringify(gid)})`)
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  if (!res.ok) {
    console.error(`❌ 生成失败（${secs}s）: ${res.error}`)
    return 1
  }
  console.log(`✅ 生成成功（${secs}s）`)
  console.log('   新条目:', res.item.originalName, '| role =', res.item.role, '| source =', res.item.source)
  console.log('   尺寸:', res.item.width + 'x' + res.item.height, '|', Math.round(res.item.bytes / 1024), 'KB')
  if (res.usage) console.log('   usage:', JSON.stringify(res.usage))

  // 5. 取回缩略图存盘查看
  const dataUrl = await win.webContents.executeJavaScript(`window.refsAPI.thumb(${JSON.stringify(res.item.id)})`)
  if (dataUrl && dataUrl.startsWith('data:')) {
    const out = path.join(os.tmpdir(), 'petpet-live-redraw.jpg')
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'))
    console.log('   缩略图已保存:', out)
  }
  return 0
}

app.whenReady().then(async () => {
  let code = 1
  try {
    code = await run()
  } catch (e) {
    console.error('异常:', e && e.stack ? e.stack : e)
  }
  app.exit(code)
})
