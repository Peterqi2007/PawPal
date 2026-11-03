#!/usr/bin/env node
// 诊断：视频到底是「静止」还是「抽帧失败（总拿同一帧）」
// 用法：npx electron scripts/video-diff-probe.cjs [anim 相对路径]
'use strict'
const path = require('path')
require(path.join(__dirname, '..', 'main.js'))
const { app, BrowserWindow } = require('electron')

const REL = process.argv[2] || 'pet-58e5f3/idle-source.mp4'

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  await win.loadFile(path.join(__dirname, '..', 'animator.html'))

  const out = await win.webContents.executeJavaScript(`(async () => {
    const v = document.getElementById('v')
    v.src = 'petmedia://media/${REL}'
    v.load()
    await new Promise((res, rej) => {
      v.addEventListener('loadeddata', res, { once: true })
      v.addEventListener('error', () => rej(new Error('load error')), { once: true })
    })
    const info = {
      duration: v.duration, w: v.videoWidth, h: v.videoHeight,
      seekable: v.seekable.length ? [[v.seekable.start(0), v.seekable.end(0)]] : [],
      buffered: v.buffered.length ? [[v.buffered.start(0), v.buffered.end(0)]] : []
    }
    const c = document.createElement('canvas')
    c.width = v.videoWidth; c.height = v.videoHeight
    const ctx = c.getContext('2d', { willReadFrequently: true })

    const grab = async (t) => {
      await new Promise((res) => {
        const done = () => { v.removeEventListener('seeked', done); res() }
        v.addEventListener('seeked', done)
        v.currentTime = t
      })
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      ctx.drawImage(v, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let sum = 0
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2]
      return { t, actualTime: v.currentTime, checksum: sum, data: d }
    }

    const a = await grab(0.3)
    const b = await grab(2.5)
    const e = await grab(4.6)

    const diff = (x, y) => {
      let s = 0, n = 0
      for (let i = 0; i < x.data.length; i += 4) {
        s += Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2])
        n += 3
      }
      return Number((s / n / 255).toFixed(5))
    }

    return {
      info,
      frames: [a, b, e].map(f => ({ 请求时间: f.t, 实际时间: Number(f.actualTime.toFixed(2)), 校验和: f.checksum })),
      差异A: diff(a, b),
      差异B: diff(b, e)
    }
  })()`)

  console.log('视频信息:', JSON.stringify(out.info))
  console.log('三个时间点:', JSON.stringify(out.frames))
  console.log('0.3s vs 2.5s 差异:', out.差异A)
  console.log('2.5s vs 4.6s 差异:', out.差异B)
  console.log('')
  if (out.差异A === 0 && out.差异B === 0) {
    console.log('❌ 三次抓的都是同一帧 → seek 无效，抽帧管线有问题')
  } else {
    console.log('✅ seek 正常（视频本身有画面变化）')
  }
  win.destroy()
  app.exit(0)
})
