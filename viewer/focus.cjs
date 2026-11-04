// B-3 专注模式的主进程侧：设置卡小窗 + focus.json 落盘 + 到点归零 + 重启恢复
//
// 与 A 的分工（契约 C3/C5）：
//   开始/结束由这里统一广播 `focus:state`（true/false），A 的渲染层监听它做变暗+停随机动作
//   （A 合并进来的是布尔通道，不是文档里的 focus:enter / focus:exit 两条，这里以实际接线的为准）。
//   A 的右键菜单发 `focus:request` 打开设置卡，托盘菜单直接调 open()。
//
// 时间用绝对时间戳 endAt 存盘：重启后按 endAt 继续算，不需要累计已过时间，也就不会双重计时。
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { BrowserWindow, screen } = require('electron')
const { parseMinutes, remaining } = require('./focus-time.cjs')

const CARD_WIDTH = 360
const CARD_HEIGHT = 236
const TIMEOUT_MAX = 2147483647 // setTimeout 上限，超过会立刻触发

function registerFocus(deps) {
  const { ipcMain, send, onChange } = deps
  const baseDir = deps.baseDir || path.join(os.homedir(), '.petpet')
  const file = path.join(baseDir, 'focus.json')

  let active = null // { minutes, endAt }
  let timer = null
  let card = null

  function readPersisted() {
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // 坏档不静默删：留个 .corrupt-* 便于排查
        try {
          fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
        } catch (_) { /* 备份失败也不影响启动 */ }
      }
      return null
    }
    const minutes = parseMinutes(raw && raw.minutes)
    const endAt = Number(raw && raw.endAt)
    if (!minutes || !Number.isFinite(endAt)) return null
    return { minutes, endAt }
  }

  function persist() {
    fs.mkdirSync(baseDir, { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(active), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function removeFile() {
    try {
      fs.rmSync(file, { force: true })
    } catch (e) {
      console.error('[focus] 删除 focus.json 失败:', e)
    }
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  // 归零：按绝对时间戳判定，sleep/休眠错过整点也能在唤醒后的下一次检查里正确结束
  function schedule() {
    clearTimer()
    if (!active) return
    const left = remaining(active.endAt)
    if (left <= 0) {
      finish('done')
      return
    }
    timer = setTimeout(() => {
      timer = null
      if (!active) return
      if (remaining(active.endAt) <= 0) finish('done')
      else schedule()
    }, Math.min(left, TIMEOUT_MAX))
  }

  function broadcast() {
    if (typeof onChange === 'function') {
      try {
        onChange()
      } catch (e) {
        console.error('[focus] 通知胶囊刷新失败:', e)
      }
    }
  }

  // 结束时让桌宠扭两下 + 冒个气泡（复用 A 的 reminder:fire，sound 由 A 自己按偏好处理）
  function celebrate() {
    if (typeof send !== 'function') return
    send('reminder:fire', {
      id: 'focus-done',
      text: '休息一下，顺便给我换水吧。',
      kind: 'focus',
      sound: true
    })
  }

  function finish(reason) {
    if (!active) return { ok: false }
    const minutes = active.minutes
    active = null
    clearTimer()
    removeFile()
    if (typeof send === 'function') send('focus:state', false)
    broadcast()
    celebrate()
    console.log('[PetPet] 专注结束（' + reason + '），本次 ' + minutes + ' 分钟')
    return { ok: true, minutes }
  }

  function start(minutesInput) {
    const minutes = parseMinutes(minutesInput)
    if (!minutes) return { ok: false, reason: 'invalid-minutes' }
    active = { minutes, endAt: Date.now() + minutes * 60000 }
    try {
      persist()
    } catch (e) {
      // 落盘失败不影响本次专注，只是重启后不会恢复
      console.error('[focus] 写入 focus.json 失败:', e)
    }
    send('focus:state', true)
    schedule()
    broadcast()
    // 等 invoke 的回复先发出去再关窗，避免渲染层拿到「窗口已销毁」的报错
    setImmediate(closeCard)
    return { ok: true, minutes, endAt: active.endAt }
  }

  function getState() {
    if (!active) return { active: false }
    return { active: true, minutes: active.minutes, endAt: active.endAt, remainingMs: remaining(active.endAt) }
  }

  // ---------- 设置卡（独立小窗，居中主屏） ----------
  function closeCard() {
    if (card && !card.isDestroyed()) card.close()
  }

  function open() {
    if (card && !card.isDestroyed()) {
      card.show()
      card.focus()
      return card
    }
    const area = screen.getPrimaryDisplay().workArea
    card = new BrowserWindow({
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      x: Math.round(area.x + (area.width - CARD_WIDTH) / 2),
      y: Math.round(area.y + (area.height - CARD_HEIGHT) / 2),
      frame: false,
      transparent: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'focus-preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    card.setAlwaysOnTop(true, 'screen-saver')
    card.on('closed', () => {
      card = null
    })
    card.once('ready-to-show', () => {
      if (!card || card.isDestroyed()) return
      card.show()
      card.focus()
    })
    card.loadFile(path.join(__dirname, 'focus.html'))
    return card
  }

  // 打开入口：A 的右键菜单 / 主窗口按钮
  ipcMain.on('focus:request', () => open())
  // 设置卡：开始 / 取消
  ipcMain.handle('focus:start', (_evt, minutes) => start(minutes))
  ipcMain.on('focus:cancel', () => closeCard())
  // 胶囊上的「提前结束」
  ipcMain.on('focus:stop', () => finish('early'))

  return {
    open,
    start,
    finish,
    closeCard,
    getState,
    // 启动时调用：endAt 未到则续上计时并补发状态，已过则清文件
    resume() {
      const persisted = readPersisted()
      if (!persisted) {
        if (fs.existsSync(file)) removeFile()
        return getState()
      }
      if (remaining(persisted.endAt) <= 0) {
        removeFile()
        return getState()
      }
      active = persisted
      schedule()
      broadcast()
      return getState()
    },
    // 渲染层就绪后补发一次状态（启动恢复时 main 窗口可能还没监听）
    pushState() {
      if (typeof send === 'function') send('focus:state', !!active)
    }
  }
}

module.exports = { registerFocus, CARD_WIDTH, CARD_HEIGHT }
