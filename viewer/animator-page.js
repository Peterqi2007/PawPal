// PetPet 动画绘制 - 隐藏窗口工作线程
// 职责：视频 → 按时间点抽帧 → 边缘连通域抠图 → 统一画布居中 → 横排拼成精灵表（返回 PNG dataURL）
// 算法全部来自 animator.cjs（UMD，主进程与这里共用同一份实现）

;(function () {
  const A = window.PetPetAnimator
  const video = document.getElementById('v')

  const PAD = A.DEFAULT_PADDING

  function waitEvent(el, name, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      let done = false
      const onOk = () => {
        if (done) return
        done = true
        cleanup()
        resolve()
      }
      const onErr = () => {
        if (done) return
        done = true
        cleanup()
        reject(new Error(`视频加载失败（${el.error ? el.error.code : 'unknown'}）`))
      }
      const timer = setTimeout(() => {
        if (done) return
        done = true
        cleanup()
        reject(new Error('视频加载超时'))
      }, timeoutMs)
      function cleanup() {
        clearTimeout(timer)
        el.removeEventListener(name, onOk)
        el.removeEventListener('error', onErr)
      }
      el.addEventListener(name, onOk, { once: true })
      el.addEventListener('error', onErr, { once: true })
    })
  }

  /**
   * 跳转到指定时间点。
   * 必须带超时：解码器在内存紧张时可能永远不触发 seeked，
   * 导致整个抽帧流程永久挂起（日志停在 extract 之后就没了，实测踩过）。
   * 超时后不中断，改用当前帧继续，由调用方统计失败次数。
   */
  function seekTo(t, timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (Math.abs(video.currentTime - t) < 0.005) return resolve({ ok: true, skipped: true })
      let done = false
      const finish = (ok) => {
        if (done) return
        done = true
        clearTimeout(timer)
        video.removeEventListener('seeked', onSeeked)
        video.removeEventListener('error', onErr)
        resolve({ ok, at: video.currentTime })
      }
      const onSeeked = () => finish(true)
      const onErr = () => finish(false)
      const timer = setTimeout(() => finish(false), timeoutMs)
      video.addEventListener('seeked', onSeeked, { once: true })
      video.addEventListener('error', onErr, { once: true })
      try {
        video.currentTime = Math.max(0, t)
      } catch {
        finish(false)
      }
    })
  }

  /** 单帧处理：抠图（自动选绿幕/边缘）+ 去碎斑 + 裁剪，返回裁好的 canvas */
  function processFrame(source, srcW, srcH, opts) {
    const canvas = document.createElement('canvas')
    canvas.width = srcW
    canvas.height = srcH
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(source, 0, 0, srcW, srcH)
    const img = ctx.getImageData(0, 0, srcW, srcH)

    // 自动判定：四边以绿色为主 → 绿幕抠图；否则回退边缘连通域（兼容老素材）
    let mode = opts.keyMode || 'auto'
    const greenRatio = A.detectGreenBackground(img.data, srcW, srcH)
    if (mode === 'auto') mode = greenRatio >= 0.5 ? 'chroma' : 'edge'

    if (mode === 'chroma') {
      // 不传 tolerance：让 chroma 自己从四边拾取键色并推算容差
      A.chromaKeyAlpha(img.data, srcW, srcH, { feather: opts.feather })
    } else {
      A.edgeFloodAlpha(img.data, srcW, srcH, { tolerance: opts.tolerance, feather: opts.feather })
    }
    // 草地/噪点背景会留碎斑：只保留最大前景连通域（主体），其余清空
    if (opts.cleanup !== false) {
      A.keepLargestForeground(img.data, srcW, srcH)
    }
    // 画面最外圈一定是背景：强制清零，避免 1px 残留把裁剪框撑到整帧
    A.clearBorderRing(img.data, srcW, srcH, 2)
    const box = A.trimBounds(img.data, srcW, srcH)
    if (!box) return null // 整帧都被判成背景：跳过
    ctx.putImageData(img, 0, 0)
    const cropped = document.createElement('canvas')
    cropped.width = box.width
    cropped.height = box.height
    cropped.getContext('2d').drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height)
    return { canvas: cropped, width: box.width, height: box.height, mode, greenRatio }
  }

  /** 把裁好的帧统一缩放居中，横排拼成一张表 */
  function assemble(cells, cellSize) {
    const usable = Math.round(cellSize * (1 - PAD * 2))
    let maxW = 1
    let maxH = 1
    for (const c of cells) {
      if (c.width > maxW) maxW = c.width
      if (c.height > maxH) maxH = c.height
    }
    // 统一比例：所有帧用同一个缩放系数，避免播放时「缩放跳动」
    const scale = Math.min(usable / maxW, usable / maxH, 1)
    const layout = A.layoutSheet(cells.length, cellSize)
    if (!layout.ok) throw new Error(layout.error)

    const sheet = document.createElement('canvas')
    sheet.width = layout.width
    sheet.height = layout.height
    const ctx = sheet.getContext('2d')
    cells.forEach((c, i) => {
      const w = Math.max(1, Math.round(c.width * scale))
      const h = Math.max(1, Math.round(c.height * scale))
      const dx = i * cellSize + Math.round((cellSize - w) / 2)
      // 底部对齐：脚踩同一水平线。注意是 cellSize - h，不是 h
      const dy = cellSize - h
      ctx.drawImage(c.canvas, 0, 0, c.width, c.height, dx, dy, w, h)
    })
    return { canvas: sheet, width: sheet.width, height: sheet.height, scale }
  }

  function summarize(sheet, meta) {
    return {
      ok: true,
      sheetDataUrl: sheet.canvas.toDataURL('image/png'),
      width: sheet.width,
      height: sheet.height,
      cell: meta.cell,
      frames: meta.frames,
      scale: sheet.scale,
      duration: meta.duration || null,
      fps: meta.fps || null,
      keyMode: meta.keyMode || null,
      greenRatio: meta.greenRatio == null ? null : Number(meta.greenRatio.toFixed(2))
    }
  }

  /**
   * 把源地址取成 Blob 再交给 <video>。
   * 原因：自定义协议返回的响应没有 Range 支持，<video> 会退化成「不可寻址」
   * （seekable = [0,0]），currentTime 赋值无效 → 每次抽帧都拿到第一帧。
   * Blob URL 天然可寻址，是这里唯一可靠的做法。
   */
  async function loadVideoSource(src) {
    try {
      const res = await fetch(src)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = await res.arrayBuffer()
      if (!buf.byteLength) throw new Error('空文件')
      return URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }))
    } catch (e) {
      console.warn('Blob 加载失败，回退直连:', e && e.message)
      return src
    }
  }

  /** 视频 → 精灵表 */
  async function buildFromVideo(opts) {
    const frames = Math.max(A.MIN_FRAMES, Math.min(A.MAX_FRAMES, Number(opts.frames) || A.DEFAULT_FRAMES))
    const cell = Number(opts.cell) || A.DEFAULT_CELL
    const check = A.validateSheet(frames, cell)
    if (!check.ok) return { ok: false, error: check.error }

    video.src = await loadVideoSource(opts.src)
    video.load()
    await waitEvent(video, 'loadeddata')
    const srcW = video.videoWidth
    const srcH = video.videoHeight
    if (!srcW || !srcH) return { ok: false, error: '无法读取视频尺寸（编码格式可能不被支持）' }
    if (!video.seekable.length || video.seekable.end(0) - video.seekable.start(0) < 1) {
      console.warn('视频不可寻址，抽帧可能退化为同一帧')
    }

    const duration = Number(video.duration)
    const times = A.sampleTimes(duration, frames)
    const keyOpts = { tolerance: opts.tolerance, feather: opts.feather }

    const cells = []
    let seekFails = 0
    for (let i = 0; i < times.length; i++) {
      const r = await seekTo(times[i])
      if (!r.ok) seekFails++
      const c = processFrame(video, srcW, srcH, keyOpts)
      console.log(`[抽帧] ${i + 1}/${times.length} t=${times[i].toFixed(2)}s seek=${r.ok ? 'ok' : 'timeout'}`)
      if (c) cells.push(c)
    }
    if (seekFails >= Math.ceil(times.length / 2)) {
      return { ok: false, error: `跳转超时 ${seekFails}/${times.length} 帧（解码器无响应）` }
    }
    if (cells.length < A.MIN_FRAMES) {
      return { ok: false, error: `只抽出 ${cells.length} 帧有效画面（可能背景判定过激），请调大容差或换素材` }
    }
    const sheet = assemble(cells, cell)
    return summarize(sheet, {
      cell,
      frames: cells.length,
      duration,
      keyMode: cells[0].mode,
      greenRatio: cells[0].greenRatio
    })
  }

  /** 帧序列（canvas 数组）→ 精灵表：供本地自测与「图片序列」输入复用 */
  async function buildFromCanvases(opts) {
    const list = opts.canvases || []
    const cell = Number(opts.cell) || A.DEFAULT_CELL
    if (!list.length) return { ok: false, error: '没有输入帧' }
    const check = A.validateSheet(list.length, cell)
    if (!check.ok) return { ok: false, error: check.error }
    const keyOpts = { tolerance: opts.tolerance, feather: opts.feather }
    const cells = []
    for (const cv of list) {
      const c = processFrame(cv, cv.width, cv.height, keyOpts)
      if (c) cells.push(c)
    }
    if (!cells.length) return { ok: false, error: '所有帧都被判成背景' }
    const sheet = assemble(cells, cell)
    return summarize(sheet, {
      cell,
      frames: cells.length,
      duration: null,
      keyMode: cells[0].mode,
      greenRatio: cells[0].greenRatio
    })
  }

  window.__animator = { buildFromVideo, buildFromCanvases }
})()
