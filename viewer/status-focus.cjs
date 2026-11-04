// B-2 状态胶囊的主进程侧：右上角常驻小窗（收起 56px，悬停展开）
//
// 与 A 的分工：
//   A 的 registerPetCompanion 只管数值落盘与 stats:* IPC；
//   胶囊这边**只读**（capsule:state → statsStore.read），不写状态、不另存一份，
//   避免出现两个真源。宠物信息同样从 main.js 现有的 currentPet* 取，不重复解析 pet.json。
//
// 鼠标穿透：窗口整体 setIgnoreMouseEvents(true, { forward: true })，
// 渲染层靠 mousemove 判断指针是否落在胶囊卡片上，落在卡片上才接管鼠标（否则点击穿透到桌面）。
'use strict'

const path = require('path')
const { BrowserWindow, screen } = require('electron')

// 窗口尺寸 = 卡片尺寸 + 8px 内边距 ×2。收起时只有 56px 一条，
// 展开时面板约 160px（专注行显示时约 205px）—— 窗口高度跟着内容变，透明区才不会挡住桌面点击。
// 展开高度按「专注行也显示」的最坏情况给：否则专注中底部按钮会被 .capsule 的 overflow:hidden 裁掉。
const CAPSULE_WIDTH = 300
// 初始高度只是"渲染层量出真实高度之前"的占位；真正的高度由 capsule:height 通道传来，
// 否则换字体/加一行内容就会把卡片下方的圆角裁掉（2026-11-04 报障）。
const COLLAPSED_HEIGHT = 66
const MIN_HEIGHT = 40
const MAX_HEIGHT = 640
const EDGE_MARGIN = 12
// 跨天自愈：数值重置发生在"下一次读写"时（stats-store 的设计），
// 收起态胶囊不会自己展开，过夜后会一直显示昨天的数字 → 每 60s 主动拉一次。
const SELFTICK_MS = 60_000

// pet.json 里动作图可能是 file 也可能是 sprite（两者等价），取第一个能用的
function pickSprite(actions) {
  if (!actions || typeof actions !== 'object') return null
  const names = ['idle', ...Object.keys(actions)]
  for (const name of names) {
    const act = actions[name]
    if (!act || typeof act !== 'object') continue
    const rel = act.file || act.sprite
    if (typeof rel === 'string' && rel.length > 0) return { rel, action: name }
  }
  return null
}

// petpet://<petId>/<relPath>：与主窗口同一套协议，路径分段编码防止 # ? 之类截断
function spriteUrl(petId, rel) {
  const safeRel = rel
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.' && s !== '..')
    .map(encodeURIComponent)
    .join('/')
  return `petpet://${encodeURIComponent(petId)}/${safeRel}`
}

