// 状态胶囊 / 专注设置卡 共用的 preload（白名单：只暴露这两个窗口需要的方法）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('capsuleAPI', {
  // 胶囊数据：主进程算好视图模型，渲染层只负责画（不在这里算数值）
  get: () => ipcRenderer.invoke('capsule:get'),
  onRefresh: (cb) => ipcRenderer.on('capsule:refresh', (_e, model) => cb(model)),
  onFocusTick: (cb) => ipcRenderer.on('focus:tick', (_e, payload) => cb(payload)),
  // 穿透：指针进入胶囊/面板就取消穿透，离开再打开（照抄桌宠窗的做法）
  setIgnoreMouse: (ignore) => ipcRenderer.send('capsule:setIgnoreMouse', ignore),
  // 专注
  focusGet: () => ipcRenderer.invoke('focus:get'),
  focusStart: (minutes) => ipcRenderer.invoke('focus:start', minutes),
  focusStop: () => ipcRenderer.invoke('focus:stop'),
  focusRequest: () => ipcRenderer.send('focus:request'),
  focusDefaults: () => ipcRenderer.invoke('focus:card:getDefault'),
  closeCard: () => ipcRenderer.send('focus:card:close'),
  toggleCapsule: (force) => ipcRenderer.invoke('capsule:toggle', force)
})
