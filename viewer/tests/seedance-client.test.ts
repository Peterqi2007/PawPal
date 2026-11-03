// seedance-client 测试（对应 viewer/seedance-client.cjs）
// 官方任务式 API：建任务 → 轮询 → 下载。全部注入假 fetch，不打真接口。
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MODEL,
  buildTaskBody,
  buildVideoPrompt,
  createSeedanceClient,
  mapHttpError,
  parseTaskCreated,
  parseTaskStatus
} from '../seedance-client.cjs'

const CFG = {
  apiKey: 'ark-test-key',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3'
}

const IMG = 'data:image/jpeg;base64,/9j/AAAA'

function mockFetch(handler: (url: string, init: any) => any) {
  const calls: Array<{ url: string; init: any }> = []
  const fetchImpl = async (url: string, init: any = {}) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fetchImpl, calls }
}

const jsonRes = (status: number, body: any) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
})

describe('请求体（官方字段）', () => {
  it('content 为 text + image_url 数组，image 支持 data URI', () => {
    const body = buildTaskBody({
      model: DEFAULT_MODEL,
      prompt: '待机',
      imageDataUri: IMG,
      duration: 5
    }) as any
    expect(body.model).toBe(DEFAULT_MODEL)
    expect(body.content[0]).toEqual({ type: 'text', text: '待机' })
    expect(body.content[1].type).toBe('image_url')
    expect(body.content[1].image_url.url).toBe(IMG)
    expect(body.duration).toBe(5)
    expect(body.resolution).toBe('720p')
    expect(body.watermark).toBe(true)
  })

  it('无参考图时只有 text（纯文生视频）', () => {
    const body = buildTaskBody({ model: 'm', prompt: 'p' }) as any
    expect(body.content).toHaveLength(1)
  })

  it('视频提示词：全身入镜 + 头顶留白 + 摄像机静止 + 纯绿背景', () => {
    const p = buildVideoPrompt({ actionDesc: '前爪前伸→弓背→打哈欠', style: '写实风格' })
    expect(p).toContain('前爪前伸→弓背→打哈欠')
    expect(p).toContain('全身完整入镜')
    expect(p).toContain('头顶上方留出明显空白')
    expect(p).toContain('四爪')
    expect(p).toContain('摄像机完全静止')
    expect(p).toContain('地面无投影')
    expect(p).toContain('不出现任何影子')
    expect(p).toContain('#00C800')
    expect(p).toContain('无渐变')
    expect(p).toContain('无阴影')
    for (const bad of ['不要', '别', '避免', '禁止']) expect(p).not.toContain(bad)
  })
})

describe('响应解析', () => {
  it('建任务响应提取任务 ID（兼容 id / task_id / data.id）', () => {
    expect(parseTaskCreated({ id: 'cgt-1' }).taskId).toBe('cgt-1')
    expect(parseTaskCreated({ task_id: 'cgt-2' }).taskId).toBe('cgt-2')
    expect(parseTaskCreated({ data: { id: 'cgt-3' } }).taskId).toBe('cgt-3')
    expect(parseTaskCreated({}).ok).toBe(false)
  })

  it('轮询状态：running 未完成，succeeded 带视频地址，failed 带原因', () => {
    expect(parseTaskStatus({ status: 'running' }).done).toBe(false)
    const done = parseTaskStatus({ status: 'succeeded', content: { video_url: 'https://v/1.mp4' } })
    expect(done.done).toBe(true)
    expect(done.videoUrl).toBe('https://v/1.mp4')
    expect(parseTaskStatus({ status: 'failed', error: { message: '内容审核不通过' } }).error).toContain('审核')
    expect(parseTaskStatus({ status: 'succeeded', content: {} }).ok).toBe(false)
  })

  it('错误映射：Agent Plan 不支持视频时给出可操作提示', () => {
    const msg = mapHttpError(
      404,
      JSON.stringify({
        error: {
          code: 'UnsupportedModel',
          message: 'The requested model does not support the agent plan feature.'
        }
      })
    )
    expect(msg).toContain('Agent/Coding Plan')
    expect(msg).toContain('Seedance')
    expect(mapHttpError(401, '')).toContain('/api/plan/v3')
    expect(mapHttpError(500, '')).toContain('稍后')
  })
})

describe('客户端编排', () => {
  it('建任务：POST 到 /contents/generations/tasks，带 Bearer', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonRes(200, { id: 'cgt-9', status: 'queued' }))
    const client = createSeedanceClient({ fetchImpl })
    const r = await client.createTask({ cfg: CFG, body: { model: 'm' } })
    expect(r.ok).toBe(true)
    expect(r.taskId).toBe('cgt-9')
    expect(calls[0].url).toBe(`${CFG.baseUrl}/contents/generations/tasks`)
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${CFG.apiKey}`)
  })

  it('未配置密钥 → 直接报错，不发请求', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonRes(200, {}))
    const client = createSeedanceClient({ fetchImpl })
    const r = await client.createTask({ cfg: { ...CFG, apiKey: '' }, body: {} })
    expect(r.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('轮询直到 succeeded，并把状态变化回调出去', async () => {
    let n = 0
    const { fetchImpl } = mockFetch(() => {
      n++
      if (n < 3) return jsonRes(200, { status: 'running' })
      return jsonRes(200, { status: 'succeeded', content: { video_url: 'https://v/x.mp4' } })
    })
    const client = createSeedanceClient({ fetchImpl })
    const seen: string[] = []
    // intervalMs 设为 0：测试里不真的等
    const r = await client.poll({ cfg: CFG, taskId: 't1', intervalMs: 0, onProgress: (p) => seen.push(p.status) })
    expect(r.ok).toBe(true)
    expect(r.videoUrl).toBe('https://v/x.mp4')
    expect(seen.length).toBeGreaterThan(0)
  })

  it('轮询超时给出明确提示', async () => {
    const { fetchImpl } = mockFetch(() => jsonRes(200, { status: 'running' }))
    let t = 0
    const client = createSeedanceClient({ fetchImpl, now: () => (t += 1000) })
    const r = await client.poll({ cfg: CFG, taskId: 't1', intervalMs: 0, timeoutMs: 2500 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('超时')
    expect(r.error).toContain('t1') // 超时必须带上 taskId，否则事后无从追查（真实踩过：任务仍在云端跑却丢了 id）
  })

  it('下载视频字节', async () => {
    const { fetchImpl } = mockFetch(() => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer
    }))
    const client = createSeedanceClient({ fetchImpl })
    const r = await client.download({ url: 'https://v/x.mp4' })
    expect(r.ok).toBe(true)
    expect(Array.from(r.buffer)).toEqual([9, 8, 7])
  })
})
