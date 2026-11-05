// model-params 测试（对应 viewer/model-params.cjs）
// 覆盖：模型能力档案 / 请求体预检 / 400 参数错误解析 / 省略重试辅助函数
// 这些用例的目的很直接：不同模型支持的参数不同，任何一条规则被改坏，
// 都要在「发请求之前」或「收到 400 之后」被这里拦住。
import { describe, it, expect } from 'vitest'
import {
  MAX_PARAM_RETRIES,
  VIDEO_DROPPABLE,
  buildImageBody,
  buildVideoBody,
  describeNotes,
  dropParam,
  isValidImageSize,
  nextDropCandidate,
  normalizeDuration,
  parseRejectedParam,
  videoModelProfile
} from '../model-params.cjs'

const IMG = 'data:image/jpeg;base64,/9j/AAAA'
const MODEL_2_0 = 'doubao-seedance-2-0-fast-260128'

const noteNames = (notes: Array<{ param: string }>) => notes.map((n) => n.param)

describe('视频模型能力档案', () => {
  it('按模型 ID 识别家族', () => {
    expect(videoModelProfile(MODEL_2_0).family).toBe('seedance-2-0')
    expect(videoModelProfile('doubao-seedance-2-5-260628').family).toBe('seedance-2-5')
    expect(videoModelProfile('doubao-seedance-1-0-pro-250528').family).toBe('seedance-1-x')
    expect(videoModelProfile('some-other-video-model').family).toBe('unknown')
    expect(videoModelProfile(undefined).family).toBe('unknown')
  })

  it('所有家族都遵守「首帧图生视频比例跟随首帧图」，未知模型按同一保守规则', () => {
    for (const id of [MODEL_2_0, 'doubao-seedance-2-5-260628', 'x-unknown']) {
      expect(videoModelProfile(id).ratioWithImage).toBe(false)
    }
  })

  it('只在确认支持的家族上放开 seed / camera_fixed', () => {
    expect(videoModelProfile(MODEL_2_0).supportsSeed).toBe(true)
    expect(videoModelProfile('x-unknown').supportsSeed).toBe(false)
    expect(videoModelProfile('doubao-seedance-1-0-pro-250528').supportsCameraFixed).toBe(true)
    expect(videoModelProfile(MODEL_2_0).supportsCameraFixed).toBe(false)
  })
})

describe('视频请求体：首帧图生视频', () => {
  it('带首帧图时绝不传 ratio（调用方没指定也一样）', () => {
    const { body, notes } = buildVideoBody({ model: MODEL_2_0, prompt: '待机', imageDataUri: IMG })
    expect(body.ratio).toBeUndefined()
    expect(notes).toHaveLength(0) // 没指定就没什么可说明的
    expect(body.content).toHaveLength(2)
  })

  it('显式传了 ratio 会被省略，并留下可追溯的 note', () => {
    const { body, notes } = buildVideoBody({ model: MODEL_2_0, prompt: '待机', imageDataUri: IMG, ratio: '16:9' })
    expect(body.ratio).toBeUndefined()
    expect(noteNames(notes)).toContain('ratio')
    expect(notes[0].action).toBe('drop')
    expect(notes[0].detail).toContain('首帧')
  })

  it('纯文生视频才带 ratio，默认方画幅', () => {
    const { body } = buildVideoBody({ model: MODEL_2_0, prompt: '待机' })
    expect(body.ratio).toBe('1:1')
    expect(body.content).toHaveLength(1)
  })
})

describe('视频请求体：取值净化', () => {
  it('非法 duration 不发送，并记录原因', () => {
    const { body, notes } = buildVideoBody({ model: MODEL_2_0, prompt: 'p', duration: 'abc' })
    expect(body.duration).toBeUndefined()
    expect(noteNames(notes)).toContain('duration')
  })

  it('duration 只做物理边界钳制，不猜模型支持的档位', () => {
    expect(normalizeDuration(5)).toBe(5)
    expect(normalizeDuration('7.6')).toBe(8)
    expect(normalizeDuration(999)).toBe(60)
    expect(normalizeDuration(0)).toBeNull()
    expect(buildVideoBody({ model: MODEL_2_0, prompt: 'p', duration: 999 }).body.duration).toBe(60)
  })

  it('resolution：合法值原样保留，非法值不发送', () => {
    expect(buildVideoBody({ model: MODEL_2_0, prompt: 'p', resolution: '1080P' }).body.resolution).toBe('1080p')
    const bad = buildVideoBody({ model: MODEL_2_0, prompt: 'p', resolution: '8k' })
    expect(bad.body.resolution).toBeUndefined()
    expect(noteNames(bad.notes)).toContain('resolution')
  })

  it('非法 ratio（无图时）回退默认值并记录 default', () => {
    const { body, notes } = buildVideoBody({ model: MODEL_2_0, prompt: 'p', ratio: '4:5' })
    expect(body.ratio).toBe('1:1')
    expect(notes[0].action).toBe('default')
  })

  it('watermark 透传', () => {
    expect(buildVideoBody({ model: MODEL_2_0, prompt: 'p', watermark: false }).body.watermark).toBe(false)
    expect(buildVideoBody({ model: MODEL_2_0, prompt: 'p' }).body.watermark).toBe(true)
  })

  it('未知模型不猜 seed 支持：省略而不是让服务端 400', () => {
    const unknown = buildVideoBody({ model: 'x-unknown', prompt: 'p', seed: 42 })
    expect(unknown.body.seed).toBeUndefined()
    expect(noteNames(unknown.notes)).toContain('seed')

    const known = buildVideoBody({ model: MODEL_2_0, prompt: 'p', seed: 42 })
    expect(known.body.seed).toBe(42)
  })

  it('camera_fixed 只在确认支持的家族上发送', () => {
    const v1 = buildVideoBody({ model: 'doubao-seedance-1-0-pro-250528', prompt: 'p', cameraFixed: true })
    expect(v1.body.camera_fixed).toBe(true)
    const v2 = buildVideoBody({ model: MODEL_2_0, prompt: 'p', cameraFixed: true })
    expect(v2.body.camera_fixed).toBeUndefined()
    expect(noteNames(v2.notes)).toContain('camera_fixed')
  })
})

