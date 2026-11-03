// PetPet 动画绘制（主进程 + 隐藏渲染窗口共用，UMD）
//
// 把一段动作视频变成桌宠能播的「横向精灵表」，纯本地、零依赖（不需要 ffmpeg / Python / rembg）。
//
// 为什么不用 rembg：那是 Python 侧的语义分割。客户端里没有 ML 推理，
// 改用「边缘连通域抠图」（edge flood）：从画面四边向内扩散，只清除与边缘连通、且颜色接近
// 边缘背景色的区域——**画面内部的白色（白胸脯/白腿）不与边缘连通，因此不会被误删**，
// 这正好绕开了 docs/07 里「色度抠图吃掉白毛」的老坑。
//
// 与管线的一致性（pipeline/make_sheet.py）：
//   - 每帧按 alpha bbox 裁剪 → 统一画布居中 → 横排拼接
//   - 总宽 = cell × 帧数 ≤ 16384px（WebGL 纹理硬上限，超过就黑屏）
//
// UMD：主进程 require()，隐藏窗口用 <script src> 直接加载，算法只有一份。

;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = api
  else root.PetPetAnimator = api
})(typeof self !== 'undefined' ? self : this, function () {

const MAX_SHEET_WIDTH = 16384
const DEFAULT_CELL = 512
const DEFAULT_FRAMES = 12
const DEFAULT_FPS = 5
const MIN_FRAMES = 4
const MAX_FRAMES = 24
const DEFAULT_PADDING = 0.06 // 与 make_sheet.py 的 pad_ratio 保持一致

/** 帧数与 cell 组合是否满足纹理上限 */
function validateSheet(frames, cell) {
  const n = Number(frames)
  const c = Number(cell)
  if (!Number.isFinite(n) || n < MIN_FRAMES || n > MAX_FRAMES) {
    return { ok: false, error: `帧数需在 ${MIN_FRAMES}-${MAX_FRAMES} 之间` }
  }
  if (!Number.isFinite(c) || c < 128 || c > 1024) {
    return { ok: false, error: '单帧尺寸需在 128-1024 之间' }
  }
  if (n * c > MAX_SHEET_WIDTH) {
    return { ok: false, error: `总宽 ${n * c}px 超过 WebGL 上限 ${MAX_SHEET_WIDTH}px（减帧或缩小 cell）` }
  }
  return { ok: true }
}

/**
 * 边缘连通域抠图：把与画面边缘连通、且颜色接近边缘背景色的像素设为透明。
 * @param {Uint8ClampedArray} data RGBA 像素（原地修改）
 * @param {number} width
 * @param {number} height
 * @param {{tolerance?: number, feather?: number}} opts
 *   tolerance: 颜色距离阈值（0-255 的欧氏距离比例，默认 42）
 *   feather: 边缘羽化半径（像素，默认 0 = 硬边）
 * @returns {{removed: number, bg: [number, number, number]}}
 */
function edgeFloodAlpha(data, width, height, opts = {}) {
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : 42
  const w = width
  const h = height
  const total = w * h

  // 1. 采样四边像素，取中位数当作背景色（比均值抗前景干扰）
  const samples = { r: [], g: [], b: [] }
  const push = (x, y) => {
    const i = (y * w + x) * 4
    samples.r.push(data[i])
    samples.g.push(data[i + 1])
    samples.b.push(data[i + 2])
  }
  for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 32))) {
    push(x, 0)
    push(x, h - 1)
  }
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 32))) {
    push(0, y)
    push(w - 1, y)
  }
  const median = (arr) => {
    const a = arr.slice().sort((p, q) => p - q)
    return a[Math.floor(a.length / 2)] || 0
  }
  const bg = [median(samples.r), median(samples.g), median(samples.b)]

  // 2. 颜色距离（含亮度与色度差，避免「接近白/接近灰」一刀切）
  const dist = (i) => {
    const dr = data[i] - bg[0]
    const dg = data[i + 1] - bg[1]
    const db = data[i + 2] - bg[2]
    return Math.sqrt(dr * dr + dg * dg + db * db) / 255
  }
  const limit = tolerance / 255

  // 3. 从四边 BFS，只清除与边缘连通的近背景像素
  const visited = new Uint8Array(total)
  const queue = new Int32Array(total)
  let head = 0
  let tail = 0
  const seed = (x, y) => {
    const idx = y * w + x
    if (visited[idx]) return
    visited[idx] = 1
    if (dist(idx * 4) <= limit) queue[tail++] = idx
    else return
    // 未入队的边界像素不再扩散（前景挡住扩散）
  }
  for (let x = 0; x < w; x++) {
    seed(x, 0)
    seed(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    seed(0, y)
    seed(w - 1, y)
  }

  let removed = 0
  while (head < tail) {
    const idx = queue[head++]
    data[idx * 4 + 3] = 0
    removed++
    const x = idx % w
    const y = (idx - x) / w
    const tryNeighbor = (nx, ny) => {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return
      const nIdx = ny * w + nx
      if (visited[nIdx]) return
      visited[nIdx] = 1
      if (dist(nIdx * 4) <= limit) queue[tail++] = nIdx
    }
    tryNeighbor(x - 1, y)
    tryNeighbor(x + 1, y)
    tryNeighbor(x, y - 1)
    tryNeighbor(x, y + 1)
  }

  // 4. 羽化：对仍有颜色、但邻接透明像素的边界做半透明过渡（去硬边锯齿）
  const feather = Number.isFinite(opts.feather) ? opts.feather : 0
  if (feather > 0 && removed > 0) {
    softEdges(data, w, h, Math.round(feather))
  }
  return { removed, bg }
}

