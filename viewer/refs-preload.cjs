// PetPet 参考图库 - preload 桥接
// 最小暴露面：状态查询 + 分组 + CRUD + 缩略图读取 + 关闭；不暴露文件系统与任意 IPC。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('refsAPI', {
  // 分组相关：groupId 缺省时主进程回落到「上次选中分组」，没有则用第一个分组
  state: (groupId) => ipcRenderer.invoke('refs:state', groupId),
  activateGroup: (groupId) => ipcRenderer.invoke('refs:activate', groupId),
  createGroup: (name) => ipcRenderer.invoke('refs:create-group', name),
  saveProfile: (groupId, patch) => ipcRenderer.invoke('refs:profile', groupId, patch),

  pickFiles: (groupId) => ipcRenderer.invoke('refs:pick', groupId),
  addFiles: (items, groupId) => ipcRenderer.invoke('refs:add-buffers', items, groupId),
  setRole: (id, role, groupId) => ipcRenderer.invoke('refs:set-role', id, role, groupId),
  remove: (id, groupId) => ipcRenderer.invoke('refs:remove', id, groupId),
  thumb: (id) => ipcRenderer.invoke('refs:thumb', id),

  // AI 重绘（Seedream）：密钥只在主进程，这里只能拿到脱敏状态
  arkStatus: () => ipcRenderer.invoke('refs:ark:status'),
  arkSave: (patch) => ipcRenderer.invoke('refs:ark:save', patch),
  generate: (groupId, opts) => ipcRenderer.invoke('refs:generate', groupId, opts),
  cancelGenerate: () => ipcRenderer.invoke('refs:generate:cancel'),

  // 动画绘制（Seedance 云端视频 → 本地抽帧拼表）
  generateAnim: (groupId, opts) => ipcRenderer.invoke('anim:generate', groupId, opts),
  cancelAnim: () => ipcRenderer.invoke('anim:cancel'),
  reextractAnim: (dirName, action) => ipcRenderer.invoke('anim:reextract', dirName, action),
  onAnimProgress: (cb) => ipcRenderer.on('anim:progress', (_e, p) => cb(p)),

  // 桌宠装配与切换：分组素材 → 宠物包，并切到桌面
  assemblePet: (groupId) => ipcRenderer.invoke('pet:assemble', groupId),
  currentPet: () => ipcRenderer.invoke('pet:current'),
  activatePet: (petId) => ipcRenderer.invoke('pet:activate', petId),
  installedPets: () => ipcRenderer.invoke('pet:installed'),

  close: () => ipcRenderer.send('refs:close')
})
