// B-2 胶囊渲染层：只画 UI，数据全部来自主进程 capsule:state（单一真源）
'use strict'

const HOVER_IN_MS = 150 // 悬停 150ms 展开
const HOVER_OUT_MS = 300 // 移出 300ms 收起
const REFRESH_MS = 2000 // 展开期间定时刷新（外面喂食/摸头能马上反映）
const CHECKIN_SHOW = 3 // 打卡点只展示前 3 次（与计分规则一致）

const el = {
  capsule: document.getElementById('capsule'),
  avatar: document.getElementById('avatar'),
  name: document.getElementById('name'),
  hint: document.getElementById('hint'),
  dot: document.getElementById('dot'),
  date: document.getElementById('date'),
  barSatiety: document.getElementById('barSatiety'),
  barMood: document.getElementById('barMood'),
  valSatiety: document.getElementById('valSatiety'),
  valMood: document.getElementById('valMood'),
  dots: document.getElementById('dots'),
  checkinText: document.getElementById('checkinText'),
  focusRow: document.getElementById('focusRow'),
  focusTime: document.getElementById('focusTime'),
  endFocus: document.getElementById('endFocus'),
  panel: document.getElementById('panel'),
  head: document.getElementById('capsule').querySelector('.head'),
  close: document.getElementById('hideCapsule')
}

let expanded = false
let ignoreMouse = true
let inTimer = 0
let outTimer = 0
let refreshTimer = 0
let shrinkTimer = 0
let focusState = null // { active, minutes, endAt }
let focusTimer = 0
let recheckTimers = []
let lastStats = null

function setIgnoreMouse(next) {
  if (next === ignoreMouse) return
  ignoreMouse = next
  if (window.capsule) window.capsule.setIgnoreMouse(next)
}

/**
 * 内容需要多高：头部 + 面板自然高度 + 边框 + body 内边距。
 * 不再让主进程猜（之前 COLLAPSED/EXPANDED_HEIGHT 是估的，估小了就把卡片下方圆角裁掉）。
 */
function desiredHeight() {
  const cs = getComputedStyle(document.body)
  const padTop = parseFloat(cs.paddingTop) || 0
  const padBottom = parseFloat(cs.paddingBottom) || 0
  const border = 2 // .capsule 上下各 1px
  if (expanded) {
    // scrollHeight 不受 max-height 动画影响（padding 也不参与过渡），展开瞬间就是终态
    const panelCs = getComputedStyle(el.panel)
    const panelBorder = parseFloat(panelCs.borderTopWidth) || 0
    const headH = el.head.getBoundingClientRect().height
    return Math.ceil(headH + el.panel.scrollHeight + panelBorder + border + padTop + padBottom)
  }
  // 收起后尺寸稳定，直接量卡片
  return Math.ceil(el.capsule.getBoundingClientRect().height + padTop + padBottom)
}

function reportHeight() {
  if (window.capsule && window.capsule.setHeight) window.capsule.setHeight(desiredHeight())
}

/**
 * 内容变化后重新量一次窗口高度。
 * 面板数据是异步拉来的（展开瞬间还是占位内容），只在 expand/collapse 时量会量短，
 * 结果就是面板底部被窗口裁掉 —— 所以每次渲染完都要再量一次。
 */
function scheduleReport() {
  requestAnimationFrame(() => reportHeight())
}

/** 展开后补量几次：首次渲染 / 字体就绪 / 图片解码都可能让内容再长一点 */
function recheckHeight() {
  reportHeight()
  for (const t of recheckTimers) clearTimeout(t)
  recheckTimers = [120, 420, 900].map((ms) => setTimeout(reportHeight, ms))
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(reportHeight).catch(() => {})
}

function expand() {
  if (expanded) return
  expanded = true
  clearTimeout(shrinkTimer)
  shrinkTimer = 0
  el.capsule.classList.add('expanded')
  recheckHeight() // 窗口按真实内容长高（唯一的高度来源，含几次补量）
  refresh() // 展开时立刻拉一次，避免看到 2 秒前的旧值
  refreshTimer = setInterval(refresh, REFRESH_MS)
}

