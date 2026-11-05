// PawPal 外网生成配置（主进程模块，CommonJS）
//
// 职责：读写 ~/.petpet/ark.json（mode 0600），处理「环境变量 > 配置文件 > 默认值」优先级，
// 并把可公开给渲染进程的部分与密钥严格分开——apiKey 永远不离开主进程。
//
// 端点踩坑（2026-11 实测）：
//   - 标准账号用 https://ark.cn-beijing.volces.com/api/v3
//   - Plan / Coding Plan 订阅账号的密钥只在该端点有效：https://ark.cn-beijing.volces.com/api/plan/v3
//     用标准端点会返回 401「The API key or AK/SK in the request is missing or invalid」
//   - base_url 只写到 /v3 为止：SDK/请求层会自动追加 /images/generations，
//     写全会拼成 .../images/generations/images/generations → 404
//   因此 normalizeBaseUrl() 会主动剥掉误贴的尾巴。

const path = require('path')
const fs = require('fs')

const BASE_STANDARD = 'https://ark.cn-beijing.volces.com/api/v3'
const BASE_PLAN = 'https://ark.cn-beijing.volces.com/api/plan/v3'

const DEFAULTS = {
  apiKey: '',
  baseUrl: BASE_STANDARD,
  // 火山方舟的模型 ID 带日期后缀（2026-11 用 GET /api/v3/models 实测可用值）
  model: 'doubao-seedream-5-0-pro-260628',
  // 视频：默认用 fast 变体（同 2.0 家族的快速档，排队/生成耗时明显短于标准版；
  // 需要画质可切 doubao-seedance-2-5-260628，需要更省可切 2-0-mini-260615）
  videoModel: 'doubao-seedance-2-0-fast-260128',
  style: '皮克斯3D卡通风格'
}

// 面板快捷别名 → 真实模型 ID（不带日期后缀的写法在标准端点上不存在）
const MODEL_ALIASES = {
  pro: 'doubao-seedream-5-0-pro-260628',
  flash: 'doubao-seedream-5-0-flash-260915',
  // 兼容旧配置里没有日期后缀的写法
  'doubao-seedream-5-0-pro': 'doubao-seedream-5-0-pro-260628',
  'doubao-seedream-5-0-flash': 'doubao-seedream-5-0-flash-260915'
}

const STYLES = ['皮克斯3D卡通风格', '写实风格', '2D动漫风格']

// 视频模型别名单独一张表：生图与生视频是两类模型，共用一张表会让
// videoModel='flash' 被解析成生图模型（请求必然 404）。
// 已知别名走各自的表；跨类别名/ID 回到本类默认值；其余合法 ID 原样保留（手填兜底）。
const VIDEO_MODEL_ALIASES = {
  fast: 'doubao-seedance-2-0-fast-260128',
  mini: 'doubao-seedance-2-0-mini-260615',
  '2-0': 'doubao-seedance-2-0-260128',
  '2-5': 'doubao-seedance-2-5-260628'
}

const MODEL_ID_RE = /^[A-Za-z0-9._-]{3,80}$/

/** 剥掉误贴的 /images/generations 尾巴，并去掉多余斜杠 */
function normalizeBaseUrl(url) {
  const raw = String(url == null ? '' : url).trim()
  if (!raw) return DEFAULTS.baseUrl
  let u = raw.replace(/\/+$/, '')
  u = u.replace(/\/images\/generations$/i, '')
  u = u.replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(u)) return DEFAULTS.baseUrl
  return u
}

/** 模型短别名 → 真实 ID；已是完整 ID 则原样返回（允许手填兜底）。kind: 'image' | 'video' */
function resolveModel(value, kind = 'image') {
  const v = String(value == null ? '' : value).trim()
  const isVideo = kind === 'video'
  const fallback = isVideo ? DEFAULTS.videoModel : DEFAULTS.model
  if (!v) return fallback
  const table = isVideo ? VIDEO_MODEL_ALIASES : MODEL_ALIASES
  if (Object.prototype.hasOwnProperty.call(table, v)) return table[v]

  // 跨类污染兜底：生图别名填进视频字段（或反之）、以及历史版本把生图 ID 存成视频模型，
  // 都会让请求打到错误模型上（404/参数不被支持）。这类值一律回到本类默认模型。
  const otherTable = isVideo ? MODEL_ALIASES : VIDEO_MODEL_ALIASES
  if (Object.prototype.hasOwnProperty.call(otherTable, v)) return fallback
  if (isVideo && /^doubao-seedream/i.test(v)) return fallback
  if (!isVideo && /^doubao-seedance/i.test(v)) return fallback

  return MODEL_ID_RE.test(v) ? v : fallback
}

