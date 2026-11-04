// 专注设置卡的唯一入口：只给「开始 / 取消」两项，分钟数的最终校验在主进程（focus.cjs）
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('focusAPI', {
  start: (minutes) => ipcRenderer.invoke('focus:start', minutes),
  cancel: () => ipcRenderer.send('focus:cancel')
})