// 绿幕基准色：#00C800（与提示词里写死的背景色一致，docs/02 §5.3）
const CHROMA_KEY = [0, 200, 0]
// 同一颜色的十六进制写法：图片/视频提示词与 chroma 共用这一个来源，避免各处写歪
const BG_HEX = '#' + CHROMA_KEY.map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('')

/** 沿画面四边取中位色 + 距离分位数（chroma 自动键色用） */
function borderColorStats(data, width, height) {
  const rs = []
  const gs = []
  const bs = []
  const push = (x, y) => {
    const i = (y * width + x) * 4
    rs.push(data[i])
    gs.push(data[i + 1])
    bs.push(data[i + 2])
  }
  const stepX = Math.max(1, Math.floor(width / 64))
  const stepY = Math.max(1, Math.floor(height / 64))
  for (let x = 0; x < width; x += stepX) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y += stepY) {
    push(0, y)
    push(width - 1, y)
  }
  const median = (arr) => {
    const a = arr.slice().sort((p, q) => p - q)
    return a[Math.floor(a.length / 2)] || 0
  }
  const key = [median(rs), median(gs), median(bs)]
  const dists = rs.map((r, i) => {
    const dr = r - key[0]
    const dg = gs[i] - key[1]
    const db = bs[i] - key[2]
    return Math.sqrt(dr * dr + dg * dg + db * db)
  })
  dists.sort((p, q) => p - q)
  const p75 = dists[Math.floor(dists.length * 0.75)] || 0
  const p95 = dists[Math.floor(dists.length * 0.95)] || 0
  return { key, p75, p95, count: rs.length }
}

/**
 * 绿幕抠图。
 *
 * 判定核心不是 RGB 距离，而是**绿色主导度** dominance = (G - max(R,B))/255：
 * 绿色背景无论多亮多暗，G 都压过 R/B；而橘猫、棕毛、白头发的 dominance 是负的。
 * 这样对明暗渐变/暗角天然免疫——用 RGB 距离 + 宽容差会把深棕毛一起吃掉（实测踩过）。
 *
 * @param {{keyColor?: number[], autoKey?: boolean, tolerance?: number, minGreen?: number, feather?: number}} opts
 *   不传 keyColor 时从四边自动拾取键色与主导度基准。
 */
function chromaKeyAlpha(data, width, height, opts = {}) {
  const explicitKey = Array.isArray(opts.keyColor) && opts.keyColor.length === 3
  const stats = borderColorStats(data, width, height)
  const key = explicitKey ? opts.keyColor : stats.key

  // 主导度阈值：跟随背景实际绿度，设绝对下限避免把深绿漏掉
  const keyDominance = (key[1] - Math.max(key[0], key[2])) / 255
  const dominanceGate = Number.isFinite(opts.minGreen)
    ? opts.minGreen
    : Math.max(0.06, keyDominance * 0.45)

  // 补充规则：离键色足够近的（极暗的绿、阴影）即便主导度不够也清掉
  const distLimit = Number.isFinite(opts.tolerance)
    ? opts.tolerance
    : Math.max(45, Math.min(80, stats.p75 || 0))

  const total = width * height
  let removed = 0
  for (let i = 0; i < total; i++) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    const dominance = (g - Math.max(r, b)) / 255
    let dist = Infinity
    if (dominance >= dominanceGate) {
      dist = 0
    } else {
      const dr = r - key[0]
      const dg = g - key[1]
      const db = b - key[2]
      dist = Math.sqrt(dr * dr + dg * dg + db * db)
    }
    if (dominance >= dominanceGate || dist <= distLimit) {
      data[i * 4 + 3] = 0
      removed++
    }
  }

  const feather = Number.isFinite(opts.feather) ? opts.feather : 1
  if (feather > 0 && removed > 0) softEdges(data, width, height, Math.round(feather))
  return { removed, key, tolerance: Number(distLimit.toFixed(1)), dominanceGate: Number(dominanceGate.toFixed(3)) }
}

