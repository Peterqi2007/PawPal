// seedream-client 测试（对应 viewer/seedream-client.cjs）
// 全部注入假 fetch / 假编码器：不打真接口、不需要密钥、不产生费用
import { describe, it, expect } from 'vitest'
import {
  MAX_POSES,
  MAX_REFS,
  MIN_POSE,
  buildPrompt,
  buildRequestBody,
  createSeedreamClient,
  evaluateReadiness,
  mapHttpError,
  parseResponse,
  pickReferences
} from '../seedream-client.cjs'

const CFG = {
  apiKey: 'ark-test-key',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  model: 'doubao-seedream-5-0-pro',
  style: '皮克斯3D卡通风格'
}

const PNG_1PX =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

function makeItems(setup: number, pose: number) {
  const items: Array<{ role: string; file: string }> = []
  for (let i = 0; i < setup; i++) items.push({ role: 'setup', file: `setup-${i}.png` })
  for (let i = 0; i < pose; i++) items.push({ role: 'pose', file: `pose-${i}.png` })
  return items
}

function okFetch(payload: unknown) {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = []
  const fetchImpl = async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url, init })
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
  }
  return { fetchImpl, calls }
}

describe('就绪闸门（产品规则）', () => {
  it('没有设定图 → 拒绝并提示补设定图', () => {
    const r = evaluateReadiness({ setupCount: 0, poseCount: 5 })
    expect(r.ready).toBe(false)
    expect(r.reason).toMatch(/设定图/)
  })

  it('姿势参考图不足 3 张 → 拒绝并给出还差几张', () => {
    const r = evaluateReadiness({ setupCount: 1, poseCount: MIN_POSE - 1 })
    expect(r.ready).toBe(false)
    expect(r.reason).toContain('还差 1 张')
  })

  it('设定图 1 张 + 姿势参考 3 张 → 就绪', () => {
    expect(evaluateReadiness({ setupCount: 1, poseCount: MIN_POSE }).ready).toBe(true)
    expect(evaluateReadiness({ setupCount: 1, poseCount: 9 }).ready).toBe(true)
  })
})

describe('请求体构造', () => {
  it('提示词遵守铁律：不含否定词', () => {
    const p = buildPrompt({ style: '写实风格', petName: '豆豆' })
    expect(p).toContain('写实风格')
    expect(p).toContain('豆豆')
    for (const bad of ['不要', '别', '避免', '禁止', '不能']) {
      expect(p).not.toContain(bad)
    }
  })

  it('参考图选取：1 张设定图 + 最多 3 张姿势参考', () => {
    const items = makeItems(1, 10)
    const picked = pickReferences(items)
    expect(picked).toHaveLength(MAX_REFS)
    expect(picked[0].role).toBe('setup')
    expect(picked.filter((p) => p.role === 'pose')).toHaveLength(MAX_POSES)
  })

  it('请求体关键字段：数组 image / b64_json / watermark / 2K', () => {
    const body = buildRequestBody({
      model: CFG.model,
      prompt: 'p',
      imageDataUris: [PNG_1PX, PNG_1PX]
    }) as Record<string, unknown>
    expect(Array.isArray(body.image)).toBe(true)
    expect((body.image as string[]).length).toBe(2)
    expect(body.response_format).toBe('b64_json')
    expect(body.watermark).toBe(true)
    expect(body.size).toBe('2K')
    expect(body.output_format).toBe('png')
  })
})

describe('响应解析与错误映射', () => {
  it('b64_json 解析成 Buffer', () => {
    const r = parseResponse({
      data: [{ b64_json: Buffer.from('hello').toString('base64'), size: '2048x2048' }],
      usage: { generated_images: 1 }
    })
    expect(r.ok).toBe(true)
    expect(r.buffer?.toString()).toBe('hello')
    expect(r.size).toBe('2048x2048')
  })

  it('缺少 b64_json / 单张 error 都给出可读错误', () => {
    expect(parseResponse({ data: [{}] }).ok).toBe(false)
    expect(parseResponse({ data: [{ error: { message: '内容审核不通过' } }] }).error).toContain('审核')
    expect(parseResponse({}).ok).toBe(false)
  })

  it('HTTP 状态映射：401 提示 Plan 端点，429/5xx 提示稍后重试', () => {
    expect(mapHttpError(401, '{"error":{"message":"bad key"}}')).toContain('plan')
    expect(mapHttpError(429, '')).toContain('稍后')
    expect(mapHttpError(500, '')).toContain('稍后')
    expect(mapHttpError(404, '')).toContain('模型')
  })
})

describe('客户端编排（注入假 fetch）', () => {
  const encode = () => PNG_1PX

  it('未配置密钥 → 直接返回错误，不发请求', async () => {
    const { fetchImpl, calls } = okFetch({ data: [] })
    const client = createSeedreamClient({ fetchImpl, encodeImage: encode })
    const r = await client.generate({ cfg: { ...CFG, apiKey: '' }, items: makeItems(1, 3), imagesDir: '/x' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/API Key/)
    expect(calls).toHaveLength(0)
  })

  it('闸门不过 → blocked，且一次网络都不发', async () => {
    const { fetchImpl, calls } = okFetch({ data: [] })
    const client = createSeedreamClient({ fetchImpl, encodeImage: encode })
    const r = await client.generate({
      cfg: CFG,
      items: makeItems(1, MIN_POSE - 1),
      imagesDir: '/x'
    })
    expect(r.ok).toBe(false)
    expect(r.blocked).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('dryRun 只返回请求体，不发网络', async () => {
    const { fetchImpl, calls } = okFetch({ data: [] })
    const client = createSeedreamClient({ fetchImpl, encodeImage: encode })
    const r = await client.generate({
      cfg: CFG,
      items: makeItems(1, 3),
      imagesDir: '/x',
      dryRun: true
    })
    expect(r.ok).toBe(true)
    expect(r.dryRun).toBe(true)
    expect(r.meta?.url).toBe(`${CFG.baseUrl}/images/generations`)
    expect(calls).toHaveLength(0)
  })

  it('成功路径：URL、Authorization、参考图数量都正确', async () => {
    const payload = {
      data: [{ b64_json: Buffer.from('img-bytes').toString('base64') }],
      usage: { input_images: 4, generated_images: 1 }
    }
    const { fetchImpl, calls } = okFetch(payload)
    const client = createSeedreamClient({ fetchImpl, encodeImage: encode })
    const r = await client.generate({ cfg: CFG, petName: '豆豆', items: makeItems(1, 6), imagesDir: '/x' })

    expect(r.ok).toBe(true)
    expect(r.buffer?.toString()).toBe('img-bytes')
    expect(r.usage?.generated_images).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${CFG.baseUrl}/images/generations`)
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${CFG.apiKey}`)
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.image).toHaveLength(MAX_REFS) // 设定图 1 + 姿势参考 3
    expect(body.prompt).toContain('豆豆')
  })

  it('401 走中文提示，且不抛异常', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"The API key or AK/SK in the request is missing or invalid."}}'
    })
    const client = createSeedreamClient({ fetchImpl, encodeImage: encode })
    const r = await client.generate({ cfg: CFG, items: makeItems(1, 3), imagesDir: '/x' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('/api/plan/v3')
  })

  it('参考图全部读不出来 → 明确报错，不发请求', async () => {
    const { fetchImpl, calls } = okFetch({ data: [] })
    const client = createSeedreamClient({ fetchImpl, encodeImage: () => null })
    const r = await client.generate({ cfg: CFG, items: makeItems(1, 3), imagesDir: '/x' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/参考图/)
    expect(calls).toHaveLength(0)
  })
})
