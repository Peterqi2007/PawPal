// PawPal Seedance 客户端类型声明（seedance-client.cjs 的 TS 包装）
export const DEFAULT_MODEL: string
export const DEFAULT_DURATION: number
export const DEFAULT_RATIO: string
export const DEFAULT_RESOLUTION: string
export const POLL_INTERVAL_MS: number
export const POLL_TIMEOUT_MS: number

export interface ArkCfgLike {
  apiKey?: string
  baseUrl?: string
  model?: string
  videoModel?: string
  style?: string
}

export interface SeedanceTaskBody {
  model?: string
  content?: Array<Record<string, unknown>>
  duration?: number
  ratio?: string
  resolution?: string
  watermark?: boolean
}

export interface SeedanceClient {
  createTask(opts: { cfg: ArkCfgLike; body: SeedanceTaskBody }): Promise<Record<string, any>>
  getTask(opts: { cfg: ArkCfgLike; taskId: string }): Promise<Record<string, any>>
  poll(opts: {
    cfg: ArkCfgLike
    taskId: string
    onProgress?: (p: { status: string; elapsedMs: number }) => void
    signal?: AbortSignal
    intervalMs?: number
    timeoutMs?: number
  }): Promise<Record<string, any>>
  download(opts: { url: string }): Promise<Record<string, any>>
}

export function buildVideoPrompt(opts: {
  actionDesc?: string
  style?: string
  extra?: string
}): string
export function buildTaskBody(opts: {
  model?: string
  prompt: string
  imageDataUri?: string | null
  duration?: number
  ratio?: string
  resolution?: string
  watermark?: boolean
}): SeedanceTaskBody
export function buildTaskRequest(opts: {
  model?: string
  prompt?: string
  imageDataUri?: string | null
  duration?: number | string
  ratio?: string
  resolution?: string
  watermark?: boolean
  seed?: number | string
  cameraFixed?: boolean
}): {
  body: SeedanceTaskBody
  profile: { id: string; family: string; ratioWithImage: boolean; supportsSeed: boolean; supportsCameraFixed: boolean }
  notes: Array<{ param: string; action: string; detail: string }>
}
export function mapHttpError(status: number, text: string): string
export function parseTaskCreated(json: unknown): { ok: boolean; taskId?: string; status?: string; error?: string }
export function parseTaskStatus(json: unknown): {
  ok: boolean
  done?: boolean
  videoUrl?: string
  usage?: unknown
  duration?: number
  fps?: number
  status?: string
  error?: string
}
export function createSeedanceClient(deps: {
  fetchImpl: (url: string, init?: Record<string, unknown>) => Promise<Record<string, any>>
  now?: () => number
}): SeedanceClient
