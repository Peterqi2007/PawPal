// B-2 / B-3：状态胶囊窗 + 专注模式（主进程侧）
//
// 职责边界（docs/handoff/B-状态与专注.md）：
//   - 胶囊窗：右上角独立常驻窗，收起一条 56px 的状态条，悬停展开今日状态
//   - 专注模式：设置卡 → 计时 → 胶囊显示倒计时 → 结束后唤醒桌宠
//   - 数值不在这里算：一律读 stats-store（B1）给的快照，胶囊只负责显示
//
// 与 Part A 的接口（README §5 C5）：
//   发 `focus:state`(entering:boolean) 给桌宠渲染层 → A 负责"变暗 + 暂停随机行为"
//   结束唤醒：发 `pet:action`(wiggle) + `pet:bubble`(文案)
'use strict'

const path = require('path')
const fs = require('fs')

const {
  parseMinutes,
  endAtFromMinutes,
  normalizeFocus,
  remainingMs,
  formatCountdown
} = require('./focus-session.cjs')
const { buildCapsuleModel } = require('./capsule-state.cjs')

const CAPSULE_W = 300
const CAPSULE_H = 300 // 固定为"展开且显示专注块"的高度（收起只显示顶部 60px，其余透明）
                     // 定高避免 setBounds 抖动；多出来的透明区靠鼠标穿透放过下层应用
const CAPSULE_MARGIN = 12
const CARD_W = 360
const CARD_H = 236
const TICK_MS = 1000
const WAKE_BUBBLE = '休息一下，顺便给我换水吧。'

/**
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {import('electron').Screen} deps.screen
 * @param {typeof import('electron').BrowserWindow} deps.BrowserWindow
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {() => ({id: string, name: string}|null)} deps.getPet        当前宠物
 * @param {() => object|null} deps.getStats                            当前数值快照
 * @param {(channel: string, payload?: any) => void} deps.notifyPet     发给桌宠渲染层
 * @param {() => void} [deps.onStateChange]                            专注态变化时重建菜单
 */
