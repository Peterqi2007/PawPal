// 参考图库面板 - 渲染逻辑
// 职责：分组切换/新建 + 展示当前分组的参考图（设定图 / 姿势参考）+ 导入（点 + 选文件 / 拖拽）+ 删改角色
// 存储与校验全部在主进程（refs-store.cjs），本文件只做视图与交互，不碰文件系统。

const api = window.refsAPI

const galleryEl = document.getElementById('gallery')
const countEl = document.getElementById('count')
const summaryEl = document.getElementById('summary')
const hintEl = document.getElementById('hint')
const usageEl = document.getElementById('usage')
const dropEl = document.getElementById('drop')
const dropTargetEl = document.getElementById('dropTarget')
const chipsEl = document.getElementById('groupChips')
const groupAddBtn = document.getElementById('groupAdd')
const groupNewForm = document.getElementById('groupNew')
const groupNameInput = document.getElementById('groupName')
const groupCancelBtn = document.getElementById('groupCancel')

// AI 重绘相关
const readyEl = document.getElementById('ready')
const redrawBtn = document.getElementById('redraw')
const gearBtn = document.getElementById('gear')
const arkPanel = document.getElementById('arkPanel')
const arkKeyInput = document.getElementById('arkKey')
const arkBaseSel = document.getElementById('arkBase')
const arkModelInput = document.getElementById('arkModel')
const arkVideoModelInput = document.getElementById('arkVideoModel')
const arkStyleSel = document.getElementById('arkStyle')
const arkStateEl = document.getElementById('arkState')

// 动画绘制
const animBtn = document.getElementById('animBtn')
const animActionSel = document.getElementById('animAction')
const animPreview = document.getElementById('animPreview')
const animStrip = document.getElementById('animStrip')
const animTitle = document.getElementById('animTitle')
const animPath = document.getElementById('animPath')

// 当前界面状态（主进程 state() 原样存；切换分组会整体替换）
let current = { groups: [], activeGroupId: '', items: [], stats: { count: 0, bytes: 0, setupCount: 0, poseCount: 0 } }

// 缩略图 dataURL 缓存（同一 id 只取一次；删除时清理）
const thumbCache = new Map()
// 渲染令牌：并发 render 时只让最后一次生效（防异步乱序覆盖）
let renderToken = 0
let hintTimer = null
let importing = false
// 重绘：ark = 主进程回来的脱敏配置（绝不含密钥明文）；busy = 生成中
let ark = null
let minPose = 3
let busy = false

const ROLE_LABEL = { setup: '设定图', pose: '姿势参考图' }

function fmtBytes(n) {
  if (!n) return '0 B'
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function say(text, warn) {
  hintEl.textContent = text || ''
  hintEl.classList.toggle('warn', !!warn)
  if (hintTimer) clearTimeout(hintTimer)
  if (text) {
    hintTimer = setTimeout(() => {
      hintEl.textContent = ''
      hintEl.classList.remove('warn')
    }, 4200)
  }
}

function padIdx(n) {
  return String(n).padStart(2, '0')
}

function activeGroupName() {
  const g = current.groups.find((x) => x.id === current.activeGroupId)
  return g ? g.name : '未分组'
}

// ── 分组栏 ──
function renderChips() {
  chipsEl.innerHTML = ''
  for (const g of current.groups) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'chip' + (g.id === current.activeGroupId ? ' is-active' : '')
    chip.dataset.id = g.id
    chip.setAttribute('role', 'tab')
    chip.setAttribute('aria-selected', String(g.id === current.activeGroupId))
    chip.title = `${g.name}（${g.count || 0} 张）`

    const name = document.createElement('span')
    name.textContent = g.name
    const n = document.createElement('span')
    n.className = 'chip-n'
    n.textContent = String(g.count || 0)
    chip.appendChild(name)
    chip.appendChild(n)

    chip.addEventListener('click', () => {
      if (g.id === current.activeGroupId) return
      selectGroup(g.id)
    })
    chipsEl.appendChild(chip)
  }
}

async function selectGroup(id) {
  try {
    // activate（而不是 state）：主动切换要记住选择，下次打开面板落在这只宠物上
    const s = await api.activateGroup(id)
    applyState(s)
  } catch (err) {
    say('切换分组失败：' + (err && err.message ? err.message : err), true)
  }
}

