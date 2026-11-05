// ark-config 测试（对应 viewer/ark-config.cjs）
// 覆盖：优先级（环境变量 > 文件 > 默认）、0600 落盘、密钥遮蔽、端点纠错、模型别名
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  BASE_PLAN,
  BASE_STANDARD,
  DEFAULTS,
  baseUrlKind,
  loadConfig,
  maskKey,
  normalizeBaseUrl,
  publicStatus,
  resolveModel,
  saveConfig
} from '../ark-config.cjs'

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petpet-ark-'))
  file = path.join(dir, 'ark.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('默认视频模型', () => {
  it('videoModel 默认用 fast 档（等待时间优先）', () => {
    expect(DEFAULTS.videoModel).toBe('doubao-seedance-2-0-fast-260128')
  })
})

describe('配置优先级与落盘', () => {
  it('无文件、无环境变量时返回默认值', () => {
    const cfg = loadConfig(file, {})
    expect(cfg.apiKey).toBe('')
    expect(cfg.baseUrl).toBe(BASE_STANDARD)
    expect(cfg.model).toBe(DEFAULTS.model)
    expect(cfg.style).toBe(DEFAULTS.style)
  })

  it('保存后以 0600 权限落盘，并能读回', () => {
    saveConfig(file, { apiKey: 'ark-test-1234567890', model: 'flash', style: '写实风格' })
    const cfg = loadConfig(file, {})
    expect(cfg.apiKey).toBe('ark-test-1234567890')
    expect(cfg.model).toBe('doubao-seedream-5-0-flash-260915')
    expect(cfg.style).toBe('写实风格')
    if (process.platform !== 'win32') {
      // Windows 上 chmod 语义不同，只在 POSIX 断言
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    }
  })

  it('环境变量优先于配置文件', () => {
    saveConfig(file, { apiKey: 'from-file', model: 'flash' })
    const cfg = loadConfig(file, { ARK_API_KEY: 'from-env', ARK_MODEL: 'pro', ARK_BASE_URL: BASE_PLAN })
    expect(cfg.apiKey).toBe('from-env')
    expect(cfg.model).toBe('doubao-seedream-5-0-pro-260628')
    expect(cfg.baseUrl).toBe(BASE_PLAN)
  })

  it('留空 apiKey 时保留已保存的密钥（面板「留空保持不变」的语义）', () => {
    saveConfig(file, { apiKey: 'keep-me' })
    saveConfig(file, { apiKey: '', style: '2D动漫风格' })
    expect(loadConfig(file, {}).apiKey).toBe('keep-me')
    expect(loadConfig(file, {}).style).toBe('2D动漫风格')
  })

  it('配置文件损坏时按默认值处理，不抛错', () => {
    fs.writeFileSync(file, '{ not json ,,,')
    const cfg = loadConfig(file, {})
    expect(cfg.baseUrl).toBe(BASE_STANDARD)
  })
})

describe('端点与模型纠错', () => {
  it('剥掉误贴的 /images/generations 尾巴（否则会双拼成 404）', () => {
    expect(normalizeBaseUrl(`${BASE_PLAN}/images/generations`)).toBe(BASE_PLAN)
    expect(normalizeBaseUrl(`${BASE_STANDARD}/images/generations/`)).toBe(BASE_STANDARD)
    expect(normalizeBaseUrl(`${BASE_STANDARD}/`)).toBe(BASE_STANDARD)
  })

  it('非 http(s) 输入回落到默认端点', () => {
    expect(normalizeBaseUrl('ftp://x')).toBe(BASE_STANDARD)
    expect(normalizeBaseUrl('')).toBe(BASE_STANDARD)
  })

  it('端点分档判定（面板回显标准 / Plan）', () => {
    expect(baseUrlKind(BASE_STANDARD)).toBe('standard')
    expect(baseUrlKind(BASE_PLAN)).toBe('plan')
    expect(baseUrlKind(`${BASE_PLAN}/images/generations`)).toBe('plan')
  })

  it('模型短别名映射到真实 ID（带日期后缀），手填 ID 原样保留', () => {
    expect(resolveModel('pro')).toBe('doubao-seedream-5-0-pro-260628')
    expect(resolveModel('flash')).toBe('doubao-seedream-5-0-flash-260915')
    // 旧的、无日期后缀的写法会被规范化
    expect(resolveModel('doubao-seedream-5-0-pro')).toBe('doubao-seedream-5-0-pro-260628')
    expect(resolveModel('doubao-seedream-4-5')).toBe('doubao-seedream-4-5')
    expect(resolveModel('ep-20250101-abcde')).toBe('ep-20250101-abcde')
    expect(resolveModel('奇怪 的 输入')).toBe(DEFAULTS.model)
  })

  it('视频模型走独立的别名表（图片别名不会串到视频上）', () => {
    expect(resolveModel('fast', 'video')).toBe('doubao-seedance-2-0-fast-260128')
    expect(resolveModel('mini', 'video')).toBe('doubao-seedance-2-0-mini-260615')
    expect(resolveModel('2-5', 'video')).toBe('doubao-seedance-2-5-260628')
    // 关键回归：'flash' 是生图别名，视频侧必须落到视频默认值，而不是生图模型
    expect(resolveModel('flash', 'video')).toBe(DEFAULTS.videoModel)
    expect(resolveModel('pro', 'video')).toBe(DEFAULTS.videoModel)
    expect(resolveModel('', 'video')).toBe(DEFAULTS.videoModel)
    // 反向：视频别名填进生图字段也不能串
    expect(resolveModel('fast')).toBe(DEFAULTS.model)
  })

  it('历史配置里被存成生图 ID 的视频模型会被纠正回视频默认值', () => {
    expect(resolveModel('doubao-seedream-5-0-flash-260915', 'video')).toBe(DEFAULTS.videoModel)
    expect(resolveModel('doubao-seedance-2-0-fast-260128')).toBe(DEFAULTS.model)
  })

  it('原型链上的键不会被当成模型别名（不能返回函数）', () => {
    const a = resolveModel('toString')
    const b = resolveModel('constructor', 'video')
    // 别名表查不到 → 按「手填 ID 原样保留」处理，但绝不能把 Object.prototype 上的函数当模型 ID
    expect(typeof a).toBe('string')
    expect(typeof b).toBe('string')
    expect(a).toBe('toString')
    expect(b).toBe('constructor')
  })

  it('保存视频模型时同样做别名解析', () => {
    saveConfig(file, { videoModel: 'mini' })
    expect(loadConfig(file, {}).videoModel).toBe('doubao-seedance-2-0-mini-260615')
  })
})

describe('密钥不外泄', () => {
  it('遮蔽只留头尾', () => {
    expect(maskKey('')).toBe('')
    expect(maskKey('short')).toBe('sho…')
    expect(maskKey('ark-deb3769c-ce33-4984-9f01-c9799f231673-b8df0')).toBe('ark-deb…8df0')
  })

  it('publicStatus 返回的对象里不含 apiKey 明文', () => {
    const cfg = loadConfig(file, { ARK_API_KEY: 'ark-super-secret-value' })
    const status = publicStatus(cfg)
    const json = JSON.stringify(status)
    expect(json).not.toContain('super-secret-value')
    expect(status.configured).toBe(true)
    expect(status.masked).toContain('…')
    expect(Object.keys(status)).not.toContain('apiKey')
  })
})
