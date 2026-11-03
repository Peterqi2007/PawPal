// PetPet 桌宠查看器 - preload 桥接
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petAPI', {
  listPets: () => ipcRenderer.invoke('pet:list'),
  loadPet: (petId) => ipcRenderer.invoke('pet:load', petId),
  getFile: (petId, relPath) => ipcRenderer.invoke('pet:file', petId, relPath),
  setWindowSize: (w, h) => ipcRenderer.send('view:setSize', w, h),
  // 缩放：主进程按真实 bounds 改尺寸并夹回工作区，返回落地后的窗口矩形
  scaleTo: (w, h) => ipcRenderer.invoke('view:scaleTo', w, h),
  moveWindow: (x, y) => ipcRenderer.send('view:move', x, y),
  setIgnoreMouse: (ignore, forward) => ipcRenderer.send('pet:setIgnoreMouse', ignore, forward),
  getWindowPosition: () => ipcRenderer.invoke('view:getPos'),
  notifyPetLoaded: (petId) => ipcRenderer.send('pet:loaded', petId),
  onPetSwitch: (cb) => ipcRenderer.on('pet:switch', (_e, id) => cb(id)),
  onAction: (cb) => ipcRenderer.on('pet:action', (_e, name) => cb(name)),
  onZoom: (cb) => ipcRenderer.on('view:zoom', (_e, factor) => cb(factor)),
  onReset: (cb) => ipcRenderer.on('view:reset', () => cb()),
  onTestAction: (cb) => ipcRenderer.on('test:action', (_e, name) => cb(name)),
  setReminder: (spec) => ipcRenderer.invoke('reminder:set', spec),
  // B-1 数值系统：饱腹 / 心情 / 打卡（返回值即最新状态，调用方只信返回值）
  stats: {
    get: (petId) => ipcRenderer.invoke('stats:get', petId),
    patch: (petId, delta) => ipcRenderer.invoke('stats:patch', petId, delta)
  },
  onReminderFire: (cb) => ipcRenderer.on('reminder:fire', (_e, r) => cb(r)),
  // Part A：数值 / 偏好 / 专注钩子 / 音效上报
  statsGet: (petId) => ipcRenderer.invoke('stats:get', petId),
  statsPatch: (petId, delta) => ipcRenderer.invoke('stats:patch', petId, delta),
  prefsGet: () => ipcRenderer.invoke('prefs:get'),
  prefsSet: (patch) => ipcRenderer.invoke('prefs:set', patch),
  reportAudio: (status, detail) => ipcRenderer.send('audio:report', status, detail),
  onFocusChange: (cb) => ipcRenderer.on('focus:state', (_e, entering) => cb(!!entering)),
  // Part B：专注结束由主进程发一条唤醒气泡（渲染层只负责显示）
  onBubble: (cb) => ipcRenderer.on('pet:bubble', (_e, text) => cb(String(text || ''))),
  appendActivity: (entry) => ipcRenderer.send('pet:activity', entry),
  listActivity: (petId) => ipcRenderer.invoke('pet:activity:list', petId),
  showContextMenu: (x, y) => ipcRenderer.invoke('menu:showContext', x, y),
  notifyAction: (info) => ipcRenderer.send('pet:action:notify', info),
  openDiary: (petId) => ipcRenderer.send('diary:open', petId),
  onOpenReminder: (cb) => ipcRenderer.on('open:reminder', () => cb()),
  onVisibility: (cb) => ipcRenderer.on('pet:visibility', (_e, visible) => cb(visible)),  // P2-5: 隐藏时暂停动画
})