describe('生图请求体', () => {
  it('关键字段与默认值', () => {
    const { body } = buildImageBody({ model: 'm', prompt: 'p', imageDataUris: [IMG, IMG] })
    expect(body.image).toHaveLength(2)
    expect(body.size).toBe('2K')
    expect(body.output_format).toBe('png')
    expect(body.response_format).toBe('b64_json')
    expect(body.watermark).toBe(true)
  })

  it('size 两种写法都合法：关键字与像素', () => {
    expect(isValidImageSize('2K')).toBe(true)
    expect(isValidImageSize('4k')).toBe(true)
    expect(isValidImageSize('2048x2048')).toBe(true)
    expect(isValidImageSize('big')).toBe(false)
    expect(buildImageBody({ model: 'm', prompt: 'p', imageDataUris: [IMG], size: '2048x2048' }).body.size).toBe(
      '2048x2048'
    )
  })

  it('非法 size / output_format 不发送，并记录原因', () => {
    const r = buildImageBody({ model: 'm', prompt: 'p', imageDataUris: [IMG], size: 'huge', outputFormat: 'tiff' })
    expect(r.body.size).toBeUndefined()
    expect(r.body.output_format).toBeUndefined()
    expect(noteNames(r.notes)).toEqual(expect.arrayContaining(['size', 'output_format']))
  })

  it('response_format 恒为 b64_json（解析层依赖，不允许被省略）', () => {
    const r = buildImageBody({ model: 'm', prompt: 'p', imageDataUris: [IMG] })
    expect(r.body.response_format).toBe('b64_json')
  })

  it('没有参考图直接抛错，不发无意义请求', () => {
    expect(() => buildImageBody({ model: 'm', prompt: 'p', imageDataUris: [] })).toThrow(/参考图/)
  })
})

describe('400 参数错误解析', () => {
  it('反引号里的字段名优先识别', () => {
    const r = parseRejectedParam(
      400,
      JSON.stringify({
        error: { code: 'InvalidParameter', message: 'The parameter `ratio` specified in the request is not valid' }
      })
    )
    expect(r?.param).toBe('ratio')
    expect(r?.generic).toBe(false)
  })

  it('中文关键词也能识别', () => {
    expect(parseRejectedParam(400, '{"error":{"message":"分辨率不支持"}}')?.param).toBe('resolution')
    expect(parseRejectedParam(400, '{"error":{"message":"时长参数不合法"}}')?.param).toBe('duration')
    expect(parseRejectedParam(400, '{"error":{"message":"输出格式不支持"}}')?.param).toBe('output_format')
  })

  it('只说「参数不合法」时返回泛化标记，交给优先级列表处理', () => {
    const r = parseRejectedParam(400, '{"error":{"message":"请求参数不合法"}}')
    expect(r?.param).toBeNull()
    expect(r?.generic).toBe(true)
  })

  it('审核 / 模型不存在 / 鉴权不是参数问题，不应触发重试', () => {
    expect(parseRejectedParam(400, '{"error":{"message":"内容审核不通过"}}')).toBeNull()
    expect(parseRejectedParam(400, '{"error":{"code":"UnsupportedModel","message":"model not found"}}')).toBeNull()
    expect(parseRejectedParam(401, '{"error":{"message":"invalid api key"}}')).toBeNull()
    expect(parseRejectedParam(500, 'parameter error')).toBeNull()
  })
})

describe('省略重试辅助函数', () => {
  it('dropParam 返回新对象，不改原对象', () => {
    const body = { model: 'm', ratio: '1:1', duration: 5 }
    const next = dropParam(body, 'ratio')!
    expect(next).toEqual({ model: 'm', duration: 5 })
    expect(body.ratio).toBe('1:1')
    expect(dropParam(body, 'not_exist')).toBeNull()
  })

  it('dropParam 拒绝必填字段（丢了解析不了或请求无意义）', () => {
    expect(dropParam({ model: 'm', content: [] }, 'content')).toBeNull()
    expect(dropParam({ prompt: 'p', image: [] }, 'prompt')).toBeNull()
    expect(dropParam({ response_format: 'b64_json' }, 'response_format')).toBeNull()
  })

  it('nextDropCandidate 按优先级挑（视频先 ratio，生图先 size）', () => {
    expect(nextDropCandidate({ model: 'm', duration: 5, ratio: '1:1' }, VIDEO_DROPPABLE)).toBe('ratio')
    expect(nextDropCandidate({ model: 'm' }, VIDEO_DROPPABLE)).toBeNull()
  })

  it('describeNotes 去重后拼成人话', () => {
    expect(
      describeNotes([
        { param: 'ratio', action: 'drop', detail: 'a' },
        { param: 'ratio', action: 'drop', detail: 'b' },
        { param: 'size', action: 'drop', detail: 'c' }
      ])
    ).toBe('ratio、size')
    expect(describeNotes([])).toBe('')
  })

  it('重试次数有上限，避免死循环', () => {
    expect(MAX_PARAM_RETRIES).toBeGreaterThan(0)
    expect(MAX_PARAM_RETRIES).toBeLessThanOrEqual(5)
  })
})
