// PawPal 模型参数适配层（主进程模块，CommonJS）
//
// 为什么需要这一层：火山方舟不同模型、不同生成模式支持的参数集合并不一致，
// 同一个字段在这条链路上合法、换一个模型就变成 400「参数不被支持」。已知实例：
//   - 首帧图生视频时输出比例必须跟随首帧图，显式传 ratio 会被拒
//     （官方原文：For first-frame or first-last-frame generation, the output ratio
//       follows the first-frame image）
//   - 不同生图/生视频模型对 resolution / size / output_format 的可选值不同
// 只硬编码「有图就不传 ratio」这一条，只能覆盖已经踩过的坑，换个模型又会复发。
//
// 因此本模块提供两层防护，缺一不可：
//   1) 预检（buildVideoBody / buildImageBody）：按字段白名单 + 已知能力组装请求体，
//      明显不合法的取值不发出去；每一次省略/回退都记进 notes。
//   2) 兜底（parseRejectedParam + dropParam）：调用方收到 400 后，从错误文案里解析
//      被拒字段，按可丢弃白名单逐项省略并重试——这一层对「没见过的模型」同样有效。
//
// 两条铁律：
//   - 绝不静默：省略/回退都写进 notes，由调用方落日志并回传给面板。
//   - 绝不无限重试：最多省略 MAX_PARAM_RETRIES 个字段；必填字段（model/content/image/
//     prompt/response_format）永远不进可丢弃白名单，避免把请求改成没法解析的形状。

const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', 'adaptive']
const RESOLUTIONS = ['480p', '720p', '1080p']
const IMAGE_FORMATS = ['png', 'jpeg', 'jpg', 'webp']
const IMAGE_SIZE_RE = /^(\d+[Kk]|\d{3,4}x\d{3,4})$/

const DEFAULT_DURATION = 5
const DEFAULT_RATIO = '1:1'
const DEFAULT_RESOLUTION = '720p'
const DEFAULT_IMAGE_SIZE = '2K'

const MAX_PARAM_RETRIES = 3

// 可丢弃字段 = 省略后请求依然成立、语义损失可接受的字段。
// 顺序即「泛化 400 不知道具体字段时」的尝试顺序：先拿最可能被拒的、影响最小的开刀。
const VIDEO_DROPPABLE = ['ratio', 'duration', 'resolution', 'watermark', 'seed', 'camera_fixed', 'frames']
const IMAGE_DROPPABLE = ['size', 'output_format', 'watermark', 'seed', 'guidance_scale']

// 必填字段：任何情况下都不丢（丢了请求要么无意义、要么响应解析不了）
const VIDEO_REQUIRED = ['model', 'content']
const IMAGE_REQUIRED = ['model', 'prompt', 'image', 'response_format']

const KNOWN_PARAMS = new Set([
  ...VIDEO_DROPPABLE,
  ...IMAGE_DROPPABLE,
  ...VIDEO_REQUIRED,
  ...IMAGE_REQUIRED,
  'image_url',
  'callback_url',
  'return_last_frame'
])

// 错误文案里的字段线索。顺序有讲究：output_format 要先于 size，
// 否则 "output_format 不支持" 会被 size 的泛化规则抢走。
const PARAM_KEYWORDS = [
  [/aspect[_\s]?ratio|ratio|比例/i, 'ratio'],
  [/resolution|分辨率/i, 'resolution'],
  [/duration|时长|秒数/i, 'duration'],
  [/watermark|水印/i, 'watermark'],
  [/\bseed\b|随机种子/i, 'seed'],
  [/camera[_\s]?fixed|镜头固定/i, 'camera_fixed'],
  [/output[_\s]?format|输出格式/i, 'output_format'],
  [/\bsize\b|尺寸/i, 'size'],
  [/guidance[_\s]?scale|引导系数/i, 'guidance_scale']
]

/** 视频模型能力档案（只写有依据的差异；没把握的一律交给 400 兜底） */
function videoModelProfile(model) {
  const id = String(model == null ? '' : model).trim().toLowerCase()
  const family = /seedance-1[.\-]?[05]/.test(id)
    ? 'seedance-1-x'
    : /seedance-2[.\-]?0/.test(id)
      ? 'seedance-2-0'
      : /seedance-2[.\-]?5/.test(id)
        ? 'seedance-2-5'
        : 'unknown'
  return {
    id: id || 'unknown',
    family,
    // 官方行为：首帧 / 首尾帧生成时比例跟随首帧图，显式指定 ratio 即「参数不被支持」。
    // 对所有已知 Seedance 家族成立；未知模型按同一保守规则处理——少发一个可选参数，
    // 代价只是比例跟随图片，不会 400。
    ratioWithImage: false,
    // 这两个字段只在调用方显式传入时才发；未知模型不猜它支持。
    supportsSeed: family !== 'unknown',
    supportsCameraFixed: family === 'seedance-1-x'
  }
}

