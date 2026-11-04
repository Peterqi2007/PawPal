// 使用说明窗口：只负责关闭（内容纯静态，不给任何 node 能力）
'use strict'
document.getElementById('close').addEventListener('click', () => {
  if (window.guideAPI) window.guideAPI.close()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && window.guideAPI) window.guideAPI.close()
})
