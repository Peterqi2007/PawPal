// PawPal Seedream 生图客户端（主进程模块，CommonJS）
//
// 职责：把「参考图库里的一个分组」翻译成一次火山方舟图片生成请求，并解析回图。
// 网络实现由调用方注入（生产用 Electron 主进程 net.fetch，测试注入假实现），
// 因此本模块不依赖 electron，可被 vitest 直接单测。
//
// 请求要点（2026-11 实测）：
//   POST {baseUrl}/images/generations
//   Authorization: Bearer <apiKey>
//   body: model / prompt / image[] / size / output_format / response_format=b64_json / watermark
//   - image 支持单张字符串或数组，也支持 data: URI 内联（实测 usage.input_images=1 确认被采纳）
//   - response_format=b64_json 免二次下载，也不产生 24 小时失效的临时 URL
//
// 就绪闸门（产品规则）：分组内必须有设定图，且姿势参考图 ≥ MIN_POSE，否则不发请求。

const path = require('path')
const { DEFAULTS } = require('./ark-config.cjs')

const MIN_POSE = 3 // 少于 3 张姿势参考图：提示用户补图，不发请求
const MAX_POSES = 3 // 实际送去生成的姿势参考图上限
const MAX_REFS = 1 + MAX_POSES // 设定图 1 张 + 姿势参考图最多 3 张
const MAX_EDGE = 1536 // 上传前长边降采样上限
const MAX_BODY_BYTES = 24 * 1024 * 1024 // base64 总量保险丝（正常远低于此）
const DEFAULT_TIMEOUT_MS = 180000

/** 就绪判定：返回 { ready, reason }，reason 为空串表示可以生成 */
function evaluateReadiness({ setupCount = 0, poseCount = 0 } = {}) {
  if (!setupCount) {
    return { ready: false, reason: '当前分组还没有设定图，请先导入照片并把其中一张设为设定图' }
  }
  if (poseCount < MIN_POSE) {
    return { ready: false, reason: `还差 ${MIN_POSE - poseCount} 张姿势参考图（至少 ${MIN_POSE} 张），重绘会更稳` }
  }
  return { ready: true, reason: '' }
}

/** 组装提示词（遵守铁律 1：只写要什么，不写不要什么） */
/**
 * 图片重绘提示词。
 * 背景必须与视频/抠图用同一个颜色常量（animator.BG_HEX），
 * 否则重绘出浅灰底 → 首帧定死场景 → 后面的绿幕抠图完全失效（实测踩过）。
 */
function buildPrompt({ style, petName } = {}) {
  const s = String(style || DEFAULTS.style).trim()
  const name = String(petName || '').trim() || '这只宠物'
  const bg = require('./animator.cjs').BG_HEX
  return `${s}。保持${name}的毛色与花纹不变，全身正面站立，纯绿色 ${bg} 背景，无渐变无阴影，柔和影棚光，全身完整入镜（含尾巴），画面稳定`
}

/** 取参与生成的参考图：1 张设定图 + 最多 3 张姿势参考（顺序稳定） */
function pickReferences(items = []) {
  const setup = items.find((it) => it && it.role === 'setup')
  const poses = items.filter((it) => it && it.role === 'pose').slice(0, MAX_POSES)
  return setup ? [setup, ...poses] : poses
}

/** 请求体（实跑与 dry-run 共用，单一事实源） */
function buildRequestBody({ model, prompt, imageDataUris, size = '2K' }) {
  const body = {
    model,
    prompt,
    image: imageDataUris.slice(0, MAX_REFS),
    size,
    output_format: 'png',
    // 用 b64 而不是 url：省一次下载，也避免把 24h 临时链接写进日志
    response_format: 'b64_json',
    // 与 README / docs02 的「保留平台 AI 标识」一致
    watermark: true
  }
  const bytes = Buffer.byteLength(JSON.stringify(body))
  if (bytes > MAX_BODY_BYTES) {
    throw new Error(`请求体 ${Math.round(bytes / 1024 / 1024)}MB 超过上限，请减少参考图`)
  }
  return body
}

/** 解析响应：成功返回 Buffer，失败返回可读错误 */
function parseResponse(json) {
  if (!json || typeof json !== 'object') return { ok: false, error: '响应不是 JSON 对象' }
  if (json.error && json.error.message) return { ok: false, error: String(json.error.message) }
  const item = Array.isArray(json.data) ? json.data[0] : null
  if (!item) return { ok: false, error: '响应里没有图片数据' }
  if (item.error && item.error.message) return { ok: false, error: String(item.error.message) }
  if (!item.b64_json) return { ok: false, error: '响应缺少 b64_json（response_format 是否被忽略？）' }
  let buf
  try {
    buf = Buffer.from(item.b64_json, 'base64')
  } catch {
    return { ok: false, error: 'base64 解码失败' }
  }
  if (!buf.length) return { ok: false, error: '解码后的图片为空' }
  return { ok: true, buffer: buf, usage: json.usage || null, size: item.size || null }
}