// ── 新建分组 ──
function showGroupForm() {
  groupNewForm.classList.remove('hidden')
  groupAddBtn.classList.add('hidden')
  groupNameInput.value = ''
  groupNameInput.focus()
}

function hideGroupForm() {
  groupNewForm.classList.add('hidden')
  groupAddBtn.classList.remove('hidden')
  groupNameInput.value = ''
}

groupAddBtn.addEventListener('click', showGroupForm)
groupCancelBtn.addEventListener('click', hideGroupForm)

groupNewForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = groupNameInput.value.trim()
  if (!name) {
    groupNameInput.focus()
    return say('分组名不能为空', true)
  }
  const r = await api.createGroup(name)
  if (!r || !r.ok) return say((r && r.error) || '创建分组失败', true)
  hideGroupForm()
  applyState(r)
  say(r.existed ? `已有同名分组「${name}」，已切换过去` : `已创建分组「${name}」`)
})

// ── 图片卡片 ──
function buildCard(item, index, groupId) {
  const role = item.role === 'setup' ? 'setup' : 'pose'
  const card = document.createElement('figure')
  card.className = 'ref' + (role === 'setup' ? ' is-setup' : '')
  card.dataset.id = item.id

  const thumbBox = document.createElement('div')
  thumbBox.className = 'thumb'

  const img = document.createElement('img')
  img.alt = `${ROLE_LABEL[role]}：${item.originalName}`
  img.loading = 'lazy'
  thumbBox.appendChild(img)

  const badge = document.createElement('span')
  badge.className = 'badge ' + role
  badge.textContent = ROLE_LABEL[role]
  thumbBox.appendChild(badge)

  const idx = document.createElement('span')
  idx.className = 'idx'
  idx.textContent = padIdx(index + 1)
  thumbBox.appendChild(idx)

  // AI 重绘产物打标，与用户导入的照片区分开
  if (item.source === 'ai') {
    const ai = document.createElement('span')
    ai.className = 'badge-ai'
    ai.textContent = 'AI 重绘'
    thumbBox.appendChild(ai)
  }

  const del = document.createElement('button')
  del.className = 'del'
  del.type = 'button'
  del.title = `删除「${item.originalName}」`
  del.setAttribute('aria-label', `删除 ${item.originalName}`)
  del.textContent = '✕'
  del.addEventListener('click', async (e) => {
    e.stopPropagation()
    const r = await api.remove(item.id, groupId)
    thumbCache.delete(item.id)
    if (!r.ok) return say(r.error || '删除失败', true)
    applyState(r)
    say(`已删除「${item.originalName}」`)
  })
  thumbBox.appendChild(del)

  const meta = document.createElement('figcaption')
  meta.className = 'meta'

  const nameEl = document.createElement('span')
  nameEl.className = 'name'
  nameEl.textContent = item.originalName
  nameEl.title = item.originalName

  const dimEl = document.createElement('span')
  dimEl.className = 'dim'
  dimEl.textContent = `${item.width}×${item.height} · ${fmtBytes(item.bytes)}`
  meta.appendChild(nameEl)
  meta.appendChild(dimEl)

  // 姿势参考图可一键顶替同组设定图（唯一性由主进程保证）
  if (role === 'pose') {
    const promote = document.createElement('button')
    promote.className = 'promote'
    promote.type = 'button'
    promote.textContent = '设为设定图'
    promote.title = '用这张顶替本组设定图（原设定图自动转为姿势参考，不影响其它分组）'
    promote.addEventListener('click', async (e) => {
      e.stopPropagation()
      const r = await api.setRole(item.id, 'setup', groupId)
      if (!r.ok) return say(r.error || '设置失败', true)
      applyState(r)
      say(`「${item.originalName}」已设为设定图`)
    })
    meta.appendChild(promote)
  }

  card.appendChild(thumbBox)
  card.appendChild(meta)
  return card
}

async function fillThumb(card, id, token) {
  const img = card.querySelector('img')
  if (!img) return
  let url = thumbCache.get(id)
  if (!url) {
    url = await api.thumb(id)
    if (url) thumbCache.set(id, url)
  }
  if (token !== renderToken) return
  if (url) {
    img.src = url
  } else {
    const ph = document.createElement('div')
    ph.className = 'ph'
    ph.textContent = '缩略图不可用'
    img.replaceWith(ph)
  }
}

