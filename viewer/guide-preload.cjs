// PawPal 使用说明 - preload 桥接（最小暴露面：只能关窗）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('guideAPI', {
  close: () => ipcRenderer.send('guide:close')
})