/**
 * 判断画面是否是绿幕：沿四边采样，绿色主导像素占比高 → 是。
 * 用于「自动模式」在 chroma 与 edge 之间选择（老素材没有绿幕，不能硬用 chroma）。
 */
function detectGreenBackground(data, width, height) {
  let green = 0
  let total = 0
  const test = (x, y) => {
    const i = (y * width + x) * 4
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    total++
    if (g > 80 && g - Math.max(r, b) > 40) green++
  }
  const stepX = Math.max(1, Math.floor(width / 48))
  const stepY = Math.max(1, Math.floor(height / 48))
  for (let x = 0; x < width; x += stepX) {
    test(x, 0)
    test(x, height - 1)
  }
  for (let y = 0; y < height; y += stepY) {
    test(0, y)
    test(width - 1, y)
  }
  return total ? green / total : 0
}

/** 边界羽化：把紧邻透明区域的像素按邻接比例降低 alpha */function softEdges(data, w, h, radius) {
  const alphaSnapshot = new Uint8ClampedArray(w * h)
  for (let i = 0; i < w * h; i++) alphaSnapshot[i] = data[i * 4 + 3]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = alphaSnapshot[y * w + x]
      if (a === 0) continue
      let transparent = 0
      let seen = 0
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          seen++
          if (alphaSnapshot[ny * w + nx] === 0) transparent++
        }
      }
      if (transparent > 0 && seen > 0) {
        const ratio = transparent / seen
        const i = (y * w + x) * 4
        data[i + 3] = Math.max(0, Math.min(255, Math.round(a * (1 - ratio * 1.8))))
      }
    }
  }
}

/**
 * 只保留最大的前景连通域，其余不透明像素一律清空。
 * 用途：边缘抠图对草地/噪点纹理背景会留下碎斑，主体通常是最大的那一块。
 * @returns {{kept: number, removed: number}}
 */
function keepLargestForeground(data, width, height, threshold = 8) {
  const total = width * height
  const label = new Int32Array(total).fill(-1)
  const stack = new Int32Array(total)
  let best = -1
  let bestSize = 0
  let current = 0

  for (let start = 0; start < total; start++) {
    if (label[start] !== -1) continue
    if (data[start * 4 + 3] <= threshold) continue
    let size = 0
    let top = 0
    stack[top++] = start
    label[start] = current
    while (top > 0) {
      const idx = stack[--top]
      size++
      const x = idx % width
      const y = (idx - x) / width
      const push = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return
        const n = ny * width + nx
        if (label[n] !== -1 || data[n * 4 + 3] <= threshold) return
        label[n] = current
        stack[top++] = n
      }
      push(x - 1, y)
      push(x + 1, y)
      push(x, y - 1)
      push(x, y + 1)
    }
    if (size > bestSize) {
      bestSize = size
      best = current
    }
    current++
  }

  if (best < 0) return { kept: 0, removed: 0 }
  let kept = 0
  let removed = 0
  for (let i = 0; i < total; i++) {
    if (data[i * 4 + 3] <= threshold) continue
    if (label[i] === best) kept++
    else {
      data[i * 4 + 3] = 0
      removed++
    }
  }
  return { kept, removed }
}

/**
 * 统计位图里「绿幕像素」的占比，用于判断首帧是否真的带绿幕。
 * 输入是 BGRA（Electron nativeImage.toBitmap() 的格式），只采样四边。
 * @returns {number} 0-1
 */
