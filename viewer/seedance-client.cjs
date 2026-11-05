// PawPal Seedance 视频生成客户端（主进程模块，CommonJS）
//
// 依据火山方舟官方「创建视频生成任务」文档实现（任务式异步接口）：
//   POST {base}/contents/generations/tasks        ← 建任务，返回 task id
//   GET  {base}/contents/generations/tasks/{id}   ← 轮询，status 到 succeeded 后取 content.video_url
//   GET  video_url                                ← 下载 mp4
//
// 请求体（官方字段）：
//   { model, content:[{type:"text",text},{type:"image_url",image_url:{url}}],
//     duration, resolution, ratio, watermark }
//   其中 image_url.url 支持 data: URI 内联（图生视频的首帧/参考图）。
//
// 重要现实约束（2026-11 实测，写进错误提示以免后来人踩坑）：
//   Agent / Coding Plan 订阅类密钥只对套餐内模型有效。对视频模型调用会返回
//   HTTP 404 {code:"UnsupportedModel", message:"... does not support the agent plan feature"}。
//   这属于账号/套餐侧的能力，不是代码问题——标准按量付费账号或含 Seedance 的套餐才可以。

// 参数适配：不同模型支持的字段不同（最典型的是「首帧图生视频不能传 ratio」）。
// 预检与 400 兜底都收敛在 model-params.cjs，本文件只负责把结果发出去。
const {
  DEFAULT_DURATION,
  DEFAULT_RATIO,
  DEFAULT_RESOLUTION,
  MAX_PARAM_RETRIES,
  VIDEO_DROPPABLE,
  buildVideoBody,
  parseRejectedParam,
  dropParam,
  nextDropCandidate,
  describeNotes
} = require('./model-params.cjs')

const DEFAULT_MODEL = 'doubao-seedance-2-0-260128'
// 方画幅：桌宠素材最终要裁成方形格子，16:9 会逼模型把主体放大到上下出血
// （实测 1280×720 出图里猫头顶和脚底同时贴边，裁下来就是残缺剪影）
// 具体取值与「有图不传 ratio」的规则见 model-params.cjs
const POLL_INTERVAL_MS = 5000
const POLL_TIMEOUT_MS = 10 * 60 * 1000

/** 视频提示词：动词链 + 绿幕背景（配合本地 chroma 抠图，docs/02 §5.3） */
function buildVideoPrompt({ actionDesc, style, extra }) {
  const act = String(actionDesc || '自然小幅动作，呼吸起伏').trim()
  const st = String(style || '皮克斯3D卡通风格').trim()
  // 背景色与图片重绘、chroma 抠图共用 animator.BG_HEX 这一个来源
  const bg = require('./animator.cjs').BG_HEX
  // 背景必须写死：抠图靠「已知背景色」而不是靠猜，草地/地板这类纹理背景抠不干净
  // 头顶留白 + 全身入镜：否则模型常把头顶/爪子顶到画面边缘，裁下来就是残缺剪影
  // 摄像机锁死：运镜会让主体在帧间位移，拼成精灵表后播放就是「整体晃动」
  const tail =
    `主体全身完整入镜，头顶上方留出明显空白，四爪均不出画框，四周留出余白，` +
    `动作连贯成可循环的单一动作，背景为纯绿色 ${bg}，无渐变、无阴影、无杂物，` +
    `地面无投影，主体下方不出现任何影子，` +
    `摄像机完全静止，不推拉、不摇移、不俯仰、不升降`
  const more = extra ? `。${String(extra).trim()}` : ''
  return `${st}，${act}。${tail}${more}`
}

/**
 * 建任务请求（实跑与 dry-run 共用）。
 * 返回 { body, profile, notes }：body 可直接发送；notes 记录被省略/回退的字段，
 * 调用方负责落日志并提示用户——参数适配绝不能静默发生。
 */
function buildTaskRequest(opts = {}) {
  // 模型缺省时回落到默认模型（与旧 buildTaskBody 行为一致），避免发出 model 为空的请求
  return buildVideoBody({ ...opts, model: opts.model || DEFAULT_MODEL })
}

