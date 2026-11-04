// PawPal 桌宠装配器（主进程模块，CommonJS）
//
// 把「动画产物」（~/.petpet/anim/<slug>/<action>-sheet.png）装配成运行时可加载的宠物包：
//   ~/.petpet/pets/<id>/pet.json + <action>-sheet.png …
// 装配完即可被 viewer 加载播放（换宠物 = 换目录，不动代码）。
//
// 契约对齐 docs/08：pet.json v3，动作字段 frames/fps/frameWidth/frameHeight/loop/weight。
// 硬约束：精灵表总宽 = cell × frames ≤ 16384px（WebGL 纹理上限，docs/07 踩坑 #1）。

const path = require('path')
const fs = require('fs')
const { pngSize } = require('./pet-import.cjs')

const MAX_SHEET_WIDTH = 16384
const ID_RE = /^[a-z0-9_-]+$/
const ACTION_LABEL = {
  idle: '待机',
  sleep: '睡觉',
  wiggle: '撒娇',
  run: '奔跑',
  stretch: '伸懒腰',
  belly: '露肚躺',
  sniff: '嗅闻'
}
const ACTION_MOOD = {
  idle: '安逸',
  sleep: '安逸',
  wiggle: '开心',
  run: '兴奋',
  stretch: '舒坦',
  belly: '惬意',
  sniff: '好奇'
}

/** 名称 → 合法目录 id（ASCII，小写，连字符） */
function safeId(name, fallback = 'pet') {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || fallback
}

/** 扫描动画目录里的精灵表，解析出动作名 */
function collectSheets(animDir) {
  let files = []
  try {
    files = fs.readdirSync(animDir)
  } catch {
    return []
  }
  return files
    .filter((f) => /^[a-z0-9_-]+-sheet\.png$/i.test(f))
    .map((f) => ({ file: f, action: f.replace(/-sheet\.png$/i, '').toLowerCase(), abs: path.join(animDir, f) }))
    .sort((a, b) => (a.action === 'idle' ? -1 : b.action === 'idle' ? 1 : a.action.localeCompare(b.action)))
}

/** 由精灵表推断帧数与单帧尺寸（表中是等宽等高横排） */
function inferSheetMeta(absPath) {
  let size = null
  try {
    size = pngSize(fs.readFileSync(absPath))
  } catch {
    size = null
  }
  if (!size || !size.width || !size.height) return { ok: false, error: '精灵表无法解析（不是有效 PNG）' }
  if (size.width > MAX_SHEET_WIDTH) {
    return { ok: false, error: `精灵表总宽 ${size.width}px 超过 ${MAX_SHEET_WIDTH}px 上限` }
  }
  const cell = size.height
  const frames = Math.round(size.width / cell)
  if (frames < 1 || frames * cell !== size.width) {
    return { ok: false, error: `精灵表宽高不成整数帧（${size.width}×${size.height}）` }
  }
  return { ok: true, frames, cell }
}

/** 生成单个动作的 pet.json 片段 */
function buildAction(action, { file, frames, cell, fps = 5 }) {
  const label = ACTION_LABEL[action] || action
  return {
    file,
    frames,
    fps,
    loop: true,
    weight: action === 'idle' ? 100 : 10,
    frameWidth: cell,
    frameHeight: cell,
    scale: 1,
    label,
    diary: { mood: ACTION_MOOD[action] || '安逸', text: `{name}正在${label}。` }
  }
}

/**
 * 装配宠物包。
 * @param {object} opts
 * @param {string} opts.petsRoot           ~/.petpet/pets
 * @param {string} opts.name               显示名（分组名）
 * @param {Array<{action:string, abs:string}>} opts.sheets 已存在的精灵表
 * @param {string} [opts.idHint]           目录 id 提示（通常 = 动画目录 slug）
 * @returns {{ok:true, id:string, dir:string, actions:string[]} | {ok:false, error:string}}
 */
function assemblePet({ petsRoot, name, sheets, idHint, style = 'illustration', fps = 5, bubbles }) {
  if (!Array.isArray(sheets) || !sheets.length) return { ok: false, error: '该分组还没有生成任何动作动画' }
  fs.mkdirSync(petsRoot, { recursive: true })

  // 1. 逐张校验尺寸
  const planned = []
  for (const s of sheets) {
    const meta = inferSheetMeta(s.abs)
    if (!meta.ok) return { ok: false, error: `${s.action}: ${meta.error}` }
    planned.push({ ...s, ...meta })
  }

  // 2. 目录 id：优先用提示值，重名则加序号（不覆盖已有宠物包）
  const baseId = safeId(idHint || name)
  let id = baseId
  let n = 1
  while (fs.existsSync(path.join(petsRoot, id, 'pet.json'))) {
    n++
    id = `${baseId}-${n}`
    if (n > 50) return { ok: false, error: '同名宠物包过多，请先清理' }
  }
  if (!ID_RE.test(id)) return { ok: false, error: `非法宠物 id: ${id}` }

  // 3. 建目录 + 拷贝精灵表
  const dir = path.join(petsRoot, id)
  fs.mkdirSync(dir, { recursive: true })
  const actions = {}
  for (const p of planned) {
    const fileName = `${p.action}-sheet.png`
    fs.copyFileSync(p.abs, path.join(dir, fileName))
    actions[p.action] = buildAction(p.action, { file: fileName, frames: p.frames, cell: p.cell, fps })
  }

  // 4. 写 pet.json（v3 契约）
  const firstCell = planned[0].cell
  const petJson = {
    version: 3,
    id,
    name: String(name || id),
    style,
    bubbles: Array.isArray(bubbles) && bubbles.length ? bubbles.slice(0, 6) : ['喵～', '摸摸我～', '今天也要开心哦'],
    cellWidth: firstCell,
    cellHeight: firstCell,
    actions
  }
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify(petJson, null, 2), 'utf8')
  return { ok: true, id, dir, actions: Object.keys(actions) }
}

module.exports = { MAX_SHEET_WIDTH, safeId, collectSheets, inferSheetMeta, buildAction, assemblePet }
