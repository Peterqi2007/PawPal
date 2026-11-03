#!/usr/bin/env node
// 逐帧打印：源尺寸 → 抠图后内容 bbox → 缩放系数 → 落在格子里的实际高度
'use strict'
const path = require('path')
require(path.join(__dirname, '..', 'main.js'))
const { app, BrowserWindow } = require('electron')

const REL = process.argv[2] || 'pet-58e5f3/idle-source.mp4'
const CELL = 512

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  await win.loadFile(path.join(__dirname, '..', 'animator.html'))

  const out = await win.webContents.executeJavaScript(`(async () => {
    const A = window.PetPetAnimator
    const v = document.createElement('video')
    v.muted = true; v.preload = 'auto'
    const res = await fetch('petmedia://media/${REL}')
    v.src = URL.createObjectURL(await res.blob())
    await new Promise((r, j) => { v.addEventListener('loadeddata', r, {once:true}); v.addEventListener('error', () => j(new Error('load')), {once:true}) })

    const c = document.createElement('canvas')
    c.width = v.videoWidth; c.height = v.videoHeight
    const ctx = c.getContext('2d', { willReadFrequently: true })
    const frames = []
    const seek = (t) => new Promise((r) => { const f = () => { v.removeEventListener('seeked', f); r() }; v.addEventListener('seeked', f); v.currentTime = t })

    for (let i = 0; i < 12; i++) {
      await seek(Math.min(v.duration - 0.02, (v.duration / 12) * (i + 0.5)))
      ctx.drawImage(v, 0, 0)
      const img = ctx.getImageData(0, 0, c.width, c.height)
      const mode = A.detectGreenBackground(img.data, c.width, c.height) >= 0.5 ? 'chroma' : 'edge'
      const cr = mode === 'chroma'
        ? A.chromaKeyAlpha(img.data, c.width, c.height, { feather: 1 })
        : null
      if (mode !== 'chroma') A.edgeFloodAlpha(img.data, c.width, c.height, { tolerance: 42, feather: 1 })
      const beforeKeep = A.trimBounds(img.data, c.width, c.height)
      A.keepLargestForeground(img.data, c.width, c.height)
      const box = A.trimBounds(img.data, c.width, c.height)
      frames.push({ i, mode, gate: cr && cr.dominanceGate, beforeKeep, box })
    }

    const maxW = Math.max(...frames.map(f => f.box ? f.box.width : 0))
    const maxH = Math.max(...frames.map(f => f.box ? f.box.height : 0))
    const usable = Math.round(${CELL} * (1 - A.DEFAULT_PADDING * 2))
    const scale = Math.min(usable / maxW, usable / maxH, 1)
    return {
      源尺寸: [c.width, c.height],
      可用区: usable,
      maxW, maxH,
      缩放系数: Number(scale.toFixed(4)),
      落格尺寸: [Math.round(maxW * scale), Math.round(maxH * scale)],
      帧: frames.map(f => ({
        帧: f.i + 1,
        模式: f.mode,
        抠图后: f.beforeKeep ? [f.beforeKeep.width, f.beforeKeep.height] : null,
        去碎斑后: f.box ? [f.box.width, f.box.height, 'x' + f.box.x + ',y' + f.box.y] : null
      }))
    }
  })()`)

  console.log('源尺寸:', out.源尺寸, ' 可用区:', out.可用区, 'px')
  console.log('所有帧并集: maxW=' + out.maxW, 'maxH=' + out.maxH)
  console.log('缩放系数:', out.缩放系数, ' → 落进格子的实际尺寸:', out.落格尺寸)
  console.log('')
  console.log('帧  模式    抠图后bbox        去碎斑后bbox')
  for (const f of out.帧) {
    console.log(String(f.帧).padStart(2), f.模式.padEnd(7), String(f.抠图后).padEnd(18), String(f.去碎斑后))
  }
  win.destroy()
  app.exit(0)
})