function note(param, action, detail) {
  return { param, action, detail }
}

function normalizeRatio(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s) return null
  if (RATIOS.includes(s)) return s
  const lower = s.toLowerCase()
  return lower === 'adaptive' ? 'adaptive' : null
}

function normalizeResolution(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase()
  return RESOLUTIONS.includes(s) ? s : null
}

function normalizeDuration(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  // 只做物理边界钳制（1–60 秒），不猜具体模型支持哪几档——
  // 猜错会把合法值改成非法值，剩下的交给 400 兜底。
  return Math.min(60, Math.max(1, Math.round(n)))
}

function isValidImageSize(value) {
  const s = String(value == null ? '' : value).trim()
  return IMAGE_SIZE_RE.test(s)
}

/**
 * 组装视频建任务请求体。
 * @returns {{body: object, profile: object, notes: Array<{param: string, action: string, detail: string}>}}
 */
function buildVideoBody({
  model,
  prompt,
  imageDataUri,
  duration,
  ratio,
  resolution,
  watermark = true,
  seed,
  cameraFixed
} = {}) {
  const notes = []
  const profile = videoModelProfile(model)
  const content = [{ type: 'text', text: String(prompt == null ? '' : prompt) }]
  if (imageDataUri) content.push({ type: 'image_url', image_url: { url: String(imageDataUri) } })

  const body = { model: String(model == null ? '' : model).trim(), content }

  // duration：缺省给产品默认 5 秒；非法值不发（让服务端用自己的默认，而不是收到垃圾值报 400）
  if (duration == null || String(duration).trim() === '') {
    body.duration = DEFAULT_DURATION
  } else {
    const dur = normalizeDuration(duration)
    if (dur == null) notes.push(note('duration', 'drop', `取值非法（${duration}），改用服务端默认时长`))
    else body.duration = dur
  }

  // ratio：有首帧图时一律不发（官方要求比例跟随首帧图）；纯文生视频才发，非法值回退默认
  const rawRatio = ratio == null ? '' : String(ratio).trim()
  if (imageDataUri) {
    if (rawRatio) notes.push(note('ratio', 'drop', '首帧图生视频时比例跟随首帧图，显式指定会被判参数不被支持'))
  } else if (rawRatio) {
    const r = normalizeRatio(rawRatio)
    if (r) {
      body.ratio = r
    } else {
      body.ratio = DEFAULT_RATIO
      notes.push(note('ratio', 'default', `不支持的取值（${rawRatio}），回退 ${DEFAULT_RATIO}`))
    }
  } else {
    body.ratio = DEFAULT_RATIO
  }

  // resolution：缺省用 720p（桌宠素材够用）；非法值不发，交给服务端默认
  const rawRes = resolution == null ? '' : String(resolution).trim()
  if (!rawRes) {
    body.resolution = DEFAULT_RESOLUTION
  } else {
    const r = normalizeResolution(rawRes)
    if (r) body.resolution = r
    else notes.push(note('resolution', 'drop', `不支持的取值（${rawRes}），改用服务端默认分辨率`))
  }

  body.watermark = watermark !== false

  if (seed != null && String(seed).trim() !== '') {
    const n = Number(seed)
    if (!Number.isInteger(n)) notes.push(note('seed', 'drop', `取值非法（${seed}），种子必须是整数`))
    else if (!profile.supportsSeed) notes.push(note('seed', 'drop', `模型 ${profile.id} 未确认支持 seed，已省略`))
    else body.seed = n
  }

  if (cameraFixed != null) {
    if (!profile.supportsCameraFixed) notes.push(note('camera_fixed', 'drop', `模型 ${profile.id} 未确认支持 camera_fixed，已省略`))
    else body.camera_fixed = cameraFixed === true
  }

  return { body, profile, notes }
}

/**
 * 组装生图请求体。
 * response_format 是必填：解析层只认 b64_json，丢了它响应就没法用。
 * @returns {{body: object, notes: Array<{param: string, action: string, detail: string}>}}
 */
