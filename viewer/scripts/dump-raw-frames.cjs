#!/usr/bin/env node
// 导出原始帧（不抠图），用于确认「猫本身」在源画面里的真实范围
'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')
require(path.join(__dirname, '..', 'main.js'))
const { app, BrowserWindow } = require('electron')

const REL = process.argv[2] || 'pet-58e5f3/idle-source.mp4'
const OUTDIR = path.join(os.tmpdir(), 'petpet-rawframes')

app.whenReady().then(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true })
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  await win.loadFile(path.join(__dirname, '..', 'animator.html'))

  const urls = await win.webContents.executeJavaScript(`(async () => {
    const v = document.createElement('video')
    v.muted = true; v.preload = 'auto'
    const res = await fetch('petmedia://media/${REL}')
    v.src = URL.createObjectURL(await res.blob())
    await new Promise((r, j) => { v.addEventListener('loadeddata', r, {once:true}); v.addEventListener('error', () => j(new Error('load')), {once:true}) })
    const c = document.createElement('canvas')
    c.width = v.videoWidth; c.height = v.videoHeight
    const ctx = c.getContext('2d')
    const out = []
    for (const t of [0.5, 2.5, 4.5]) {
      await new Promise((r) => { const f = () => { v.removeEventListener('seeked', f); r() }; v.addEventListener('seeked', f); v.currentTime = t })
      ctx.drawImage(v, 0, 0)
      out.push(c.toDataURL('image/png'))
    }
    return { frames: out, w: c.width, h: c.height }
  })()`)

  urls.frames.forEach((u, i) => {
    const p = path.join(OUTDIR, `raw-${i}.png`)
    fs.writeFileSync(p, Buffer.from(u.split(',')[1], 'base64'))
    console.log('已导出:', p)
  })
  console.log('源尺寸:', urls.w + 'x' + urls.h)
  win.destroy()
  app.exit(0)
})
