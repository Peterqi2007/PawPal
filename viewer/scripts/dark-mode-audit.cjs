#!/usr/bin/env node
// PawPal 深色/浅色模式对比度审计（Windows 深色模式下「白字糊在白底上」的回归网）
//
// 用法（viewer 目录）：
//   npx electron scripts/dark-mode-audit.cjs --theme=dark
//   npx electron scripts/dark-mode-audit.cjs --theme=light
//   npx electron scripts/dark-mode-audit.cjs --theme=dark --out=D:\tmp\shots
//
// 做法：强制 nativeTheme.themeSource → 启动真实主进程 → 依次打开
//      桌宠窗（强制显示大气泡/提醒面板/空态卡）、参考图库、使用说明、日记、专注卡、状态胶囊
//      → 在页面里遍历「直接带文字的元素」，把文字色与逐层合成后的实际背景色做 WCAG 对比度计算
//      → 低于阈值的元素全部列出来，并给每个窗口截图留证。
//
// 为什么不用肉眼看：透明窗口 + 毛玻璃 + 半透明卡片的最终背景色是合成出来的，
// 静态看 CSS 很容易漏；这里按真实的层叠关系算。
//
// 注意：如果所在目录对可执行文件有写入/运行限制（受限工作区、受管目录），
// electron 可能起不来；把 viewer 复制到普通目录再跑即可（脚本不依赖仓库其他文件）。
//
// 退出码：有元素对比度低于 3.0 → 1（CI/本地都能当门禁用）。

'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')

// 隔离：参考图库/配置/动画产物都指向临时目录，不碰真实用户数据
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pawpal-dark-audit-'))
process.env.PAWPAL_REFS_DIR = path.join(TEMP, 'refs')
process.env.PAWPAL_ARK_CONFIG = path.join(TEMP, 'ark.json')
process.env.PAWPAL_ANIM_DIR = path.join(TEMP, 'anim')
delete process.env.ARK_API_KEY

const { app, BrowserWindow, nativeTheme, ipcMain } = require('electron')

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const THEME = argOf('theme', 'dark') === 'light' ? 'light' : 'dark'
const OUT_DIR = argOf('out', path.join(TEMP, 'shots'))
const MIN_RATIO = Number(argOf('min', '3'))
// Windows 上 Electron 是 GUI 子系统进程，stdout 在管道里经常拿不到；
// 因此所有结论同时写文件，命令行看不到时以 report-<theme>.json / trace 为准。
const TRACE_FILE = path.join(OUT_DIR, `trace-${THEME}.log`)
fs.mkdirSync(OUT_DIR, { recursive: true })
const trace = (msg) => {
  try {
    fs.appendFileSync(TRACE_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志失败不阻塞 */
  }
}
process.on('uncaughtException', (e) => {
  trace(`uncaughtException: ${e && (e.stack || e.message)}`)
})
trace(`start theme=${THEME} electron=${process.versions.electron} node=${process.versions.node}`)

// 必须在主进程建窗前设好：渲染层的 prefers-color-scheme 跟着它走
nativeTheme.themeSource = THEME

require(path.join(__dirname, '..', 'main.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForWindow(pred, timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const w = BrowserWindow.getAllWindows().find(pred)
    if (w && !w.isDestroyed()) return w
    await sleep(150)
  }
  return null
}

/** 页面内执行的审计：返回 [{ selector, text, color, bg, ratio }] */
function auditScript(baseColor, minRatio) {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const p = m[1].split(',').map((s) => parseFloat(s))
    if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a)
    if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 }
    const mix = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a }
  }
  const lum = (c) => {
    const f = (v) => {
      v /= 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const contrast = (a, b) => {
    const l1 = lum(a)
    const l2 = lum(b)
    const hi = Math.max(l1, l2)
    const lo = Math.min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)
  }
  const base = parse(baseColor)
  const effectiveBg = (el) => {
    const stack = []
    for (let n = el; n; n = n.parentElement) stack.push(parse(getComputedStyle(n).backgroundColor))
    let acc = base
    for (let i = stack.length - 1; i >= 0; i--) {
      const c = stack[i]
      if (c && c.a > 0) acc = over(c, acc)
    }
    return acc
  }
  const selectorOf = (el) => {
    let s = el.tagName.toLowerCase()
    if (el.id) s += `#${el.id}`
    const cls = (el.className && typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
    if (cls.length) s += '.' + cls.join('.')
    return s
  }
  const hasDirectText = (el) =>
    Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)

  const out = []
  const seen = new Set()
  const consider = (el, text) => {
    if (seen.has(el)) return
    seen.add(el)
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.35) return
    if (!el.getClientRects().length) return
    const fgRaw = parse(cs.color)
    if (!fgRaw) return
    const bg = effectiveBg(el)
    const fg = over(fgRaw, bg)
    const ratio = contrast(fg, bg)
    if (ratio < minRatio) {
      out.push({
        selector: selectorOf(el),
        text: String(text || '').trim().slice(0, 40),
        color: cs.color,
        bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
        ratio: Math.round(ratio * 100) / 100
      })
    }
  }

  for (const el of document.querySelectorAll('body *')) {
    if (hasDirectText(el)) consider(el, Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '))
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) {
      // 复选框/单选框/滑块的文字是原生绘制的，`value` 不代表可见文本，审计会误报
      if (el.tagName === 'INPUT' && /^(checkbox|radio|range|file|color|hidden)$/i.test(el.type)) continue
      const t = el.tagName === 'BUTTON' ? el.textContent : el.value || el.getAttribute('placeholder') || ''
      if (t) consider(el, t)
    }
  }
  return out
}