function registerStatusFocus(deps) {
  const { app, ipcMain, getPet, readStats, getFocus, onVisibilityChange } = deps
  let win = null
  let ignoring = true
  let selftick = null

  // 通知渲染层重新拉一次数据（create() 里的自检定时器与对外的 refresh() 共用）
  function pushRefresh() {
    if (win && !win.isDestroyed()) win.webContents.send('capsule:refresh')
  }

  function buildPayload() {
    let pet = null
    try {
      pet = getPet() || null
    } catch (e) {
      pet = null
    }
    if (!pet || !pet.id) return { ok: false, reason: 'no-pet' }

    let state = null
    try {
      const r = readStats(pet.id)
      if (r && r.ok) state = r.state
    } catch (e) {
      console.error('[capsule] 读取数值失败:', e)
    }

    const sprite = pickSprite(pet.actions)
    // 专注状态由 B-3 的 focus.cjs 持有（只读一份，胶囊不重复计时）
    let focus = { active: false }
    try {
      if (typeof getFocus === 'function') focus = getFocus() || focus
    } catch (e) {
      console.error('[capsule] 读取专注状态失败:', e)
    }

    return {
      ok: true,
      petId: pet.id,
      name: typeof pet.name === 'string' && pet.name ? pet.name : '宠物',
      stats: state
        ? { satiety: state.satiety, mood: state.mood, checkins: state.checkins }
        : null,
      avatar: sprite ? { url: spriteUrl(pet.id, sprite.rel), action: sprite.action } : null,
      focus
    }
  }

  // 贴右上角：用工作区（排除任务栏/Dock），换屏或改分辨率后重新贴一次
  // 保持在所有窗口之上：$level 对 Windows 就是 TOPMOST，moveTop() 负责在同类窗口间重新排序
  function keepOnTop(target) {
    if (!target || target.isDestroyed()) return
    try {
      target.setAlwaysOnTop(true, 'screen-saver')
      target.moveTop()
    } catch (e) {
      console.error('[PawPal][胶囊] 置顶失败:', e && e.message)
    }
  }

  function place(target) {
    if (!target || target.isDestroyed()) return
    const area = screen.getPrimaryDisplay().workArea
    // 贴住工作区顶边（卡片 CSS 也不再留上内边距），水平仍靠右
    target.setPosition(
      Math.round(area.x + area.width - CAPSULE_WIDTH - EDGE_MARGIN),
      Math.round(area.y)
    )
  }

  function create() {
    if (win && !win.isDestroyed()) return win
    win = new BrowserWindow({
      width: CAPSULE_WIDTH,
      height: COLLAPSED_HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'capsule-preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })

    win.setAlwaysOnTop(true, 'screen-saver')
    // 先整窗穿透：不抢占桌面点击；forward 让渲染层仍能收到 mousemove 做悬停判定
    ignoring = true
    win.setIgnoreMouseEvents(true, { forward: true })
    place(win)
    win.loadFile(path.join(__dirname, 'capsule.html'))
    win.once('ready-to-show', () => {
      place(win)
      win.showInactive() // 不抢焦点
      // 置顶层兜底：全屏应用/其它置顶窗激活后，Windows 会把我们压到后面 → 重新抬起来
      keepOnTop(win)
      // 跨天自愈：收起态不会自己展开，每 60s 主动拉一次，读一次就把日期对齐到今天
      if (selftick) clearInterval(selftick)
      selftick = setInterval(() => pushRefresh(), SELFTICK_MS)
      if (selftick.unref) selftick.unref()
    })

    win.on('closed', () => {
      if (selftick) { clearInterval(selftick); selftick = null }
      win = null
      ignoring = true
    })

    screen.on('display-metrics-changed', () => place(win))
    screen.on('display-added', () => place(win))
    screen.on('display-removed', () => place(win))
    return win
  }

  // 数据读取通道：胶囊每次展开 / 定时刷新都走这里，不缓存、不落盘
  ipcMain.handle('capsule:state', () => buildPayload())

  // 鼠标穿透：展开期间接管鼠标，移出后立刻交还（不等收起动画）
  // 高度由渲染层测量后上报（内容驱动的唯一真源）
  ipcMain.on('capsule:height', (_evt, height) => {
    if (!win || win.isDestroyed()) return
    const h = Math.round(Number(height))
    if (!Number.isFinite(h) || h < MIN_HEIGHT || h > MAX_HEIGHT) return
    const bounds = win.getBounds()
    if (bounds.height === h) return
    try {
      win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: h })
    } catch (e) {
      console.error('[PawPal][胶囊] 调整窗口高度失败:', e)
    }
  })

  // 收起按钮：隐藏胶囊（托盘菜单「状态胶囊」可恢复）
  ipcMain.on('capsule:hide', () => hideCapsule())
  // 显隐开关（将来接快捷键也走这里）
  ipcMain.on('capsule:toggle', () => (isVisible() ? hideCapsule() : showCapsule()))

  ipcMain.on('capsule:ignore-mouse', (_evt, ignore) => {
    if (!win || win.isDestroyed()) return
    const next = Boolean(ignore)
    if (next === ignoring) return
    ignoring = next
    if (next) win.setIgnoreMouseEvents(true, { forward: true })
    else win.setIgnoreMouseEvents(false)
  })

  function notifyVisibility() {
    if (typeof onVisibilityChange === 'function') {
      try {
        onVisibilityChange(isVisible())
      } catch (e) {
        console.error('[PawPal][胶囊] 显隐回调失败:', e && e.message)
      }
    }
  }

  function hideCapsule() {
    if (win && !win.isDestroyed()) win.hide()
    notifyVisibility()
  }

  function showCapsule() {
    if (!win || win.isDestroyed()) return create()
    if (!win.isVisible()) win.showInactive()
    place(win)
    keepOnTop(win)
    pushRefresh()   // 注意：闭包里的函数叫 pushRefresh，refresh 只是对外的别名
    notifyVisibility()
  }

  function isVisible() {
    return !!win && !win.isDestroyed() && win.isVisible()
  }

  return {
    create,
    raise: () => keepOnTop(win),
    hide: hideCapsule,
    show: showCapsule,
    isVisible,
    // 宠物切换等时机主动推一次刷新（胶囊自己也会在展开时拉一次，双保险）
    refresh: pushRefresh,
    getWindow: () => win
  }
}

module.exports = {
  registerStatusFocus,
  pickSprite,
  spriteUrl,
  CAPSULE_WIDTH,
  COLLAPSED_HEIGHT
}