// ── 主渲染 ──
function applyState(state) {
  if (!state) return
  current = {
    groups: state.groups || [],
    activeGroupId: state.activeGroupId || '',
    items: state.items || [],
    stats: state.stats || { count: 0, bytes: 0, setupCount: 0, poseCount: 0 }
  }
  renderChips()
  renderProfile()
  render()
}

// ── 宠物档案：名字 / 类型 / 品种 / 人格 ──
const pfName = document.getElementById('pfName')
const pfBreed = document.getElementById('pfBreed')
const pfType = document.getElementById('pfType')
const pfTemper = document.getElementById('pfTemper')
const pfSave = document.getElementById('pfSave')
const pfPreset = document.getElementById('pfPreset')
const pfStateEl = document.getElementById('pfState')

const PRESETS = [
  { name: '红苕', petType: '狗', breed: '柯基', temperament: '搞笑', pet: 'redshao-demo' },
  { name: '叮当', petType: '猫', breed: '橘猫', temperament: '傲娇', pet: 'dingdang-demo' }
]

function activeGroup() {
  return (current.groups || []).find((g) => g.id === current.activeGroupId) || null
}

function pickChip(container, value) {
  for (const btn of container.querySelectorAll('button')) {
    btn.setAttribute('aria-checked', btn.dataset.v === value ? 'true' : 'false')
  }
}

function selectedChip(container) {
  const hit = container.querySelector('button[aria-checked="true"]')
  return hit ? hit.dataset.v : ''
}

function renderProfile() {
  const g = activeGroup()
  if (!g) return
  const p = g.profile || {}
  pfName.value = g.name || ''
  pfBreed.value = p.breed || ''
  pickChip(pfType, p.petType || '猫')
  pickChip(pfTemper, p.temperament || '温柔')
  pfStateEl.textContent = p.breed ? `${p.petType || '猫'} · ${p.breed}` : p.petType || ''
}

for (const box of [pfType, pfTemper]) {
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]')
    if (!btn) return
    pickChip(box, btn.dataset.v)
  })
}

pfSave.addEventListener('click', async () => {
  const g = activeGroup()
  if (!g) return say('还没有分组', true)
  pfSave.disabled = true
  try {
    const r = await api.saveProfile(current.activeGroupId, {
      name: pfName.value,
      petType: selectedChip(pfType),
      breed: pfBreed.value,
      temperament: selectedChip(pfTemper)
    })
    if (r && r.items) applyState(r)
    if (!r || !r.ok) return say((r && r.error) || '保存档案失败', true)
    say('宠物档案已保存（装配时会写进 pet.json）')
  } finally {
    pfSave.disabled = false
  }
})

// 预设形象：用项目自带的示例宠物（examples/ 里那两个）快速起一只
pfPreset.addEventListener('click', async () => {
  const installed = (await api.installedPets()) || []
  const usable = PRESETS.filter((p) => installed.includes(p.pet))
  const pick = usable[0] || PRESETS[0]
  if (!installed.includes(pick.pet)) {
    return say(`预设形象需要示例宠物包 ${pick.pet}，当前未安装`, true)
  }
  pfName.value = pick.name
  pfBreed.value = pick.breed
  pickChip(pfType, pick.petType)
  pickChip(pfTemper, pick.temperament)
  const r = await api.activatePet(pick.pet)
  if (r && r.ok) {
    pfStateEl.textContent = `已切换到预设形象：${pick.name}`
    say(`已使用预设形象「${pick.name}」（${pick.petType}·${pick.breed}·${pick.temperament}）`)
    await loadPets()
  } else {
    say((r && r.error) || '切换预设形象失败', true)
  }
})

function render() {
  const items = current.items
  const token = ++renderToken

  countEl.textContent = String(items.length)
  summaryEl.textContent = `设定图 ${current.stats.setupCount || 0} · 姿势参考 ${current.stats.poseCount || 0}`
  usageEl.textContent = `占用 ${fmtBytes(current.stats.bytes)}`
  dropTargetEl.textContent = `导入到「${activeGroupName()}」`
  renderReadiness()

  galleryEl.innerHTML = ''
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = `「${activeGroupName()}」还没有参考图 —— 点击上方 + 导入第一张，它会自动成为这只宠物的设定图。`
    galleryEl.appendChild(empty)
    return
  }

  items.forEach((item, i) => {
    const card = buildCard(item, i, current.activeGroupId)
    galleryEl.appendChild(card)
    fillThumb(card, item.id, token)
  })
}

