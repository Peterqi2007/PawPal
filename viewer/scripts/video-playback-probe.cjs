#!/usr/bin/env node
// 定位 MEDIA_ERR_SRC_NOT_SUPPORTED：分别试「blob 路径」与「直连协议」
'use strict'
const path = require('path')
require(path.join(__dirname, '..', 'main.js'))
const { app, BrowserWindow } = require('electron')

const REL = process.argv[2] || 'pet-58e5f3/idle-source.mp4'

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  await win.loadFile(path.join(__dirname, '..', 'animator.html'))

  const out = await win.webContents.executeJavaScript(`(async () => {
    const log = []
    const v = document.createElement('video')
    v.muted = true; v.playsInline = true
    document.body.appendChild(v)
    const src = 'petmedia://media/${REL}'

    log.push({ 步骤: 'canPlayType mp4', 结果: v.canPlayType('video/mp4') || '(空)' })
    log.push({ 步骤: 'canPlayType h264+aac', 结果: v.canPlayType('video/mp4; codecs="avc1.64001f, mp4a.40.2"') || '(空)' })

    // ① fetch → blob
    let blobInfo = null
    let blobUrl = null
    try {
      const res = await fetch(src)
      const buf = await res.arrayBuffer()
      blobInfo = { status: res.status, ok: res.ok, bytes: buf.byteLength, type: res.headers.get('content-type') }
      blobUrl = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }))
    } catch (e) {
      blobInfo = { error: String(e && e.message) }
    }
    log.push({ 步骤: 'fetch+blob', 结果: JSON.stringify(blobInfo) })

    const tryPlay = (url, label) => new Promise((resolve) => {
      const el = document.createElement('video')
      el.muted = true; el.preload = 'auto'
      const t = setTimeout(() => resolve({ label, ok: false, why: 'timeout', readyState: el.readyState }), 6000)
      el.addEventListener('loadeddata', () => { clearTimeout(t); resolve({ label, ok: true, w: el.videoWidth, h: el.videoHeight, dur: el.duration, seekable: el.seekable.length ? el.seekable.end(0) : 0 }) })
      el.addEventListener('error', () => { clearTimeout(t); resolve({ label, ok: false, code: el.error && el.error.code, msg: el.error && el.error.message }) })
      el.src = url
      el.load()
    })

    if (blobUrl) log.push({ 步骤: 'blob 播放', 结果: JSON.stringify(await tryPlay(blobUrl, 'blob')) })
    log.push({ 步骤: '直连协议播放', 结果: JSON.stringify(await tryPlay(src, 'direct')) })
    return log
  })()`)

  for (const row of out) console.log(`  ${row.步骤.padEnd(22)} ${row.结果}`)
  win.destroy()
  app.exit(0)
})
