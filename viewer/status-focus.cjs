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
// 展开时约 160px 面板 —— 窗口高度跟着内容变，透明区才不会挡住桌面点击。
const CAPSULE_WIDTH = 300
const COLLAPSED_HEIGHT = 74
const EXPANDED_HEIGHT = 190
const EDGE_MARGIN = 12

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
  const { app, ipcMain, getPet, readStats } = deps
  let win = null
  let ignoring = true

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
    return {
      ok: true,
      petId: pet.id,
      name: typeof pet.name === 'string' && pet.name ? pet.name : '宠物',
      stats: state
        ? { satiety: state.satiety, mood: state.mood, checkins: state.checkins }
        : null,
      avatar: sprite ? { url: spriteUrl(pet.id, sprite.rel), action: sprite.action } : null
    }
  }

  // 贴右上角：用工作区（排除任务栏/Dock），换屏或改分辨率后重新贴一次
  function place(target) {
    if (!target || target.isDestroyed()) return
    const area = screen.getPrimaryDisplay().workArea
    target.setPosition(
      Math.round(area.x + area.width - CAPSULE_WIDTH - EDGE_MARGIN),
      Math.round(area.y + EDGE_MARGIN)
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
    })
    win.on('closed', () => {
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

  // 窗口高度跟着卡片走：若固定 260px 高，收起后下方约 200px 的透明区会吃掉桌面点击
  // （点不到下面的图标/文件）。渲染层在收起动画结束后才发 false，避免动画被裁掉。
  ipcMain.on('capsule:expanded', (_evt, expanded) => {
    if (!win || win.isDestroyed()) return
    const height = expanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT
    try {
      const bounds = win.getBounds()
      if (bounds.height === height) return
      win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height })
    } catch (e) {
      console.error('[capsule] 调整窗口高度失败:', e)
    }
  })

  // 鼠标穿透：展开期间接管鼠标，移出后立刻交还（不等收起动画）
  ipcMain.on('capsule:ignore-mouse', (_evt, ignore) => {
    if (!win || win.isDestroyed()) return
    const next = Boolean(ignore)
    if (next === ignoring) return
    ignoring = next
    if (next) win.setIgnoreMouseEvents(true, { forward: true })
    else win.setIgnoreMouseEvents(false)
  })

  return {
    create,
    // 宠物切换等时机主动推一次刷新（胶囊自己也会在展开时拉一次，双保险）
    refresh() {
      if (win && !win.isDestroyed()) win.webContents.send('capsule:refresh')
    },
    getWindow: () => win
  }
}

module.exports = {
  registerStatusFocus,
  pickSprite,
  spriteUrl,
  CAPSULE_WIDTH,
  COLLAPSED_HEIGHT,
  EXPANDED_HEIGHT
}