// ── 导入入口：点 + / 点击上传区 / 键盘 ──
async function pick() {
  if (importing) return
  importing = true
  try {
    const r = await api.pickFiles(current.activeGroupId)
    if (!r) return
    if (r.items) applyState(r)
    const added = r.added || 0
    if (added > 0) {
      const firstBecameSetup = added === 1 && r.stats && r.stats.setupCount === 1
      say(firstBecameSetup ? '已导入 1 张 · 已设为该宠物的设定图' : `已导入 ${added} 张`)
    }
    if (r.errors && r.errors.length) say(r.errors.join('；'), true)
  } finally {
    importing = false
  }
}

dropEl.addEventListener('click', pick)
dropEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    pick()
  }
})

// ── 拖拽导入 ──
// 读成 dataURL 再交给主进程解码：不依赖 webUtils.getPathForFile（跨 Electron 版本稳），
// 也不用裸 TypedArray 穿过 contextBridge（不同版本序列化行为不一致）
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

let dragDepth = 0
dropEl.addEventListener('dragenter', (e) => {
  e.preventDefault()
  dragDepth++
  dropEl.classList.add('over')
})
dropEl.addEventListener('dragover', (e) => {
  e.preventDefault() // 必须阻止默认，否则 drop 不触发
})
dropEl.addEventListener('dragleave', (e) => {
  e.preventDefault()
  if (--dragDepth <= 0) {
    dragDepth = 0
    dropEl.classList.remove('over')
  }
})

dropEl.addEventListener('drop', async (e) => {
  e.preventDefault()
  dragDepth = 0
  dropEl.classList.remove('over')
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
  if (!files.length || importing) return
  importing = true
  try {
    const payload = []
    for (const f of files) {
      payload.push({ name: f.name, dataUrl: await readAsDataURL(f) })
    }
    const r = await api.addFiles(payload, current.activeGroupId)
    if (r && r.items) applyState(r)
    if (r && r.added > 0) say(`已导入 ${r.added} 张`)
    if (r && r.errors && r.errors.length) say(r.errors.join('；'), true)
  } catch (err) {
    say('拖拽导入失败：' + (err && err.message ? err.message : err), true)
  } finally {
    importing = false
  }
})

// ── AI 重绘：就绪度 / 生成 / 设置 ──
// 就绪规则与主进程一致（setup ≥1 且 pose ≥ minPose）；这里只负责显示，真正的闸门在主进程
function renderReadiness() {
  const setup = current.stats.setupCount || 0
  const pose = current.stats.poseCount || 0
  if (!setup) {
    readyEl.className = 'ready warn'
    readyEl.textContent = '还缺设定图'
    return
  }
  if (pose < minPose) {
    readyEl.className = 'ready warn'
    readyEl.textContent = `还差 ${minPose - pose} 张姿势参考图`
    return
  }
  readyEl.className = 'ready ok'
  readyEl.textContent = `重绘就绪 · 设定图 ${setup} / 姿势参考 ${pose}`
}

function setBusy(on) {
  busy = on
  redrawBtn.classList.toggle('is-busy', on)
  redrawBtn.textContent = on ? '取消生成' : '🎨 重绘设定图'
}

async function doRedraw() {
  if (busy) {
    await api.cancelGenerate()
    say('正在取消…')
    return
  }
  if (!ark || !ark.configured) {
    openSettings()
    say('请先配置 API Key（填入后点保存）', true)
    return
  }
  setBusy(true)
  say('正在生成，约需 20 秒…')
  try {
    const r = await api.generate(current.activeGroupId)
    if (r && r.items) applyState(r)
    if (!r || !r.ok) {
      say((r && r.error) || '重绘失败', true)
      if (r && r.needKey) openSettings()
      return
    }
    say(`已生成「${r.item.originalName}」，可在卡片上设为设定图`)
  } catch (e) {
    say('重绘失败：' + (e && e.message ? e.message : e), true)
  } finally {
    setBusy(false)
  }
}