function buildImageBody({ model, prompt, imageDataUris, size, outputFormat, watermark = true } = {}) {
  const notes = []
  const images = Array.isArray(imageDataUris) ? imageDataUris.filter(Boolean) : []
  if (!images.length) throw new Error('缺少参考图：至少需要 1 张 image')

  const body = {
    model: String(model == null ? '' : model).trim(),
    prompt: String(prompt == null ? '' : prompt),
    image: images
  }

  const rawSize = size == null ? '' : String(size).trim()
  if (!rawSize) body.size = DEFAULT_IMAGE_SIZE
  else if (isValidImageSize(rawSize)) body.size = rawSize
  else notes.push(note('size', 'drop', `不支持的取值（${rawSize}），改用服务端默认尺寸`))

  const rawFmt = outputFormat == null ? '' : String(outputFormat).trim().toLowerCase()
  if (!rawFmt) body.output_format = 'png'
  else if (IMAGE_FORMATS.includes(rawFmt)) body.output_format = rawFmt
  else notes.push(note('output_format', 'drop', `不支持的取值（${outputFormat}），改用服务端默认格式`))

  body.response_format = 'b64_json'
  body.watermark = watermark !== false
  return { body, notes }
}

/**
 * 从 400/422 响应里解析「哪个参数被拒」。
 * 返回 null 表示这不是参数问题（鉴权/模型不存在/内容审核/限流等），不要走省略重试。
 * @returns {{param: string|null, generic: boolean, detail: string}|null}
 */
function parseRejectedParam(status, text) {
  if (status !== 400 && status !== 422) return null
  const raw = String(text == null ? '' : text)
  let detail = raw
  try {
    const j = JSON.parse(raw)
    const err = j && j.error
    detail = [err && err.message, err && err.code, j && j.message].filter(Boolean).join(' ') || raw
  } catch {
    /* 非 JSON：直接用原文 */
  }
  // 审核 / 模型不存在 / 套餐不支持：不是参数问题，重试只是白跑请求
  if (/审核|moderation|sensitive|policy|violat/i.test(detail)) return null
  if (/unsupportedmodel|model\s*not\s*found|does\s+not\s+exist|模型不存在|模型不可用/i.test(detail)) return null

  // 优先取反引号/引号里的字段名（官方报错形如 The parameter `ratio` is not valid）
  const quoted = detail.match(/[`'"]([A-Za-z_]{2,24})[`'"]/)
  if (quoted && KNOWN_PARAMS.has(quoted[1])) return { param: quoted[1], generic: false, detail }

  for (const [re, name] of PARAM_KEYWORDS) {
    if (re.test(detail)) return { param: name, generic: false, detail }
  }
  if (/parameter|参数|not\s+supported|unsupported|invalid|不合法|不支持/i.test(detail)) {
    return { param: null, generic: true, detail }
  }
  return null
}

/** 返回去掉某个顶层字段后的新对象；字段不存在时返回 null（表示没得删了） */
function dropParam(body, name) {
  if (!body || !name) return null
  // 必填字段永不丢：丢了请求无意义，或响应解析不了（response_format 决定响应形状）
  if (VIDEO_REQUIRED.includes(name) || IMAGE_REQUIRED.includes(name)) return null
  if (!Object.prototype.hasOwnProperty.call(body, name)) return null
  const next = { ...body }
  delete next[name]
  return next
}

/** 按优先级挑下一个可丢字段（泛化 400 不知道具体字段时用） */
function nextDropCandidate(body, order = VIDEO_DROPPABLE) {
  for (const name of order) {
    if (body && Object.prototype.hasOwnProperty.call(body, name)) return name
  }
  return null
}

/** notes → 人话，用于日志与错误提示 */
function describeNotes(notes) {
  const names = []
  for (const n of notes || []) {
    if (n && n.param && !names.includes(n.param)) names.push(n.param)
  }
  return names.join('、')
}

module.exports = {
  RATIOS,
  RESOLUTIONS,
  IMAGE_FORMATS,
  DEFAULT_DURATION,
  DEFAULT_RATIO,
  DEFAULT_RESOLUTION,
  DEFAULT_IMAGE_SIZE,
  MAX_PARAM_RETRIES,
  VIDEO_DROPPABLE,
  IMAGE_DROPPABLE,
  VIDEO_REQUIRED,
  IMAGE_REQUIRED,
  videoModelProfile,
  buildVideoBody,
  buildImageBody,
  parseRejectedParam,
  dropParam,
  nextDropCandidate,
  describeNotes,
  normalizeRatio,
  normalizeResolution,
  normalizeDuration,
  isValidImageSize
}