function collapse() {
  if (!expanded) return
  expanded = false
  el.capsule.classList.remove('expanded')
  clearInterval(refreshTimer)
  refreshTimer = 0
  for (const t of recheckTimers) clearTimeout(t)
  recheckTimers = []
  setIgnoreMouse(true) // 立刻交还鼠标，别在收起动画期间挡住桌面点击
  // 收起动画 180ms 结束后再缩窗口，否则面板会被窗口裁掉
  clearTimeout(shrinkTimer)
  shrinkTimer = setTimeout(() => {
    shrinkTimer = 0
    if (expanded) return
    reportHeight() // 收起后再量一次，保证下方圆角完整
  }, 220)
}

function formatDate(now) {
  const week = '日一二三四五六'
  return `${now.getMonth() + 1}月${now.getDate()}日 周${week[now.getDay()]}`
}

// 一句人话的状态摘要：优先说最差的那项
function hintOf(stats) {
  if (!stats) return '状态读取中…'
  if (stats.satiety <= 20) return '肚子空空的'
  if (stats.mood <= 20) return '心情有点低落'
  if (stats.mood <= 40) return '想被摸摸头'
  if (stats.satiety <= 40) return '有点饿了'
  if (stats.mood >= 90 && stats.satiety >= 80) return '状态超棒'
  return '今天也很好'
}

function dotClassOf(stats) {
  if (!stats) return ''
  const worst = Math.min(stats.satiety, stats.mood)
  if (worst <= 20) return 'bad'
  if (worst <= 40) return 'warn'
  return 'ok'
}

function setAvatar(avatar) {
  if (!avatar || !avatar.url) {
    el.avatar.style.backgroundImage = 'none'
    return
  }
  // 精灵表整张按高度铺满，background-position 归零即首帧
  el.avatar.style.backgroundImage = `url("${avatar.url}")`
  el.avatar.style.backgroundSize = 'auto 100%'
  el.avatar.style.backgroundPosition = 'left center'
}

// 与 viewer/focus-time.cjs 的 formatCountdown 保持一致（渲染层是普通脚本，不能 require）
function formatCountdown(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '00:00'
  const total = Math.ceil(n / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function stopFocusTick() {
  if (focusTimer) {
    clearInterval(focusTimer)
    focusTimer = 0
  }
}

// 专注倒计时按 endAt 算（绝对时间），每秒只刷新文字，不向主进程要数据
function startFocusTick() {
  if (focusTimer) return
  focusTimer = setInterval(() => {
    if (!focusState) {
      stopFocusTick()
      return
    }
    const left = focusState.endAt - Date.now()
    if (left <= 0) {
      stopFocusTick()
      el.focusTime.textContent = '00:00'
      el.hint.textContent = 'FOCUS 00:00'
      refresh() // 主进程会清掉状态并广播，以主进程为准
      return
    }
    const text = formatCountdown(left)
    el.focusTime.textContent = text
    el.hint.textContent = 'FOCUS ' + text
  }, 1000)
}

function applyFocus(focus) {
  focusState = focus && focus.active ? focus : null
  el.focusRow.classList.toggle('show', !!focusState)
  if (!focusState) {
    stopFocusTick()
    el.focusTime.textContent = '00:00' // 复位残留值，下次专注开始不会闪一下旧时间
    el.hint.textContent = hintOf(lastStats)
    return
  }
  const left = Math.max(0, focusState.endAt - Date.now())
  const text = formatCountdown(left)
  el.focusTime.textContent = text
  el.hint.textContent = 'FOCUS ' + text
  startFocusTick()
}

function renderEmpty() {
  lastStats = null
  focusState = null
  stopFocusTick()
  el.focusRow.classList.remove('show')
  el.name.textContent = '还没有宠物'
  el.hint.textContent = '在菜单里挑一只吧'
  el.dot.className = 'dot'
  setAvatar(null)
  el.valSatiety.textContent = '—'
  el.valMood.textContent = '—'
  el.barSatiety.style.width = '0%'
  el.barMood.style.width = '0%'
  el.dots.innerHTML = ''
  el.checkinText.textContent = '还没有数据'
  scheduleReport()
}

function render(payload) {
  if (!payload || !payload.ok) {
    renderEmpty()
    return
  }

  const stats = payload.stats
  lastStats = stats
  el.name.textContent = payload.name
  el.hint.textContent = hintOf(stats)
  el.dot.className = `dot ${dotClassOf(stats)}`
  el.date.textContent = formatDate(new Date())
  setAvatar(payload.avatar)

  const satiety = stats ? Math.max(0, Math.min(100, Number(stats.satiety) || 0)) : 0
  const mood = stats ? Math.max(0, Math.min(100, Number(stats.mood) || 0)) : 0
  const checkins = stats ? Math.max(0, Number(stats.checkins) || 0) : 0

  el.valSatiety.textContent = String(satiety)
  el.valMood.textContent = String(mood)
  el.barSatiety.style.width = `${satiety}%`
  el.barMood.style.width = `${mood}%`

  el.dots.innerHTML = ''
  for (let i = 0; i < CHECKIN_SHOW; i++) {
    const dot = document.createElement('i')
    if (i < checkins) dot.className = 'done'
    el.dots.appendChild(dot)
  }
  el.checkinText.textContent = checkins > 0 ? `今天已打卡 ${checkins} 次` : '还没打卡'
  // 专注态覆盖头部摘要（FOCUS 24:59），并露出面板里的「提前结束」
  applyFocus(payload.focus)
  scheduleReport()
}

async function refresh() {
  if (!window.capsule) return
  try {
    render(await window.capsule.state())
  } catch (e) {
    console.error('[capsule] 读取状态失败', e)
  }
}

// 提前结束：主进程统一收尾（清 focus.json + 广播），胶囊下次刷新就回常规态
// 拖动：按住头部（✕ 除外）移动整个胶囊
let dragging = false
let dragMoved = 0
let accX = 0
let accY = 0

el.head.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  if (e.target && e.target.closest && e.target.closest('button')) return // ✕ 不触发拖动
  dragging = true
  dragMoved = 0
  accX = 0
  accY = 0
  try { el.head.setPointerCapture(e.pointerId) } catch { /* 忽略 */ }
  e.preventDefault()
})