function registerStatusFocus(deps) {
  const { app, screen, BrowserWindow, ipcMain, getPet, getStats, getAvatar, notifyPet, onStateChange } = deps
  const focusFile = path.join(app.getPath('home'), '.petpet', 'focus.json')

  let capsuleWindow = null
  let cardWindow = null
  let tickTimer = null
  /** @type {{endAt:number, minutes:number, startedAt:number}|null} */
  let session = null
  let visible = true // 胶囊是否启用（用户可在菜单里关掉）
  let screenListenerBound = false

  // ---------- 落盘 ----------
  function writeFocus(next) {
    try {
      fs.mkdirSync(path.dirname(focusFile), { recursive: true })
      const tmp = `${focusFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, focusFile)
    } catch (e) {
      console.error('[PetPet][专注] 写入失败:', e && e.message)
    }
  }

  function clearFocusFile() {
    try { fs.unlinkSync(focusFile) } catch { /* 不存在就算了 */ }
  }

  // ---------- 胶囊渲染 ----------
  function model() {
    return buildCapsuleModel({
      stats: getStats(),
      focus: session,
      pet: getPet(),
      avatar: typeof getAvatar === 'function' ? getAvatar() : null
    })
  }

  function sendToCapsule(channel, payload) {
    if (capsuleWindow && !capsuleWindow.isDestroyed()) {
      capsuleWindow.webContents.send(channel, payload)
    }
  }

  /** 数值变化 / 换宠物 / 专注态变化后统一刷新胶囊 */
  function refreshCapsule() {
    sendToCapsule('capsule:refresh', model())
  }

  function positionCapsule() {
    if (!capsuleWindow || capsuleWindow.isDestroyed()) return
    const { x, y, width } = screen.getPrimaryDisplay().workArea
    capsuleWindow.setBounds({
      x: Math.round(x + width - CAPSULE_W - CAPSULE_MARGIN),
      y: Math.round(y + CAPSULE_MARGIN),
      width: CAPSULE_W,
      height: CAPSULE_H
    })
  }

  function createCapsule() {
    if (capsuleWindow && !capsuleWindow.isDestroyed()) return capsuleWindow
    const { x, y, width } = screen.getPrimaryDisplay().workArea
    capsuleWindow = new BrowserWindow({
      width: CAPSULE_W,
      height: CAPSULE_H,
      x: Math.round(x + width - CAPSULE_W - CAPSULE_MARGIN),
      y: Math.round(y + CAPSULE_MARGIN),
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,   // 不抢焦点：点胶囊不打断用户正在做的事
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'capsule-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    capsuleWindow.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') {
      capsuleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    // 默认整窗穿透（forward 让渲染层仍能收到 mousemove，用来判断指针是否进入胶囊）
    capsuleWindow.setIgnoreMouseEvents(true, { forward: true })
    capsuleWindow.loadFile(path.join(__dirname, 'capsule.html'))
    capsuleWindow.once('ready-to-show', () => {
      if (!capsuleWindow || capsuleWindow.isDestroyed()) return
      capsuleWindow.showInactive() // 不抢焦点
      refreshCapsule()
    })
    capsuleWindow.on('closed', () => { capsuleWindow = null })
    // 换分辨率/插拔屏：位置重算，否则会飘出屏幕（只挂一次，窗口重建不叠加）
    if (!screenListenerBound) {
      screenListenerBound = true
      const reposition = () => positionCapsule()
      screen.on('display-metrics-changed', reposition)
      screen.on('display-added', reposition)
      screen.on('display-removed', reposition)
    }
    return capsuleWindow
  }

  function toggleCapsule(force) {
    visible = typeof force === 'boolean' ? force : !visible
    if (visible) {
      createCapsule()
      if (capsuleWindow && !capsuleWindow.isDestroyed()) capsuleWindow.showInactive()
    } else if (capsuleWindow && !capsuleWindow.isDestroyed()) {
      capsuleWindow.hide()
    }
    if (onStateChange) onStateChange()
    return visible
  }

  // ---------- 专注设置卡 ----------
  function openFocusCard() {
    if (cardWindow && !cardWindow.isDestroyed()) {
      cardWindow.show()
      cardWindow.focus()
      return cardWindow
    }
    const work = screen.getPrimaryDisplay().workArea
    cardWindow = new BrowserWindow({
      width: CARD_W,
      height: CARD_H,
      x: Math.round(work.x + (work.width - CARD_W) / 2),
      y: Math.round(work.y + (work.height - CARD_H) / 2),
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#f6f6f6',
      webPreferences: {
        preload: path.join(__dirname, 'capsule-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    cardWindow.loadFile(path.join(__dirname, 'focus.html'))
    cardWindow.once('ready-to-show', () => {
      if (!cardWindow || cardWindow.isDestroyed()) return
      cardWindow.show()
      cardWindow.focus() // 要打字，必须拿焦点
    })
    cardWindow.on('closed', () => { cardWindow = null })
    return cardWindow
  }

  function closeFocusCard() {
    if (cardWindow && !cardWindow.isDestroyed()) cardWindow.close()
  }

  // ---------- 计时 ----------
  function tickPayload() {
    if (!session) return { focusing: false, remainMs: 0, text: '' }
    const remain = remainingMs(session.endAt)
    return { focusing: remain > 0, remainMs: remain, text: formatCountdown(remain), minutes: session.minutes }
  }

  function stopTick() {
    if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }

  function startTick() {
    stopTick()
    tickTimer = setInterval(() => {
      const payload = tickPayload()
      if (!payload.focusing) {
        finishFocus('natural')
        return
      }
      sendToCapsule('focus:tick', payload)
    }, TICK_MS)
    if (tickTimer.unref) tickTimer.unref()
  }

  /** 专注结束（自然归零或提前结束）：清状态 → 唤醒桌宠 → 胶囊回常规态 */
  function finishFocus(how) {
    if (!session) return { ok: true, already: true }
    session = null
    stopTick()
    clearFocusFile()
    // 让桌宠恢复：A 的 focus:state 钩子负责"取消变暗 + 恢复随机行为"
    notifyPet('focus:state', false)
    if (how !== 'shutdown') {
      notifyPet('pet:action', 'wiggle')
      notifyPet('pet:bubble', WAKE_BUBBLE)
    }
    sendToCapsule('focus:tick', { focusing: false, remainMs: 0, text: '' })
    refreshCapsule()
    if (onStateChange) onStateChange()
    console.log(`[PetPet][专注] 结束（${how}）`)
    return { ok: true }
  }

  function startFocus(rawMinutes) {
    const parsed = parseMinutes(rawMinutes)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    // 重复开始：先收掉旧会话，避免两个计时器打架
    if (session) finishFocus('restart')
    const { endAt } = endAtFromMinutes(parsed.minutes)
    session = { endAt, minutes: parsed.minutes, startedAt: Date.now() }
    writeFocus(session)
    notifyPet('focus:state', true)
    startTick()
    const payload = tickPayload()
    sendToCapsule('focus:tick', payload)
    refreshCapsule()
    if (onStateChange) onStateChange()
    console.log(`[PetPet][专注] 开始 ${parsed.minutes} 分钟 → 结束于 ${new Date(endAt).toLocaleTimeString()}`)
    return { ok: true, ...payload, endAt }
  }

  function stopFocus() {
    return finishFocus('manual')
  }

  /** 启动时恢复：endAt 未到就继续，已过就清文件（时间是绝对的，不存在双重计时） */
  function restore() {
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(focusFile, 'utf-8'))
    } catch (e) {
      if (e && e.code !== 'ENOENT') console.error('[PetPet][专注] 读档失败，按无会话处理:', e.message)
    }
    const revived = normalizeFocus(raw)
    if (!revived) {
      if (raw) clearFocusFile()
      return null
    }
    session = revived
    notifyPet('focus:state', true)
    startTick()
    refreshCapsule()
    console.log(`[PetPet][专注] 重启恢复，剩余 ${formatCountdown(remainingMs(session.endAt))}`)
    return session
  }

  // ---------- IPC ----------
  ipcMain.handle('capsule:get', () => model())
  ipcMain.handle('capsule:toggle', (_evt, force) => ({ visible: toggleCapsule(force) }))
  ipcMain.on('capsule:setIgnoreMouse', (_evt, ignore) => {
    if (!capsuleWindow || capsuleWindow.isDestroyed()) return
    capsuleWindow.setIgnoreMouseEvents(!!ignore, { forward: true })
  })
  ipcMain.handle('focus:get', () => ({ ...tickPayload(), endAt: session ? session.endAt : null }))
  ipcMain.handle('focus:start', (_evt, minutes) => {
    const r = startFocus(minutes)
    if (r.ok) closeFocusCard()
    return r
  })
  ipcMain.handle('focus:stop', () => stopFocus())
  ipcMain.on('focus:request', () => openFocusCard())
  ipcMain.on('focus:card:close', () => closeFocusCard())
  ipcMain.handle('focus:card:getDefault', () => ({ minutes: 25, presets: [15, 25, 45, 60], max: 180 }))

  return {
    createCapsule,
    toggleCapsule,
    openFocusCard,
    closeFocusCard,
    refreshCapsule,
    startFocus,
    stopFocus,
    restore,
    isFocusing: () => !!(session && remainingMs(session.endAt) > 0),
    /** 桌宠页面加载完成后补发一次（启动时的 restore 早于渲染层 ready，会丢） */
    announceFocusState: () => {
      notifyPet('focus:state', !!(session && remainingMs(session.endAt) > 0))
    },
    tickPayload,
    isCapsuleVisible: () => visible,
    /** 退出前清理计时器，避免 app.quit 时留下 interval */
    dispose() {
      stopTick()
      session = null
    }
  }
}

module.exports = { registerStatusFocus, WAKE_BUBBLE, CAPSULE_W, CAPSULE_H }
