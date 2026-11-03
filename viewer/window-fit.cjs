// 窗口落位计算（纯函数，node 直测）
//
// 背景（2026-11-03 实测）：桌宠窗的缩放逻辑用了"假设的窗口尺寸"，
// 而 resizable:false 的窗口在 Windows 上 setSize 会被忽略 → 渲染层以为窗口变了、
// 实际没变，位置一层层偏出去，最后桌宠跑到屏幕外（右键菜单也跟着出问题）。
// 现在缩放改由主进程按真实 bounds 处理，并用这里的纯函数把窗口夹回工作区。
'use strict'

/**
 * 把矩形夹进工作区：优先保持原位置，越界就平移回来；
 * 矩形比工作区还大时按工作区左上角对齐（不产生负坐标）。
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{x:number,y:number,width:number,height:number}} workArea
 */
function clampToWorkArea(rect, workArea) {
  const w = Math.max(0, Number(rect.width) || 0)
  const h = Math.max(0, Number(rect.height) || 0)
  const maxX = workArea.x + workArea.width - w
  const maxY = workArea.y + workArea.height - h
  return {
    x: Math.round(Math.min(Math.max(Number(rect.x) || 0, workArea.x), Math.max(workArea.x, maxX))),
    y: Math.round(Math.min(Math.max(Number(rect.y) || 0, workArea.y), Math.max(workArea.y, maxY))),
    width: w,
    height: h
  }
}

/** 窗口是否完整落在工作区内（用来决定要不要纠正保存的位置） */
function isInsideWorkArea(rect, workArea) {
  return (
    rect.x >= workArea.x &&
    rect.y >= workArea.y &&
    rect.x + rect.width <= workArea.x + workArea.width &&
    rect.y + rect.height <= workArea.y + workArea.height
  )
}

module.exports = { clampToWorkArea }
