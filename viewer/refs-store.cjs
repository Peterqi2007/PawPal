// PawPal 参考图库（主进程模块，CommonJS）
//
// 用途：把宠物真实照片导入为「重绘」的参考素材，并区分两种角色——
//   setup = 设定图（形象锚点 @图片1，**每个分组内**唯一）
//   pose  = 姿势参考图（姿态锚点 @图片2..N）
// 规则：默认**首张导入即为设定图**，其余为姿势参考图（docs/01 §3.6 / docs/02 §3）。
//
// 为什么需要分组（v2）：一个用户可能有多只宠物，而「设定图」天然是**按宠物**的——
// 豆豆的设定图不能顶替包包的形象锚点。故参考图按分组（= 一只宠物）归档，
// 角色不变量「设定图唯一」也随之收敛到分组内。没有任何分组时自动建一个默认分组。
//
// 存储位置：~/.petpet/refs/
//   ├── refs.json          索引 v2（groups + items：角色、分组、原始名、尺寸、时间）
//   └── images/
//       ├── <id>.<ext>     原图副本（不引用用户原始路径，删原图不影响库）
//       └── <id>.thumb.jpg 预览缩略图（≤640px，界面只加载缩略图）
//
// 为什么不引入 SQLite：本项目「宠物即数据包」的哲学是**纯文件、零原生依赖**——
// better-sqlite3 需要按 Electron ABI 重编译，还要进 build.files 白名单与打包链路，
// 而这里的规模（≤20 组 × ≤40 张）完全不需要索引引擎。JSON 索引 + 文件副本同样具备
// 「可备份、可手工查看、可随宠物包迁移」的优点，也不增加分发负担。
//
// 兼容：v1 索引（无 groups/group 字段）在读取时自动迁移——全部图片归入一个默认分组。
//
// 安全边界（对齐 pet-import.cjs 的 fail-closed 风格）：
//   - 文件名一律由本模块生成 id（r_<时间戳>_<随机>），绝不用用户文件名拼路径
//   - 扩展名白名单 + 单张 10MB 上限 + 总量上限
//   - 必须能被解码成真实图片（解码失败即拒绝），防「改后缀的伪图片」
//   - 原始文件名/分组名只作为展示用元数据，经净化后入库（剥离控制/零宽字符 + 截断）

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp'])
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 界面模板标注：单张最大 10MB
const MAX_ITEMS = 40 // 每组上限：参考图不是素材库，8 个动作够用的量级
const MAX_GROUPS = 20 // 分组上限：一只宠物一组，20 只足够家庭场景
const MAX_NAME_LEN = 80
const MAX_GROUP_NAME_LEN = 30
const DEFAULT_GROUP_NAME = '默认分组' // 新库自动建的分组名（旧版叫「我的宠物」，曾被误认成测试图组）

// 宠物档案（跟分组走，装配时写进 pet.json）
const PET_TYPES = ['猫', '狗', '其他']
const TEMPERAMENTS = ['温柔', '傲娇', '搞笑']

function blankProfile() {
  return { petType: '猫', breed: '', temperament: '温柔' }
}
const ROLES = ['setup', 'pose']
const ID_RE = /^r_[0-9a-z_]+$/
const GROUP_ID_RE = /^g_[0-9a-z_]+$/
const INDEX_VERSION = 2

// 控制字符 / 零宽字符 / 双向控制符（间接注入载体，同 pet-import 的 cleanText 口径）
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g

function sanitizeText(name, fallback, maxLen) {
  const base = String(name == null ? '' : name)
    .replace(UNSAFE_CHARS, '')
    .replace(/[\\/]/g, '_') // 路径分隔符不能进展示名
    .replace(/\s+/g, ' ')
    .trim()
  if (!base) return fallback
  return base.length > maxLen ? base.slice(0, maxLen) : base
}

function sanitizeName(name) {
  return sanitizeText(name, '未命名图片', MAX_NAME_LEN)
}

function sanitizeGroupName(name) {
  return sanitizeText(name, '未命名分组', MAX_GROUP_NAME_LEN)
}

function extOf(name) {
  return path.extname(String(name || '')).toLowerCase()
}