redrawBtn.addEventListener('click', doRedraw)

function openSettings() {
  arkPanel.classList.remove('hidden')
  gearBtn.setAttribute('aria-expanded', 'true')
  arkKeyInput.focus()
}

function toggleSettings() {
  const opening = arkPanel.classList.contains('hidden')
  arkPanel.classList.toggle('hidden', !opening)
  gearBtn.setAttribute('aria-expanded', String(opening))
  if (opening) arkKeyInput.focus()
}

gearBtn.addEventListener('click', toggleSettings)

// 读取脱敏后的生成配置（主进程从不回传密钥明文）
async function loadArk() {
  try {
    ark = await api.arkStatus()
  } catch {
    ark = null
    return
  }
  if (!ark) return
  minPose = ark.minPose || 3
  arkKeyInput.value = ''
  arkKeyInput.placeholder = ark.configured
    ? `已配置 ${ark.masked}（留空保持不变）`
    : 'ark-…（仅保存在本机，不回显）'
  arkStateEl.textContent = ark.configured ? `已配置 ${ark.masked}` : '未配置'
  arkStateEl.className = 'ark-state' + (ark.configured ? ' ok' : '')
  arkBaseSel.value = ark.baseUrlKind || 'standard'
  arkModelInput.value = ark.model || ''
  arkVideoModelInput.value = ark.videoModel || ''
  arkStyleSel.value = ark.style
  renderReadiness()
}

arkPanel.addEventListener('submit', async (e) => {
  e.preventDefault()
  const patch = {
    baseUrl: (ark && ark.presets && ark.presets[arkBaseSel.value]) || arkBaseSel.value,
    model: arkModelInput.value.trim(),
    videoModel: arkVideoModelInput.value.trim(),
    style: arkStyleSel.value
  }
  const key = arkKeyInput.value.trim()
  if (key) patch.apiKey = key // 留空 = 不改动已保存的密钥
  try {
    const r = await api.arkSave(patch)
    if (!r || !r.ok) {
      say((r && r.error) || '保存失败', true)
      return
    }
    ark = r.status
    if (ark) minPose = ark.minPose || minPose
    say('生成设置已保存')
    await loadArk()
  } catch (err) {
    say('保存失败：' + (err && err.message ? err.message : err), true)
  }
})

// ── 动画绘制：Seedance 云端出视频 → 本地抽帧/抠图/拼表 ──
let animBusy = false
const STAGE_LABEL = {
  submit: '提交任务…',
  poll: '云端渲染中',
  download: '下载视频…',
  extract: '抽帧拼表…'
}

api.onAnimProgress((p) => {
  if (!animBusy || !p) return
  if (p.stage === 'poll') {
    animBtn.textContent = `${STAGE_LABEL.poll} ${Math.round((p.elapsedMs || 0) / 1000)}s`
  } else {
    animBtn.textContent = STAGE_LABEL[p.stage] || '生成中…'
  }
})

function setAnimBusy(on) {
  animBusy = on
  animBtn.classList.toggle('is-busy', on)
  animBtn.textContent = on ? '取消生成' : '🎬 生成动画'
}

// 精灵表预览：直接用 CSS 步进播放整张横向表，不用解码视频
function showAnimPreview(res) {
  const frames = res.frames || 12
  const cell = res.cell || 480
  const fps = (res.spec && res.spec.fps) || 5
  animStrip.style.setProperty('--frames', String(frames))
  animStrip.style.setProperty('--dur', `${Math.max(0.6, frames / fps).toFixed(2)}s`)
  animStrip.style.backgroundSize = `calc(${frames} * 96px) 96px`
  animStrip.style.backgroundImage = `url(${res.preview})`
  animTitle.textContent = `动画已生成：${res.spec && res.spec.label ? res.spec.label : ''} · ${frames} 帧 · 单帧 ${cell}px`
  animPath.textContent = res.sheetPath || ''
  animPreview.classList.remove('hidden')
}

