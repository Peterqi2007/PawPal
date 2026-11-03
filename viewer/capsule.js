// 状态胶囊渲染（只负责画，不在渲染层算数值——数值由主进程 capsule:get 给）
'use strict'

const $ = (id) => document.getElementById(id)
const capsule = $('capsule')
const panel = $('panel')
const bar = $('bar')

let model = null
let expanded = false
let expandTimer = null
let collapseTimer = null
let ignoring = true // 起始整窗穿透

// 收起态只保留顶部 48+12 的可交互区；展开态算上整个面板
const BAR_H = 60
let panelH = 0

function interactiveRects() {
  const rects = [{ x: 0, y: 0, w: window.innerWidth, h: BAR_H }]
  if (expanded && panelH > 0) {
    const r = panel.getBoundingClientRect()
    rects.push({ x: r.x, y: r.y, w: r.width, h: r.height })
  }
  return rects
}

function hitInteractive(x, y) {
  return interactiveRects().some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
}

/** 指针进/出胶囊区时开关穿透：透明区域必须能点到下层应用 */
function setIgnore(next) {
  if (next === ignoring) return
  ignoring = next
  window.capsuleAPI.setIgnoreMouse(next)
}

function render() {
  if (!model) return
  $('pet-name').textContent = model.name
  $('pet-sub').textContent = model.focusing
    ? model.focusText
    : model.hasStats
      ? `心情 ${model.moodText} · 饱腹 ${model.satietyText}`
      : model.emptyHint

  const dot = $('status-dot')
  dot.className = `dot ${model.statusDot}`

  $('panel-date').textContent = model.dateLabel
  $('mood-fill').style.width = `${model.mood}%`
  $('satiety-fill').style.width = `${model.satiety}%`
  $('mood-value').textContent = model.moodText
  $('satiety-value').textContent = model.satietyText

  $('checkin-value').textContent = model.checkinText
  const dots = $('checkin-dots').children
  for (let i = 0; i < dots.length; i++) {
    dots[i].className = model.checkinDots[i] ? 'on' : ''
  }

  $('focus-block').classList.toggle('hidden', !model.focusing)
  if (model.focusing) {
    $('focus-text').textContent = model.focusText
    $('focus-fill').style.width = `${Math.round(model.focusProgress * 100)}%`
    $('focus-start').textContent = '↻ 调整专注时长'
  } else {
    $('focus-start').textContent = '🕐 开始专注'
  }
}

function expand() {
  clearTimeout(collapseTimer)
  clearTimeout(expandTimer)
  if (expanded) return
  expandTimer = setTimeout(() => {
    expanded = true
    capsule.classList.add('expanded')
    panelH = panel.getBoundingClientRect().height
    setIgnore(false) // 展开时一定可交互
  }, 150)
}

function collapse() {
  clearTimeout(expandTimer)
  clearTimeout(collapseTimer)
  if (!expanded) return
  collapseTimer = setTimeout(() => {
    expanded = false
    capsule.classList.remove('expanded')
    setIgnore(true) // 收起后恢复穿透
  }, 300)
}

// ---------- 事件 ----------
window.addEventListener('mousemove', (e) => {
  const inside = hitInteractive(e.clientX, e.clientY)
  setIgnore(!inside)
  if (inside) expand()
  else collapse()
})

document.addEventListener('mouseleave', () => collapse())

bar.addEventListener('click', (e) => {
  // 点状态条 = 手动开/关面板（触控板用户不爱悬停）
  if (e.target.closest('button')) return
  if (expanded) collapse()
  else {
    expanded = true
    capsule.classList.add('expanded')
    panelH = panel.getBoundingClientRect().height
    setIgnore(false)
  }
})

$('focus-start').addEventListener('click', () => window.capsuleAPI.focusRequest())
$('focus-stop').addEventListener('click', () => window.capsuleAPI.focusStop())

window.capsuleAPI.onRefresh((next) => {
  model = next
  render()
})

window.capsuleAPI.onFocusTick((payload) => {
  if (!model) return
  model.focusing = !!payload.focusing
  model.focusText = payload.focusing ? `FOCUS ${payload.text}` : ''
  model.statusDot = payload.focusing ? 'focus' : model.checkinDots.every(Boolean) ? 'idle' : 'pending'
  if (payload.focusing && payload.minutes) {
    const total = payload.minutes * 60000
    model.focusProgress = 1 - Math.max(0, payload.remainMs) / total
  }
  render()
})

// 首次加载：主动拉一次（不依赖主进程的 ready-to-show 时序）
window.capsuleAPI.get().then((m) => {
  model = m
  render()
  setIgnore(true)
})

// 面板展开后高度可能变（专注块出现/消失），重算一次
window.addEventListener('resize', () => { panelH = panel.getBoundingClientRect().height })