async function auditWindow(win, name, { base, prepare } = {}) {
  trace(`audit ${name}: ${win && !win.isDestroyed() ? 'window ok' : 'no window'}`)
  if (!win || win.isDestroyed()) return { name, skipped: true, offenders: [] }
  try {
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => setTimeout(r, 260)))')
  } catch {
    /* 忽略 */
  }
  if (prepare) {
    try {
      await win.webContents.executeJavaScript(prepare)
      // 很多浮层有入场动画（opacity 0 → 1）。不等动画结束，审计会因 opacity<0.35 跳过、
      // 截图也只会拿到一帧透明的元素。
      await sleep(450)
    } catch (e) {
      console.warn(`[audit] ${name} 准备脚本失败：${e && e.message}`)
    }
  }
  let offenders = []
  try {
    offenders = await win.webContents.executeJavaScript(
      `(${auditScript.toString()})(${JSON.stringify(base)}, ${MIN_RATIO})`
    )
  } catch (e) {
    console.error(`[audit] ${name} 审计脚本失败：`, e && e.message)
    return { name, error: String(e && e.message), offenders: [] }
  }
  let shot = null
  try {
    const img = await win.webContents.capturePage()
    fs.mkdirSync(OUT_DIR, { recursive: true })
    shot = path.join(OUT_DIR, `${THEME}-${name}.png`)
    fs.writeFileSync(shot, img.toPNG())
  } catch (e) {
    console.warn(`[audit] ${name} 截图失败：`, e && e.message)
  }
  return { name, shot, offenders }
}

/** 等页面加载完：已经加载完就直接返回（once('did-finish-load') 挂在已完成之后会永久等待） */
async function waitLoad(win, timeoutMs = 10000) {
  if (!win || win.isDestroyed()) return
  if (!win.webContents.isLoading()) return
  await Promise.race([
    new Promise((r) => win.webContents.once('did-finish-load', r)),
    sleep(timeoutMs)
  ])
}