/** 只要请求体时的便捷入口（保持旧调用点兼容） */
function buildTaskBody(opts = {}) {
  return buildTaskRequest(opts).body
}

/** HTTP 状态 → 可操作的中文提示（含 Agent Plan 这一特例；notes 用于说明已省略过哪些字段） */
function mapHttpError(status, text, { notes } = {}) {
  let code = ''
  let detail = ''
  try {
    const j = JSON.parse(text)
    code = (j && j.error && j.error.code) || ''
    detail = (j && j.error && j.error.message) || ''
  } catch {
    detail = String(text || '').slice(0, 160)
  }
  if (status === 404 && /agent plan|coding plan/i.test(detail + code)) {
    return '当前密钥是 Agent/Coding Plan 专用，套餐里没有视频模型：请改用标准按量付费账号的密钥，或在方舟控制台开通 Seedance 视频模型'
  }
  if (status === 404 && /model/i.test(detail + code)) return `视频模型不可用：${detail || code || '模型 ID 无效'}`
  if (status === 401 || status === 403) {
    return '密钥无效或端点不匹配：Plan 订阅账号请把端点切到 /api/plan/v3（标准账号用 /api/v3）'
  }
  if (status === 429) return '调用过于频繁，请稍后再试'
  if (status === 400 || status === 422) {
    const dropped = describeNotes(notes)
    if (dropped) {
      return `参数不被支持：${detail || '模型拒绝了该请求'}（已自动省略 ${dropped} 后仍失败——请在设置里换一个视频模型，或调整生成参数）`
    }
    if (/ratio|分辨率|resolution|参数|parameter/i.test(detail)) {
      return `参数不被支持：${detail}（可尝试 ratio=1:1 / 16:9，resolution=720p）`
    }
  }
  if (status >= 500) return '服务端错误，请稍后再试'
  return `请求失败（HTTP ${status}）${detail ? '：' + detail : ''}`
}

/** 解析建任务响应 */
function parseTaskCreated(json) {
  if (!json || typeof json !== 'object') return { ok: false, error: '响应不是 JSON' }
  if (json.error && json.error.message) return { ok: false, error: json.error.message }
  const id = json.id || json.task_id || (json.data && (json.data.id || json.data.task_id))
  if (!id) return { ok: false, error: '响应里没有任务 ID' }
  return { ok: true, taskId: String(id), status: json.status || 'queued' }
}

/** 解析轮询响应 */
function parseTaskStatus(json) {
  if (!json || typeof json !== 'object') return { ok: false, error: '响应不是 JSON' }
  const status = String(json.status || '').toLowerCase()
  const videoUrl = (json.content && (json.content.video_url || json.content.videoUrl)) || json.video_url || null
  if (status === 'succeeded' || status === 'success') {
    if (!videoUrl) return { ok: false, error: '任务成功但没有返回视频地址' }
    return { ok: true, done: true, videoUrl, usage: json.usage || null, duration: json.duration, fps: json.framespersecond }
  }
  if (status === 'failed' || status === 'error') {
    const err = (json.error && json.error.message) || json.message || '任务失败'
    return { ok: false, error: String(err) }
  }
  return { ok: true, done: false, status: status || 'running' }
}

/**
 * 创建客户端。网络实现注入，便于单测。
 * @param {{fetchImpl: Function, now?: Function}} deps
 */
