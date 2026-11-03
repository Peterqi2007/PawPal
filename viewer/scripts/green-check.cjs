#!/usr/bin/env node
// 检查分组里每张图的绿幕占比，验证「首帧闸门」会挑谁 / 会不会放行
'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')

require(path.join(__dirname, '..', 'main.js'))
const { app, nativeImage } = require('electron')
const { greenRatioOfBitmap } = require(path.join(__dirname, '..', 'animator.cjs'))

function ratio(absPath) {
  const img = nativeImage.createFromPath(absPath)
  if (img.isEmpty()) return 0
  const small = img.resize({ width: 64, height: 64, quality: 'good' })
  const s = small.getSize()
  return greenRatioOfBitmap(small.toBitmap(), s.width, s.height)
}

app.whenReady().then(() => {
  const refsPath = path.join(os.homedir(), '.petpet', 'refs', 'refs.json')
  const idx = JSON.parse(fs.readFileSync(refsPath, 'utf8'))
  const gid = process.argv[2] || idx.lastGroupId
  const group = (idx.groups || []).find((g) => g.id === gid)
  const items = (idx.items || []).filter((it) => it.group === gid)
  console.log(`分组: ${group ? group.name : gid}  (${gid})\n`)

  const rows = items.map((it) => ({
    name: it.originalName,
    role: it.role,
    source: it.source || 'upload',
    green: ratio(path.join(os.homedir(), '.petpet', 'refs', 'images', it.file))
  }))
  rows.sort((a, b) => b.green - a.green)

  for (const r of rows) {
    const pct = (r.green * 100).toFixed(0)
    const pass = r.green >= 0.5 ? '✅ 可作首帧' : '❌ 背景不是绿幕'
    console.log(`  ${pct.padStart(3)}%  ${r.source.padEnd(6)} ${r.role.padEnd(5)} ${r.name}  ${pass}`)
  }
  const best = rows[0]
  console.log('')
  console.log(best && best.green >= 0.5
    ? `→ 闸门会放行，首帧 = ${best.name}（绿 ${(best.green * 100).toFixed(0)}%）`
    : '→ 闸门会拦下：当前分组没有任何绿幕首帧，必须先重绘')
  app.exit(0)
})
