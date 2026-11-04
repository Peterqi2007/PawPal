// B-3 专注设置卡渲染层：只管输入体验，分钟数的最终校验在主进程 focus.cjs（这里同步一份只为即时反馈）
'use strict'

const MIN_MINUTES = 1
const MAX_MINUTES = 180

const el = {
  input: document.getElementById('minutes'),
  hint: document.getElementById('hint'),
  start: document.getElementById('start'),
  cancel: document.getElementById('cancel'),
  presets: Array.from(document.querySelectorAll('#presets button'))
}

function readMinutes() {
  const s = el.input.value.trim()
  if (!/^\d{1,3}$/.test(s)) return null
  const n = Number(s)
  return n >= MIN_MINUTES && n <= MAX_MINUTES ? n : null
}

function sync() {
  const minutes = readMinutes()
  const ok = minutes !== null
  el.input.classList.toggle('bad', !ok)
  el.start.disabled = !ok
  el.hint.classList.toggle('bad', !ok)
  el.hint.textContent = ok ? '专注期间桌宠会安静下来，到点会提醒你休息' : '请输入 1–180 的整数分钟'
  for (const btn of el.presets) {
    btn.classList.toggle('on', ok && Number(btn.dataset.min) === minutes)
  }
}

async function submit() {
  const minutes = readMinutes()
  if (minutes === null) {
    el.input.focus()
    return
  }
  el.hint.classList.remove('bad')
  el.hint.textContent = '开始中…'
  el.start.disabled = true
  try {
    const r = await window.focusAPI.start(minutes)
    // 成功时主进程会关掉本窗口；失败（理论上被主进程拦下）把错误显示出来
    if (!r || !r.ok) {
      el.hint.classList.add('bad')
      el.hint.textContent = '开始失败，请检查分钟数后重试'
    }
  } catch (e) {
    console.error('[focus] 开始专注失败', e)
    el.hint.classList.add('bad')
    el.hint.textContent = '开始失败，请重试'
  }
  sync()
}

el.input.addEventListener('input', sync)
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    submit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    window.focusAPI.cancel()
  }
})

for (const btn of el.presets) {
  btn.addEventListener('click', () => {
    el.input.value = btn.dataset.min || ''
    sync()
    el.input.focus()
  })
}

el.start.addEventListener('click', submit)
el.cancel.addEventListener('click', () => window.focusAPI.cancel())

el.input.focus()
el.input.select()
sync()
