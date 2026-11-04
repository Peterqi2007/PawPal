// 胶囊渲染层的唯一入口：只暴露读数据 + 鼠标穿透/窗口高度两项，不给 node 能力
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('capsule', {
  state: () => ipcRenderer.invoke('capsule:state'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('capsule:ignore-mouse', Boolean(ignore)),
  setExpanded: (expanded) => ipcRenderer.send('capsule:expanded', Boolean(expanded)),
  // B-3：胶囊上的「提前结束」交给主进程统一收尾（清 focus.json + 广播状态）
  endFocus: () => ipcRenderer.send('focus:stop'),
  onRefresh: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('capsule:refresh', handler)
    return () => ipcRenderer.removeListener('capsule:refresh', handler)
  }
})
