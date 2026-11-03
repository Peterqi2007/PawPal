// 专注设置卡：1–180 分钟的整数校验 + 预设 + 开始/取消
// 校验规则与主进程共用同一份口径（focus-session.cjs），这里只做一次轻量镜像，
// 真正的拦截仍在主进程 focus:start（渲染层校验只为即时反馈，不作为安全边界）。
'use strict'

const MIN = 1
const MAX = 180

const $ = (id) => document.getElementById(id)
const input = $('minutes')
const startBtn = $('start')
const error = $('error')
const hint = $('hint')

/** @returns {{ok:true, minutes:number}|{ok:false, error:string}} */
function parseMinutes(raw) {
  const text = String(raw == null ? '' : raw).trim().replace(/\s*(分钟|分|min)$/i, '')
  if (text === '') return { ok: false, error: '请填一个分钟数（1–180）' }
  if (!/^\d+$/.test(text)) return { ok: false, error: '只能填整数分钟（1–180）' }
  const n = Number(text)
  if (n < MIN) return { ok: false, error: `至少 ${MIN} 分钟` }
  if (n > MAX) return { ok: false, error: `最多 ${MAX} 分钟` }
  return { ok: true, minutes: n }
}

function validate() {
  const r = parseMinutes(input.value)
  const bad = !r.ok
  error.textContent = bad ? r.error : ''
  startBtn.disabled = bad
  // 预设高亮
  for (const btn of $('presets').querySelectorAll('button')) {
    btn.classList.toggle('active', Number(btn.dataset.min) === r.minutes)
  }
  return r
}

function start() {
  const r = validate()
  if (!r.ok) return
  startBtn.disabled = true
  window.capsuleAPI.focusStart(r.minutes).then((res) => {
    if (!res || !res.ok) {
      error.textContent = (res && res.error) || '开始失败，请重试'
      startBtn.disabled = false
    }
    // 成功时主进程会关掉本窗
  })
}

input.addEventListener('input', () => {
  // 只留数字，避免粘贴出乱码
  const cleaned = input.value.replace(/[^\d]/g, '').slice(0, 3)
  if (cleaned !== input.value) input.value = cleaned
  validate()
})
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') start()
  if (e.key === 'Escape') window.capsuleAPI.closeCard()
})

$('presets').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-min]')
  if (!btn) return
  input.value = btn.dataset.min
  validate()
  input.focus()
})

startBtn.addEventListener('click', start)
$('cancel').addEventListener('click', () => window.capsuleAPI.closeCard())
$('close').addEventListener('click', () => window.capsuleAPI.closeCard())

// 打开时：如果有正在进行的专注，提示剩余时间并允许直接结束
window.capsuleAPI.focusDefaults().then((cfg) => {
  if (cfg && cfg.minutes) input.value = String(cfg.minutes)
  validate()
  input.select()
})
window.capsuleAPI.focusGet().then((cur) => {
  if (cur && cur.focusing) {
    hint.textContent = `正在专注：还剩 ${cur.text}。重新开始会覆盖当前计时。`
  }
})

validate()
input.focus()