async function run() {
  await app.whenReady()
  trace(`app ready, windows=${BrowserWindow.getAllWindows().length}`)
  // 看门狗：任何一步卡死都不要让进程挂着（GUI 进程挂住比报错更难查）
  setTimeout(() => {
    trace('watchdog timeout → exit 2')
    app.exit(2)
  }, 120000).unref?.()
  await sleep(900)

  const results = []
  const petWin = await waitForWindow((w) => w.webContents.getURL().includes('index.html'))
  results.push(
    await auditWindow(petWin, 'pet', {
      // 桌宠窗透明，按深色桌面/浅色桌面兜底合成
      base: THEME === 'dark' ? 'rgb(32, 32, 34)' : 'rgb(236, 236, 238)',
      // 把平时靠交互才出现的三块 UI 强制显示出来，否则审计不到。
      // 桌宠的渲染层会按提醒队列状态重绘（可能又把 .hidden 加回去），
      // 所以挂一个 MutationObserver 持续保持可见，截图才拿得到。
      prepare: `(() => {
        const show = (id) => {
          const el = document.getElementById(id)
          if (!el) return
          el.classList.remove('hidden')
          // 关掉入场动画并锁定不透明：否则审计时 opacity 还是 0，会被当成不可见跳过
          el.style.animation = 'none'
          el.style.opacity = '1'
          if (!el.__keepVisible) {
            el.__keepVisible = true
            new MutationObserver(() => { el.classList.remove('hidden') })
              .observe(el, { attributes: true, attributeFilter: ['class'] })
          }
        }
        show('big-bubble'); show('reminder-panel'); show('pet-empty')
        const bb = document.getElementById('big-bubble-text'); if (bb) bb.textContent = '一分钟后提醒我喝水'
        const bm = document.getElementById('big-bubble-more'); if (bm) bm.textContent = '还有 2 条'
        return true
      })()`
    })
  )

  ipcMain.emit('refs:open')
  const refsWin = await waitForWindow((w) => w.webContents.getURL().includes('refs.html'))
  if (refsWin) {
    await waitLoad(refsWin)
    await sleep(700)
    // 打开设置面板与新建分组输入框，让输入控件也进入审计范围
    results.push(
      await auditWindow(refsWin, 'refs', {
        base: THEME === 'dark' ? 'rgb(27, 26, 25)' : 'rgb(250, 249, 247)',
        prepare: `(() => {
          const g = document.getElementById('group-new'); if (g) g.classList.remove('hidden')
          const a = document.getElementById('ark-panel'); if (a) a.classList.remove('hidden')
          const p = document.getElementById('profile'); if (p) p.classList.remove('hidden')
          return true
        })()`
      })
    )
  } else {
    results.push({ name: 'refs', skipped: true, offenders: [] })
  }

  ipcMain.emit('guide:open')
  const guideWin = await waitForWindow((w) => w.webContents.getURL().includes('guide.html'))
  if (guideWin) {
    await waitLoad(guideWin)
    await sleep(500)
  }
  results.push(await auditWindow(guideWin, 'guide', { base: THEME === 'dark' ? 'rgb(28, 28, 30)' : 'rgb(251, 251, 252)' }))

  const petsDir = path.join(os.homedir(), '.petpet', 'pets')
  const petId = fs.existsSync(petsDir) ? fs.readdirSync(petsDir).find((d) => fs.existsSync(path.join(petsDir, d, 'pet.json'))) : null
  if (petId) {
    ipcMain.emit('diary:open', null, petId)
    const diaryWin = await waitForWindow((w) => w.webContents.getURL().includes('panel.html'))
    if (diaryWin) {
      await waitLoad(diaryWin)
      await sleep(700)
    }
    results.push(await auditWindow(diaryWin, 'diary', { base: THEME === 'dark' ? 'rgb(32, 32, 34)' : 'rgb(246, 246, 246)' }))
  } else {
    results.push({ name: 'diary', skipped: true, offenders: [] })
  }

  ipcMain.emit('focus:request')
  const focusWin = await waitForWindow((w) => w.webContents.getURL().includes('focus.html'))
  if (focusWin) {
    await waitLoad(focusWin)
    await sleep(600)
  }
  results.push(await auditWindow(focusWin, 'focus', { base: THEME === 'dark' ? 'rgb(28, 31, 38)' : 'rgb(255, 255, 255)' }))

  const capsuleWin = await waitForWindow((w) => w.webContents.getURL().includes('capsule.html'))
  results.push(await auditWindow(capsuleWin, 'capsule', { base: THEME === 'dark' ? 'rgb(24, 26, 32)' : 'rgb(255, 255, 255)' }))

  // ── 汇总 ────────────────────────────────────────────────
  console.log(`\n[深色模式审计] theme=${THEME} 阈值=${MIN_RATIO}:1 截图目录=${OUT_DIR}\n`)
  let total = 0
  for (const r of results) {
    if (r.skipped) {
      console.log(`- ${r.name}: 未打开（跳过）`)
      continue
    }
    total += r.offenders.length
    console.log(`- ${r.name}: ${r.offenders.length === 0 ? '✅ 无低对比度文字' : `❌ ${r.offenders.length} 处低于阈值`}`)
    for (const o of r.offenders.slice(0, 12)) {
      console.log(`    ${o.ratio}:1  ${o.selector}  「${o.text}」 文字 ${o.color} / 背景 ${o.bg}`)
    }
    if (r.offenders.length > 12) console.log(`    …还有 ${r.offenders.length - 12} 处`)
  }
  console.log(`\n合计 ${total} 处低对比度文字。`)
  const report = { theme: THEME, minRatio: MIN_RATIO, total, results }
  fs.writeFileSync(path.join(OUT_DIR, `report-${THEME}.json`), JSON.stringify(report, null, 2))
  trace(`done total=${total}`)
  for (const r of results) trace(`${r.name}: ${r.skipped ? 'skipped' : r.offenders.length + ' offenders'}`)
  if (total > 0) process.exitCode = 1
  app.quit()
}

run().catch((e) => {
  console.error('[深色模式审计] 失败：', e && (e.stack || e.message))
  process.exitCode = 2
  app.quit()
})