function createSeedanceClient({ fetchImpl, now } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createSeedanceClient 需要 fetchImpl')
  const clock = typeof now === 'function' ? now : () => Date.now()

  function apiBase(cfg) {
    return String((cfg && cfg.baseUrl) || '').replace(/\/+$/, '')
  }

  function headers(cfg) {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` }
  }

  /**
   * 建任务。遇到 400/422「参数不被支持」时，从错误文案解析被拒字段，
   * 按可丢弃白名单逐项省略并重试（最多 maxParamRetries 次）。
   * 返回值里的 notes / attempts 会一路带回日志与面板：模型到底不吃哪个参数，必须可追溯。
   */
  async function createTask({ cfg, body, maxParamRetries = MAX_PARAM_RETRIES } = {}) {
    if (!cfg || !cfg.apiKey) return { ok: false, error: '尚未配置 API Key', notes: [], attempts: 0 }
    const url = `${apiBase(cfg)}/contents/generations/tasks`
    let current = body || {}
    const notes = []
    for (let attempt = 0; ; attempt++) {
      let res
      let text
      try {
        res = await fetchImpl(url, { method: 'POST', headers: headers(cfg), body: JSON.stringify(current) })
        text = await res.text()
      } catch (e) {
        return { ok: false, error: `网络错误：${e && e.message ? e.message : e}`, notes, attempts: attempt + 1 }
      }
      if (res.ok) {
        let json
        try {
          json = JSON.parse(text)
        } catch {
          return { ok: false, error: '响应解析失败（非 JSON）', notes, attempts: attempt + 1 }
        }
        const parsed = parseTaskCreated(json)
        if (!parsed.ok) return { ok: false, error: parsed.error, notes, attempts: attempt + 1 }
        return { ok: true, taskId: parsed.taskId, url, notes, attempts: attempt + 1, body: current }
      }
      const rejected = parseRejectedParam(res.status, text)
      if (rejected && attempt < maxParamRetries) {
        const name = rejected.param || nextDropCandidate(current, VIDEO_DROPPABLE)
        const next = name ? dropParam(current, name) : null
        if (next) {
          notes.push({
            param: name,
            action: 'drop',
            detail: String(rejected.detail || '').slice(0, 160) || '模型拒绝该参数'
          })
          console.warn(`[PawPal][seedance] 模型拒绝参数 ${name}，已省略后重试（第 ${attempt + 2} 次请求）`)
          current = next
          continue
        }
      }
      return {
        ok: false,
        error: mapHttpError(res.status, text, { notes }),
        status: res.status,
        notes,
        attempts: attempt + 1
      }
    }
  }

  async function getTask({ cfg, taskId } = {}) {
    const url = `${apiBase(cfg)}/contents/generations/tasks/${encodeURIComponent(taskId)}`
    try {
      const res = await fetchImpl(url, { method: 'GET', headers: headers(cfg) })
      const text = await res.text()
      if (!res.ok) return { ok: false, error: mapHttpError(res.status, text), status: res.status }
      let json
      try {
        json = JSON.parse(text)
      } catch {
        return { ok: false, error: '响应解析失败（非 JSON）' }
      }
      return parseTaskStatus(json)
    } catch (e) {
      return { ok: false, error: `网络错误：${e && e.message ? e.message : e}` }
    }
  }

  async function poll({ cfg, taskId, onProgress, signal, intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS } = {}) {
    const started = clock()
    let last = ''
    while (clock() - started < timeoutMs) {
      if (signal && signal.aborted) return { ok: false, error: '已取消' }
      const r = await getTask({ cfg, taskId })
      if (!r.ok) return r
      if (r.done) return { ok: true, videoUrl: r.videoUrl, usage: r.usage, duration: r.duration, fps: r.fps }
      const st = r.status || 'running'
      if (st !== last && typeof onProgress === 'function') onProgress({ status: st, elapsedMs: clock() - started })
      last = st
      await sleep(intervalMs, signal)
    }
    return { ok: false, error: `任务超时未完成（taskId: ${taskId}，已超过 ${Math.round(timeoutMs / 60000)} 分钟；该任务可能仍在云端生成，可在火山控制台按此 id 查看）` }
  }

  /** 下载视频字节（走同一套 fetch，便于统计与超时控制） */
  async function download({ url } = {}) {
    try {
      const res = await fetchImpl(url, { method: 'GET' })
      if (!res.ok) return { ok: false, error: `下载失败（HTTP ${res.status}）` }
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) return { ok: false, error: '下载内容为空' }
      return { ok: true, buffer: buf }
    } catch (e) {
      return { ok: false, error: `下载失败：${e && e.message ? e.message : e}` }
    }
  }

  return { createTask, getTask, poll, download }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => {
        clearTimeout(t)
        resolve()
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_DURATION,
  DEFAULT_RATIO,
  DEFAULT_RESOLUTION,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  buildVideoPrompt,
  buildTaskRequest,
  buildTaskBody,
  mapHttpError,
  parseTaskCreated,
  parseTaskStatus,
  createSeedanceClient
}
