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
  checkinText: document.getElementById('checkinText')
}

let expanded = false
let ignoreMouse = true
let inTimer = 0
let outTimer = 0
let refreshTimer = 0
let shrinkTimer = 0

function setIgnoreMouse(next) {
  if (next === ignoreMouse) return
  ignoreMouse = next
  if (window.capsule) window.capsule.setIgnoreMouse(next)
}

function expand() {
  if (expanded) return
  expanded = true
  clearTimeout(shrinkTimer)
  shrinkTimer = 0
  el.capsule.classList.add('expanded')
  if (window.capsule) window.capsule.setExpanded(true) // 窗口长高，完整露出面板
  refresh() // 展开时立刻拉一次，避免看到 2 秒前的旧值
  refreshTimer = setInterval(refresh, REFRESH_MS)
}

function collapse() {
  if (!expanded) return
  expanded = false
  el.capsule.classList.remove('expanded')
  clearInterval(refreshTimer)
  refreshTimer = 0
  setIgnoreMouse(true) // 立刻交还鼠标，别在收起动画期间挡住桌面点击
  // 收起动画 180ms 结束后再缩窗口，否则面板会被窗口裁掉
  clearTimeout(shrinkTimer)
  shrinkTimer = setTimeout(() => {
    shrinkTimer = 0
    if (!expanded && window.capsule) window.capsule.setExpanded(false)
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

function renderEmpty() {
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
}

function render(payload) {
  if (!payload || !payload.ok) {
    renderEmpty()
    return
  }

  const stats = payload.stats
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
}

async function refresh() {
  if (!window.capsule) return
  try {
    render(await window.capsule.state())
  } catch (e) {
    console.error('[capsule] 读取状态失败', e)
  }
}

// 悬停：进入 150ms 展开并接管鼠标；移出 300ms 收起并恢复穿透
el.capsule.addEventListener('mouseenter', () => {
  clearTimeout(outTimer)
  outTimer = 0
  setIgnoreMouse(false)
  if (!inTimer) inTimer = setTimeout(() => { inTimer = 0; expand() }, HOVER_IN_MS)
})

el.capsule.addEventListener('mouseleave', () => {
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
