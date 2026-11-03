// B-2 状态胶囊 / 今日状态面板的视图模型（纯函数，node 直测）
//
// 为什么单独抽出来：胶囊窗里的 DOM 渲染不好测，但"显示什么、显示成什么颜色/文字"
// 全是纯计算——放这里就能把边界（空态、封顶、专注态）用单测钉死。
'use strict'

const { formatCountdown, remainingMs, focusProgress } = require('./focus-session.cjs')

const CHECKIN_MAX = 3 // 与前 3 次打卡计分一致：显示 min(n,3)/3
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 本地日期标签：`11 / 03 周一` */
function dateLabel(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(now.getMonth() + 1)} / ${p(now.getDate())} ${WEEKDAYS[now.getDay()]}`
}

function clampPct(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.min(100, Math.max(0, Math.round(v)))
}

/**
 * 组装胶囊要显示的全部内容。
 * @param {object} input
 * @param {object|null} input.stats   数值（可为空 → 空态）
 * @param {object|null} input.focus   专注会话（可为空）
 * @param {object|null} input.pet     { id, name }
 * @param {number} [input.now]
 * @param {Date}   [input.date]       仅测试注入
 */
function buildCapsuleModel(input = {}) {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now()
  const stats = input.stats && typeof input.stats === 'object' ? input.stats : null
  const pet = input.pet && typeof input.pet === 'object' ? input.pet : null
  const focus = input.focus && typeof input.focus === 'object' ? input.focus : null
  const avatar = input.avatar && typeof input.avatar === 'object' ? input.avatar : null
  const remain = focus ? remainingMs(focus.endAt, now) : 0
  const focusing = !!focus && remain > 0

  const checkins = stats ? Math.max(0, Math.floor(Number(stats.checkins) || 0)) : 0
  const shownCheckins = Math.min(checkins, CHECKIN_MAX)
  const mood = stats ? clampPct(stats.mood) : 0
  const satiety = stats ? clampPct(stats.satiety) : 0

  return {
    hasPet: !!pet,
    hasStats: !!stats,
    petId: pet && pet.id ? String(pet.id) : '',
    name: (pet && pet.name) || '还没有宠物',
    // 头像：精灵表首帧（胶囊用 background-position 取第 1 帧，不需要新素材）
    avatarUrl: avatar && avatar.url ? String(avatar.url) : '',
    avatarFrames: avatar && Number(avatar.frames) > 0 ? Math.floor(Number(avatar.frames)) : 1,
    dateLabel: dateLabel(input.date instanceof Date ? input.date : new Date(now)),
    // 数值
    mood,
    satiety,
    moodText: stats ? `${mood}` : '—',
    satietyText: stats ? `${satiety}` : '—',
    // 打卡：显示 min(n,3)/3，超出部分只体现在提示里
    checkins,
    checkinText: `${shownCheckins}/${CHECKIN_MAX}`,
    checkinDots: [0, 1, 2].map((i) => i < shownCheckins),
    checkinOverflow: Math.max(0, checkins - CHECKIN_MAX),
    // 专注
    focusing,
    focusText: focusing ? `FOCUS ${formatCountdown(remain)}` : '',
    focusRemainText: focusing ? formatCountdown(remain) : '',
    focusProgress: focusing ? focusProgress(focus, now) : 0,
    // 顶栏状态点：专注中 > 有未完成打卡 > 正常
    statusDot: focusing ? 'focus' : checkins < CHECKIN_MAX ? 'pending' : 'idle',
    // 空态文案
    emptyHint: pet ? '' : '还没有宠物 · 右键宠物 → 切换宠物'
  }
}

module.exports = { buildCapsuleModel, dateLabel, clampPct, CHECKIN_MAX, WEEKDAYS }