/** 端点预设（面板二选一用） */
function baseUrlPreset(kind) {
  return kind === 'plan' ? BASE_PLAN : BASE_STANDARD
}

/** 判断当前 baseUrl 属于哪一档，供界面回显 */
function baseUrlKind(url) {
  return normalizeBaseUrl(url) === BASE_PLAN ? 'plan' : 'standard'
}

// 只露头尾，中间打码；空串表示未配置
function maskKey(key) {
  const k = String(key == null ? '' : key).trim()
  if (!k) return ''
  if (k.length <= 12) return `${k.slice(0, 3)}…`
  return `${k.slice(0, 7)}…${k.slice(-4)}`
}

function readJsonTolerant(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/**
 * 读取生效配置。
 * 优先级：环境变量 > 配置文件 > 默认值
 * @param {string} file ark.json 路径
 * @param {object} [env] 注入环境变量便于测试
 */
function loadConfig(file, env = process.env) {
  const disk = readJsonTolerant(file)
  const pick = (envKey, diskKey, fallback) => {
    const e = env[envKey]
    if (typeof e === 'string' && e.trim()) return e.trim()
    const d = disk[diskKey]
    if (typeof d === 'string' && d.trim()) return d.trim()
    return fallback
  }
  const style = pick('ARK_STYLE', 'style', DEFAULTS.style)
  return {
    apiKey: pick('ARK_API_KEY', 'apiKey', DEFAULTS.apiKey),
    baseUrl: normalizeBaseUrl(pick('ARK_BASE_URL', 'baseUrl', DEFAULTS.baseUrl)),
    model: resolveModel(pick('ARK_MODEL', 'model', DEFAULTS.model)),
    videoModel: resolveModel(pick('ARK_VIDEO_MODEL', 'videoModel', DEFAULTS.videoModel), 'video'),
    style: STYLES.includes(style) ? style : DEFAULTS.style
  }
}

/**
 * 合并写回配置（只接受白名单字段），返回落盘后的生效配置。
 * 文件权限固定 0600：密钥与活动记录同规格。
 */
function saveConfig(file, patch = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const current = readJsonTolerant(file)
  const next = {
    apiKey: typeof current.apiKey === 'string' ? current.apiKey : '',
    baseUrl: typeof current.baseUrl === 'string' ? current.baseUrl : DEFAULTS.baseUrl,
    model: typeof current.model === 'string' ? current.model : DEFAULTS.model,
    videoModel: typeof current.videoModel === 'string' ? current.videoModel : DEFAULTS.videoModel,
    style: typeof current.style === 'string' ? current.style : DEFAULTS.style
  }
  if (patch && typeof patch === 'object') {
    // 空字符串 = 保持原密钥（面板上的「留空保持不变」语义），避免误清空
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim()
    if (typeof patch.baseUrl === 'string') next.baseUrl = normalizeBaseUrl(patch.baseUrl)
    if (typeof patch.model === 'string') next.model = resolveModel(patch.model)
    if (typeof patch.videoModel === 'string') next.videoModel = resolveModel(patch.videoModel, 'video')
    if (typeof patch.style === 'string' && STYLES.includes(patch.style)) next.style = patch.style
  }
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 })
  return loadConfig(file)
}

/** 可公开给渲染进程的部分：绝不含 apiKey 明文 */
function publicStatus(cfg) {
  return {
    configured: !!cfg.apiKey,
    masked: maskKey(cfg.apiKey),
    baseUrl: cfg.baseUrl,
    baseUrlKind: baseUrlKind(cfg.baseUrl),
    model: cfg.model,
    videoModel: cfg.videoModel,
    style: cfg.style,
    styles: STYLES.slice(),
    presets: { standard: BASE_STANDARD, plan: BASE_PLAN }
  }
}

module.exports = {
  BASE_STANDARD,
  BASE_PLAN,
  DEFAULTS,
  MODEL_ALIASES,
  VIDEO_MODEL_ALIASES,
  STYLES,
  normalizeBaseUrl,
  resolveModel,
  baseUrlPreset,
  baseUrlKind,
  maskKey,
  loadConfig,
  saveConfig,
  publicStatus
}