/** HTTP 状态码 → 可操作的中文提示 */
function mapHttpError(status, text) {
  let detail = ''
  try {
    const j = JSON.parse(text)
    detail = (j && j.error && j.error.message) || ''
  } catch {
    detail = String(text || '').slice(0, 160)
  }
  const tail = detail ? `（${detail}）` : ''
  if (status === 401 || status === 403) {
    return '密钥无效或端点不匹配：Plan 订阅账号请在设置里把端点切到 /api/plan/v3' + tail
  }
  if (status === 404) return '模型或端点不存在：请检查模型 ID 与端点' + tail
  if (status === 429) return '调用过于频繁，请稍后再试' + tail
  if (status >= 500) return '服务端错误，请稍后再试' + tail
  if (status === 400) return '请求被拒绝：' + (detail || '参数不合法')
  return `请求失败（HTTP ${status}）${tail}`
}

/**
 * 创建客户端。
 * @param {object} deps
 * @param {Function} deps.fetchImpl fetch(url, init) → Response 兼容对象
 * @param {Function} deps.encodeImage 绝对路径 → data URI 或 null（生产实现做降采样）
 * @param {Function} [deps.readFile] 自定义读文件（测试可注入）
 */
function createSeedreamClient({ fetchImpl, encodeImage, readFile } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createSeedreamClient 需要 fetchImpl')
  if (typeof encodeImage !== 'function') throw new Error('createSeedreamClient 需要 encodeImage')

  /**
   * @param {object} opts
   * @param {object} opts.cfg 生效配置 { apiKey, baseUrl, model, style }
   * @param {string} opts.petName 显示名（写进提示词）
   * @param {object[]} opts.items 当前分组条目
   * @param {string} opts.imagesDir 图片目录绝对路径
   * @param {string} [opts.size]
   * @param {number} [opts.timeoutMs]
   * @param {AbortSignal} [opts.signal]
   * @param {boolean} [opts.dryRun] 只返回请求体，不发网络
   */
  async function generate(
    { cfg, petName, items, imagesDir, size = '2K', timeoutMs = DEFAULT_TIMEOUT_MS, signal, dryRun = false } = {}
  ) {
    if (!cfg || !cfg.apiKey) return { ok: false, error: '尚未配置 API Key' }
    if (typeof fetchImpl !== 'function') return { ok: false, error: '网络实现未就绪' }

    const stats = { setupCount: 0, poseCount: 0 }
    for (const it of items || []) {
      if (it.role === 'setup') stats.setupCount++
      else if (it.role === 'pose') stats.poseCount++
    }
    const ready = evaluateReadiness(stats)
    if (!ready.ready) return { ok: false, error: ready.reason, blocked: true }

    const refs = pickReferences(items)
    const dataUris = []
    for (const item of refs) {
      const abs = path.join(imagesDir, item.file)
      let uri = null
      try {
        uri = encodeImage(abs, readFile)
      } catch {
        uri = null
      }
      if (uri) dataUris.push(uri)
    }
    if (!dataUris.length) return { ok: false, error: '参考图读取失败（可能是文件已被删除）' }

    const prompt = buildPrompt({ style: cfg.style, petName })
    let body
    try {
      body = buildRequestBody({ model: cfg.model, prompt, imageDataUris: dataUris, size })
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) }
    }

    const url = `${String(cfg.baseUrl).replace(/\/+$/, '')}/images/generations`
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        requestBody: body,
        meta: { url, refCount: dataUris.length, refs: refs.map((r) => ({ role: r.role, file: r.file })) }
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      const text = await res.text()
      if (!res.ok) {
        return { ok: false, error: mapHttpError(res.status, text), status: res.status }
      }
      let json
      try {
        json = JSON.parse(text)
      } catch {
        return { ok: false, error: '响应解析失败（非 JSON）' }
      }
      const parsed = parseResponse(json)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      return {
        ok: true,
        buffer: parsed.buffer,
        usage: parsed.usage,
        imageSize: parsed.size,
        meta: { url, refCount: dataUris.length, model: cfg.model, prompt }
      }
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || controller.signal.aborted)
      return { ok: false, error: aborted ? '请求超时或已取消' : `网络错误：${e && e.message ? e.message : e}` }
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  return { generate }
}

module.exports = {
  MIN_POSE,
  MAX_POSES,
  MAX_REFS,
  MAX_EDGE,
  DEFAULT_TIMEOUT_MS,
  evaluateReadiness,
  buildPrompt,
  pickReferences,
  buildRequestBody,
  parseResponse,
  mapHttpError,
  createSeedreamClient
}