// 原子写：先写临时文件再 rename，避免进程被杀时留下半截 refs.json
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`
}

function isValidItem(it) {
  return isPlainObject(it) && typeof it.id === 'string' && ID_RE.test(it.id) && typeof it.file === 'string'
}

function isValidGroup(g) {
  return isPlainObject(g) && typeof g.id === 'string' && GROUP_ID_RE.test(g.id)
}

// 索引容错读取 + v1→v2 迁移：
//   - 文件损坏/结构非法 → 视为空库，不炸启动（下次写入即覆盖）
//   - 无分组（v1 或空库）→ 自动建默认分组并把图片归入其中
function readIndexFile(indexPath) {
  const empty = { version: INDEX_VERSION, groups: [], items: [], dirty: false }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  } catch {
    raw = null
  }
  if (!isPlainObject(raw)) return empty

  let dirty = false
  let groups = Array.isArray(raw.groups) ? raw.groups.filter(isValidGroup) : []
  const items = Array.isArray(raw.items) ? raw.items.filter(isValidItem) : []

  if (!groups.length) {
    // v1（无 groups 字段）或空库：建默认分组，所有图片归入
    groups = [{ id: newId('g'), name: DEFAULT_GROUP_NAME, createdAt: Date.now() }]
    items.forEach((it) => {
      if (!it.group) it.group = groups[0].id
    })
    dirty = true
  }

  const ids = new Set(groups.map((g) => g.id))
  const fallback = groups[0].id
  items.forEach((it) => {
    if (!ids.has(it.group)) {
      it.group = fallback // 分组被手改删除 → 收回默认分组，不留孤儿图片
      dirty = true
    }
    // v2.1：新增 source（upload|ai）——老数据补默认值，不单独触发落盘
    if (it.source !== 'ai') it.source = 'upload'
  })
  groups.forEach((g) => {
    if (typeof g.name !== 'string' || !g.name) {
      g.name = DEFAULT_GROUP_NAME
      dirty = true
    }
  })

  if (Number(raw.version) !== INDEX_VERSION) dirty = true
  const lastGroupId = typeof raw.lastGroupId === 'string' && GROUP_ID_RE.test(raw.lastGroupId) ? raw.lastGroupId : ''
  return { version: INDEX_VERSION, groups, items, lastGroupId, dirty }
}

// 角色不变量：**每个分组内**最多一张 setup。
// 组内 0 张或多张（手改索引、迁移）时，按导入顺序把最早那张定为设定图
function normalizeRoles(items) {
  const byGroup = new Map()
  for (const it of items) {
    const key = it.group || '_'
    if (!byGroup.has(key)) byGroup.set(key, [])
    byGroup.get(key).push(it)
  }
  for (const list of byGroup.values()) {
    const setups = list.filter((it) => it.role === 'setup')
    if (setups.length === 1) {
      list.forEach((it) => {
        if (it.role !== 'setup') it.role = 'pose'
      })
      continue
    }
    const sorted = [...list].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))
    const keeper = sorted[0] ? sorted[0].id : null
    list.forEach((it) => {
      it.role = it.id === keeper ? 'setup' : 'pose'
    })
  }
  return items
}

/**
 * 创建参考图库实例。
 * @param {string} rootDir 库根目录（生产环境 = ~/.petpet/refs）
 * @param {{thumbMaker?: (buf: Buffer, originalName?: string) => ({data: Buffer, ext: string, width: number, height: number}|null)}} opts
 *        thumbMaker 负责解码校验 + 缩略图生成（主进程注入 Electron nativeImage，
 *        单测注入假实现，从而本模块不依赖 electron，可被 vitest 直接测试）
 */
function createRefsStore(rootDir, opts = {}) {
  const thumbMaker = opts.thumbMaker
  if (typeof thumbMaker !== 'function') throw new Error('createRefsStore 需要 thumbMaker（图片解码/缩略图生成器）')

  const imagesDir = path.join(rootDir, 'images')
  const indexPath = path.join(rootDir, 'refs.json')

  function ensureDirs() {
    fs.mkdirSync(imagesDir, { recursive: true })
  }

  function save(idx) {
    ensureDirs()
    writeJsonAtomic(indexPath, {
      version: INDEX_VERSION,
      lastGroupId: idx.lastGroupId || '',
      groups: idx.groups,
      items: idx.items
    })
    idx.dirty = false
  }

  // 读取 + 规范化；迁移或自动建组后立即落盘（保证界面一打开就能看到分组）
  function load() {
    ensureDirs()
    const idx = readIndexFile(indexPath)
    idx.items = normalizeRoles(idx.items)
    if (idx.dirty) save(idx)
    return idx
  }

  function groups() {
    return load().groups
  }

  /**
   * 解析分组，优先级：显式传入且存在 → 上次选中的分组 → 第一个分组（不存在则自动建）
   * 「上次选中」持久化在索引里，重开面板不会跳回第一组
   */
  function resolveGroup(idx, groupId) {
    if (groupId && GROUP_ID_RE.test(String(groupId))) {
      const hit = idx.groups.find((g) => g.id === groupId)
      if (hit) return hit.id
    }
    if (idx.lastGroupId) {
      const last = idx.groups.find((g) => g.id === idx.lastGroupId)
      if (last) return last.id
    }
    if (!idx.groups.length) {
      const g = { id: newId('g'), name: DEFAULT_GROUP_NAME, createdAt: Date.now() }
      idx.groups.push(g)
      idx.dirty = true
      return g.id
    }
    return idx.groups[0].id
  }

  /** 列表：可按分组过滤；不传则返回全部（界面按分组切换时用过滤） */
  function list(groupId) {
    const items = load().items
    if (!groupId) return items
    return items.filter((it) => it.group === groupId)
  }

  function getItem(id) {
    if (!ID_RE.test(String(id || ''))) return null
    return load().items.find((it) => it.id === id) || null
  }

  /** 新建分组；重名不拦（id 才是唯一键），直接返回已存在的那一组更符合预期 */
  function createGroup(name) {
    const idx = load()
    const clean = sanitizeGroupName(name)
    const dup = idx.groups.find((g) => g.name === clean)
    if (dup) return { ok: true, group: dup, groups: idx.groups, existed: true }
    if (idx.groups.length >= MAX_GROUPS) {
      return { ok: false, error: `最多 ${MAX_GROUPS} 个分组`, groups: idx.groups }
    }
    const group = { id: newId('g'), name: clean, createdAt: Date.now(), profile: blankProfile() }
    idx.groups.push(group)
    save(idx)
    return { ok: true, group, groups: idx.groups, existed: false }
  }

  /**
   * 改写宠物档案（名字/类型/品种/人格）。
   * 这些字段属于「这只宠物的设定」，跟着分组走，装配时写进 pet.json。
   */
  function setProfile(groupId, patch) {
    const idx = load()
    const gid = resolveGroup(idx, groupId)
    const group = idx.groups.find((g) => g.id === gid)
    if (!group) return { ok: false, error: '分组不存在' }
    const cur = group.profile && typeof group.profile === 'object' ? group.profile : blankProfile()
    const next = { ...cur }
    if (patch && typeof patch === 'object') {
      if (typeof patch.name === 'string' && patch.name.trim()) {
        group.name = sanitizeGroupName(patch.name)
      }
      if (typeof patch.petType === 'string' && PET_TYPES.includes(patch.petType)) next.petType = patch.petType
      if (typeof patch.breed === 'string') next.breed = String(patch.breed).trim().slice(0, 20)
      if (typeof patch.temperament === 'string' && TEMPERAMENTS.includes(patch.temperament)) {
        next.temperament = patch.temperament
      }
    }
    group.profile = next
    save(idx)
    return { ok: true, group, groups: idx.groups }
  }

  /**
   * 导入一张图片。
   * @param {string} [groupId] 目标分组；缺省/非法时落到默认分组（自动建）
   * @param {{source?: 'upload'|'ai'}} [opts] source 标记来源（AI 重绘产物用于卡片徽章）
   * @returns {{ok: true, item: object, items: object[]} | {ok: false, error: string}}
   */
  function addFromBuffer(buf, originalName, groupId, opts = {}) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, error: '文件为空' }
    if (buf.length > MAX_FILE_BYTES) {
      return { ok: false, error: `超过单张上限 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB` }
    }
    const ext = extOf(originalName)
    if (!ALLOWED_EXT.has(ext)) {
      return { ok: false, error: `不支持的格式 ${ext || '(无扩展名)'}，仅支持 JPG / PNG / WebP / BMP` }
    }

    const idx = load()
    const gid = resolveGroup(idx, groupId)
    const inGroup = idx.items.filter((it) => it.group === gid)
    if (inGroup.length >= MAX_ITEMS) {
      return { ok: false, error: `该分组最多 ${MAX_ITEMS} 张，请先删除不用的参考图` }
    }

    // fail-closed：解不开就不是图片（防改后缀的伪图片 / 损坏文件）
    let thumb
    try {
      thumb = thumbMaker(buf, originalName)
    } catch {
      thumb = null
    }
    if (!thumb || !Buffer.isBuffer(thumb.data) || !thumb.width || !thumb.height) {
      return { ok: false, error: '无法解码为图片（文件可能已损坏）' }
    }

    const id = newId('r')
    const fileName = id + ext
    const thumbName = id + (thumb.ext || '.jpg')
    try {
      ensureDirs()
      fs.writeFileSync(path.join(imagesDir, fileName), buf)
      fs.writeFileSync(path.join(imagesDir, thumbName), thumb.data)
    } catch (e) {
      // 落盘失败不能留下孤儿索引项
      for (const f of [fileName, thumbName]) {
        try {
          fs.unlinkSync(path.join(imagesDir, f))
        } catch {
          /* 清理失败忽略 */
        }
      }
      return { ok: false, error: `写入失败: ${e && e.message ? e.message : e}` }
    }

    const item = {
      id,
      file: fileName,
      thumb: thumbName,
      originalName: sanitizeName(originalName),
      group: gid,
      // 组内首张导入即为该宠物的设定图（产品规则）；其余一律姿势参考
      role: inGroup.length === 0 ? 'setup' : 'pose',
      // 来源：upload = 用户导入；ai = 面板重绘生成（卡片上显示 AI 徽章）
      source: opts && opts.source === 'ai' ? 'ai' : 'upload',
      width: thumb.width,
      height: thumb.height,
      bytes: buf.length,
      addedAt: Date.now()
    }
    idx.items.push(item)
    save(idx)
    return { ok: true, item, items: idx.items }
  }

  /** 切换角色：设为设定图会把**同组**原设定图降级（跨组互不影响） */
  function setRole(id, role) {
    if (!ROLES.includes(role)) return { ok: false, error: `非法角色 ${role}` }
    const idx = load()
    const target = idx.items.find((it) => it.id === id)
    if (!target) return { ok: false, error: '图片不存在' }
    if (role === 'setup') {
      idx.items.forEach((it) => {
        if (it.group !== target.group) return
        it.role = it.id === id ? 'setup' : 'pose'
      })
    } else {
      // 不允许把组内唯一的设定图直接降级成姿势参考（会让该宠物失去形象锚点）
      if (target.role === 'setup') {
        return { ok: false, error: '设定图只能由同组另一张图片顶替，不能直接取消' }
      }
      target.role = 'pose'
    }
    save(idx)
    return { ok: true, items: idx.items }
  }

  /** 删除：文件与索引一起删；若删掉的是某组设定图，该组最早一张自动补位 */
  function remove(id) {
    const idx = load()
    const at = idx.items.findIndex((it) => it.id === id)
    if (at < 0) return { ok: false, error: '图片不存在' }
    const [gone] = idx.items.splice(at, 1)
    for (const f of [gone.file, gone.thumb]) {
      if (!f) continue
      try {
        fs.unlinkSync(path.join(imagesDir, f))
      } catch {
        /* 文件已不在：索引仍要清理 */
      }
    }
    normalizeRoles(idx.items)
    save(idx)
    return { ok: true, items: idx.items }
  }

  /**
   * 删除整个分组（组内图片与缩略图一并清理）。
   * 拒绝删除最后一个分组：图库没有分组会让整个界面失去落点，留一个空组更安全。
   */
  function deleteGroup(groupId) {
    const idx = load()
    const gid = String(groupId || '')
    if (!GROUP_ID_RE.test(gid)) return { ok: false, error: '分组标识无效' }
    const group = idx.groups.find((g) => g.id === gid)
    if (!group) return { ok: false, error: '分组不存在' }
    if (idx.groups.length <= 1) return { ok: false, error: '至少保留一个分组' }

    const goners = idx.items.filter((it) => it.group === gid)
    let deletedFiles = 0
    for (const it of goners) {
      for (const f of [it.file, it.thumb]) {
        if (!f) continue
        try {
          fs.unlinkSync(path.join(imagesDir, f))
          deletedFiles++
        } catch {
          /* 文件已不在：索引仍要清理 */
        }
      }
    }
    idx.items = idx.items.filter((it) => it.group !== gid)
    idx.groups = idx.groups.filter((g) => g.id !== gid)
    if (idx.lastGroupId === gid) idx.lastGroupId = idx.groups[0].id
    save(idx)
    return {
      ok: true,
      groupId: gid,
      removed: { items: goners.length, files: deletedFiles }
    }
  }

  /** 读缩略图字节（界面通过 IPC 拿 dataURL；不存在返回 null） */
  function getThumb(id) {
    const it = getItem(id)
    if (!it || !it.thumb) return null
    const abs = path.join(imagesDir, it.thumb)
    // 纵深校验：解析后的绝对路径必须仍在 images/ 内
    const rel = path.relative(imagesDir, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    try {
      return fs.readFileSync(abs)
    } catch {
      return null
    }
  }

  /** 统计：可按分组过滤（界面底部展示当前分组占用） */
  function stats(groupId) {
    const items = list(groupId)
    return {
      count: items.length,
      bytes: items.reduce((n, it) => n + (Number(it.bytes) || 0), 0),
      setupCount: items.filter((it) => it.role === 'setup').length,
      poseCount: items.filter((it) => it.role === 'pose').length
    }
  }

  /** 组装界面状态（分组列表 + 当前分组 + 该组图片 + 统计） */
  function buildState(idx, gid) {
    const items = idx.items.filter((it) => it.group === gid)
    return {
      groups: idx.groups.map((g) => ({
        ...g,
        count: idx.items.filter((it) => it.group === g.id).length
      })),
      activeGroupId: gid,
      items,
      stats: {
        count: items.length,
        bytes: items.reduce((n, it) => n + (Number(it.bytes) || 0), 0),
        setupCount: items.filter((it) => it.role === 'setup').length,
        poseCount: items.filter((it) => it.role === 'pose').length
      }
    }
  }

  /**
   * 只读查询：显式传 groupId 时按它返回，但**不**改变「上次选中分组」
   * （后台查询某组不应影响用户下次打开面板落在哪一组）
   */
  function state(groupId) {
    const idx = load()
    const gid = resolveGroup(idx, groupId)
    if (idx.dirty) save(idx)
    return buildState(idx, gid)
  }

  /** 用户主动切换分组：写入「上次选中分组」并返回该组状态 */
  function setActiveGroup(groupId) {
    const idx = load()
    const gid = resolveGroup(idx, groupId)
    if (idx.lastGroupId !== gid) {
      idx.lastGroupId = gid
      idx.dirty = true
    }
    if (idx.dirty) save(idx)
    return buildState(idx, gid)
  }

  return {
    rootDir,
    imagesDir,
    indexPath,
    groups,
    list,
    getItem,
    createGroup,
    setProfile,
    PET_TYPES,
    TEMPERAMENTS,
    addFromBuffer,
    setRole,
    remove,
    getThumb,
    stats,
    state,
    setActiveGroup,
    deleteGroup
  }
}

module.exports = {
  createRefsStore,
  sanitizeName,
  sanitizeGroupName,
  extOf,
  normalizeRoles,
  ALLOWED_EXT,
  MAX_FILE_BYTES,
  MAX_ITEMS,
  MAX_GROUPS,
  MAX_NAME_LEN,
  MAX_GROUP_NAME_LEN,
  DEFAULT_GROUP_NAME,
  ROLES,
  ID_RE,
  GROUP_ID_RE
}