async function doAnim() {
  if (animBusy) {
    await api.cancelAnim()
    say('正在取消…')
    return
  }
  if (!ark || !ark.configured) {
    openSettings()
    say('请先配置 API Key（填入后点保存）', true)
    return
  }
  setAnimBusy(true)
  say('正在生成动画：云端渲染通常 1-3 分钟，请稍候…')
  try {
    const r = await api.generateAnim(current.activeGroupId, { action: animActionSel.value })
    if (r && r.items) applyState(r)
    if (!r || !r.ok) {
      say((r && r.error) || '生成动画失败', true)
      if (r && r.needKey) openSettings()
      return
    }
    showAnimPreview(r)
    say('动画已生成并保存到本地')
  } catch (e) {
    say('生成动画失败：' + (e && e.message ? e.message : e), true)
  } finally {
    setAnimBusy(false)
  }
}

animBtn.addEventListener('click', doAnim)

// ── 桌宠：装配当前分组 / 切换已装配的桌宠 ──
const petSelect = document.getElementById('petSelect')
const petSwitchBtn = document.getElementById('petSwitch')
const petAssembleBtn = document.getElementById('petAssemble')
const petNowEl = document.getElementById('petNow')

async function loadPets() {
  try {
    const [installed, cur] = await Promise.all([api.installedPets(), api.currentPet()])
    petSelect.innerHTML = ''
    for (const id of installed || []) {
      const opt = document.createElement('option')
      opt.value = id
      opt.textContent = id === (cur && cur.id) ? `${id}（当前）` : id
      if (cur && id === cur.id) opt.selected = true
      petSelect.appendChild(opt)
    }
    if (!installed || !installed.length) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '（还没有已装配的桌宠）'
      petSelect.appendChild(opt)
    }
    petNowEl.textContent = cur && cur.id ? `当前桌宠：${cur.name || cur.id}` : '当前桌宠：未加载'
  } catch {
    petNowEl.textContent = '当前桌宠：读取失败'
  }
}

petSwitchBtn.addEventListener('click', async () => {
  const id = petSelect.value
  if (!id) return say('还没有可切换的桌宠', true)
  const r = await api.activatePet(id)
  if (!r || !r.ok) return say((r && r.error) || '切换失败', true)
  say(`已切换到「${id}」`)
  await loadPets()
})

// 免费重抽：用已下载的 mp4 重新生成精灵表（不消耗视频额度，用于排查抽帧问题）
const petReextractBtn = document.getElementById('petReextract')
petReextractBtn.addEventListener('click', async () => {
  petReextractBtn.disabled = true
  const old = petReextractBtn.textContent
  petReextractBtn.textContent = '抽帧中…'
  say('正在用本地视频重新抽帧…')
  try {
    // 传空串：主进程会按当前分组推断动画目录
    const r = await api.reextractAnim('', animActionSel.value)
    if (!r || !r.ok) {
      say((r && r.error) || '重抽失败', true)
      return
    }
    say(`重抽完成：${r.frames} 帧 × ${r.cell}px（${r.keyMode} 模式）`)
  } catch (e) {
    say('重抽失败：' + (e && e.message ? e.message : e), true)
  } finally {
    petReextractBtn.disabled = false
    petReextractBtn.textContent = old
  }
})

petAssembleBtn.addEventListener('click', async () => {
  petAssembleBtn.disabled = true
  say('正在装配当前分组的动画素材…')
  try {
    const r = await api.assemblePet(current.activeGroupId)
    if (!r || !r.ok) {
      say((r && r.error) || '装配失败', true)
      return
    }
    say(`已装配为桌宠「${r.name || r.petId}」，动作：${(r.actions || []).join(' / ')}`)
    await loadPets()
  } catch (e) {
    say('装配失败：' + (e && e.message ? e.message : e), true)
  } finally {
    petAssembleBtn.disabled = false
  }
})

// ── 关闭 ──
document.getElementById('close').addEventListener('click', () => api.close())
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  // 正在填分组名 / 打开生成设置时，Esc 先收起当前面板，不直接关窗口
  if (!arkPanel.classList.contains('hidden')) {
    toggleSettings()
    return
  }
  if (!groupNewForm.classList.contains('hidden')) {
    hideGroupForm()
    return
  }
  api.close()
})

// ── 启动：拉取库内现状（无分组时主进程会自动建一个默认分组） ──
;(async () => {
  try {
    const s = await api.state()
    applyState(s)
  } catch (err) {
    say('读取参考图库失败：' + (err && err.message ? err.message : err), true)
  }
  await loadArk()
  await loadPets()
})()