function greenRatioOfBitmap(buf, width, height) {
  if (!buf || !width || !height) return 0
  let green = 0
  let total = 0
  const test = (x, y) => {
    const i = (y * width + x) * 4
    const b = buf[i]
    const g = buf[i + 1]
    const r = buf[i + 2]
    total++
    if (g > 80 && g - Math.max(r, b) > 40) green++
  }
  const stepX = Math.max(1, Math.floor(width / 48))
  const stepY = Math.max(1, Math.floor(height / 48))
  for (let x = 0; x < width; x += stepX) {
    test(x, 0)
    test(x, height - 1)
  }
  for (let y = 0; y < height; y += stepY) {
    test(0, y)
    test(width - 1, y)
  }
  return total ? green / total : 0
}

/**
 * 计算非透明内容的包围盒（裁剪用）；全透明返回 null。
 *
 * 不能简单取「任意 alpha>threshold 的像素」的 min/max：画面边缘常有一圈 1px 残留杂色，
 * 一个像素就能把包围盒撑到整帧（实测 12 帧全是 720 = 整帧高，y 从 0 开始），
 * 之后等比缩放被这圈杂色拖小，主体只剩格子底部一条。
 * 改为按**行列成片像素数**判定，只认主体真正占据的范围。
 */
function trimBounds(data, width, height, threshold = 8, minRunRatio = 0.004) {
  const rowCount = new Int32Array(height)
  const colCount = new Int32Array(width)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        rowCount[y]++
        colCount[x]++
      }
    }
  }
  const rowGate = Math.max(2, Math.floor(width * minRunRatio))
  const colGate = Math.max(2, Math.floor(height * minRunRatio))

  let minY = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    if (rowCount[y] >= rowGate) {
      if (minY < 0) minY = y
      maxY = y
    }
  }
  let minX = -1
  let maxX = -1
  for (let x = 0; x < width; x++) {
    if (colCount[x] >= colGate) {
      if (minX < 0) minX = x
      maxX = x
    }
  }
  if (minY < 0 || minX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** 把最外圈 ring 像素强制清零：画框边缘属于背景，留着只会撑大裁剪框并产生绿边 */
function clearBorderRing(data, width, height, ring = 1) {
  let cleared = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= ring && x < width - ring && y >= ring && y < height - ring) continue
      const i = (y * width + x) * 4 + 3
      if (data[i] > 0) {
        data[i] = 0
        cleared++
      }
    }
  }
  return cleared
}

/** 横排精灵表布局：给定帧数与单帧尺寸，算出总宽（含上限校验） */
function layoutSheet(frames, cell) {
  const v = validateSheet(frames, cell)
  if (!v.ok) return { ok: false, error: v.error }
  return { ok: true, width: frames * cell, height: cell, cell, frames }
}

/**
 * 生成 pet.json 的动作条目（与 docs/08 契约字段一致）。
 * 精灵表文件名约定：<action>-sheet.png
 */
function buildActionSpec({ action, frames, cell, fps = DEFAULT_FPS }) {
  return {
    file: `${action}-sheet.png`,
    frames,
    fps,
    loop: true,
    weight: action === 'idle' ? 100 : 10,
    frameWidth: cell,
    frameHeight: cell,
    scale: 1,
    label: action,
    diary: { mood: '安逸', text: '{name}正在' + action + '。' }
  }
}

/** 动画产物目录名：安全化（只留字母数字下划线连字符） */
function safeSlug(name) {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'pet'
}

/**
 * 抽帧时间点：把时长均分成 N 段，取每段中点（避免首尾转场/黑帧）。
 */
function sampleTimes(durationSec, frames) {
  const d = Number(durationSec)
  const n = Math.max(1, Math.floor(frames))
  if (!Number.isFinite(d) || d <= 0) return []
  const step = d / n
  const out = []
  for (let i = 0; i < n; i++) out.push(Math.min(d - 0.02, step * (i + 0.5)))
  return out
}

  return {
    MAX_SHEET_WIDTH,
    DEFAULT_CELL,
    DEFAULT_FRAMES,
    DEFAULT_FPS,
    MIN_FRAMES,
    MAX_FRAMES,
    DEFAULT_PADDING,
    CHROMA_KEY,
    BG_HEX,
    validateSheet,
    edgeFloodAlpha,
    chromaKeyAlpha,
    borderColorStats,
    detectGreenBackground,
    greenRatioOfBitmap,
    softEdges,
    keepLargestForeground,
    trimBounds,
    clearBorderRing,
    layoutSheet,
    buildActionSpec,
    safeSlug,
    sampleTimes
  }
})