window.addEventListener('pointermove', (e) => {
  if (!dragging) return
  accX += e.movementX || 0
  accY += e.movementY || 0
  // 位移量先攒够 1px 再发，避免每帧都发一次 IPC
  const dx = Math.trunc(accX)
  const dy = Math.trunc(accY)
  if (!dx && !dy) return
  accX -= dx
  accY -= dy
  dragMoved += Math.abs(dx) + Math.abs(dy)
  if (window.capsule && window.capsule.moveBy) window.capsule.moveBy(dx, dy)
})

function endDrag(e) {
  if (!dragging) return
  dragging = false
  if (window.capsule && window.capsule.dragEnd) window.capsule.dragEnd()
  // 松手时指针可能已经移到卡片外：补一次收起，避免面板一直挂着
  const x = e && typeof e.clientX === 'number' ? e.clientX : null
  const y = e && typeof e.clientY === 'number' ? e.clientY : null
  const r = el.capsule.getBoundingClientRect()
  const outside = x === null || x < r.left || x > r.right || y < r.top || y > r.bottom
  if (outside) {
    clearTimeout(outTimer)
    outTimer = setTimeout(() => { if (!dragging) collapse() }, 120)
  }
}
window.addEventListener('pointerup', endDrag)
window.addEventListener('pointercancel', endDrag)

// 收起按钮：隐藏胶囊（托盘菜单可恢复）
el.close.addEventListener('click', (e) => {
  e.stopPropagation()
  if (window.capsule && window.capsule.hide) window.capsule.hide()
})

el.endFocus.addEventListener('click', () => {
  if (window.capsule) window.capsule.endFocus()
})

window.addEventListener('load', reportHeight)
window.addEventListener('resize', () => { if (!expanded) reportHeight() })

// 悬停：进入 150ms 展开并接管鼠标；移出 300ms 收起并恢复穿透
el.capsule.addEventListener('mouseenter', () => {
  clearTimeout(outTimer)
  outTimer = 0
  setIgnoreMouse(false)
  if (!inTimer) inTimer = setTimeout(() => { inTimer = 0; expand() }, HOVER_IN_MS)
})

el.capsule.addEventListener('mouseleave', () => {
  if (dragging) return // 拖动中指针可能短暂离开卡片，先不收起
  clearTimeout(inTimer)
  inTimer = 0
  if (!outTimer) outTimer = setTimeout(() => {
    outTimer = 0
    // 悬停不足 150ms 就离开时还没展开，但鼠标已被接管，这里要交还
    if (expanded) collapse()
    else setIgnoreMouse(true)
  }, HOVER_OUT_MS)
})

// 主进程主动推刷新（切宠物等）
if (window.capsule && window.capsule.onRefresh) {
  window.capsule.onRefresh(refresh)
}

refresh()
