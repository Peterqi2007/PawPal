// PawPal Seedream 客户端类型声明（seedream-client.cjs 的 TS 包装）
export const MIN_POSE: number
export const MAX_POSES: number
export const MAX_REFS: number
export const MAX_EDGE: number
export const DEFAULT_TIMEOUT_MS: number

export interface Readiness {
  ready: boolean
  reason: string
}

export interface SeedreamGenerateOptions {
  cfg?: { apiKey?: string; baseUrl?: string; model?: string; style?: string }
  petName?: string
  items?: Array<{ role?: string; file?: string }>
  imagesDir?: string
  size?: string
  timeoutMs?: number
  signal?: AbortSignal
  dryRun?: boolean
}

export interface SeedreamGenerateResult {
  ok: boolean
  error?: string
  blocked?: boolean
  dryRun?: boolean
  requestBody?: Record<string, unknown>
  buffer?: Buffer
  usage?: Record<string, unknown> | null
  imageSize?: string | null
  status?: number
  meta?: Record<string, unknown>
}

export interface SeedreamClientDeps {
  fetchImpl: (url: string, init?: Record<string, unknown>) => Promise<{
    ok: boolean
    status: number
    text: () => Promise<string>
  }>
  encodeImage: (absPath: string, readFile?: unknown) => string | null
  readFile?: unknown
}

export interface SeedreamClient {
  generate(opts: SeedreamGenerateOptions): Promise<SeedreamGenerateResult>
}

export function evaluateReadiness(stats: { setupCount?: number; poseCount?: number }): Readiness
export function buildPrompt(opts: { style?: string; petName?: string }): string
export function pickReferences<T extends { role?: string }>(items: T[]): T[]
export function buildRequestBody(opts: {
  model: string
  prompt: string
  imageDataUris: string[]
  size?: string
}): Record<string, unknown>
export function parseResponse(json: unknown): {
  ok: boolean
  buffer?: Buffer
  usage?: Record<string, unknown> | null
  size?: string | null
  error?: string
}
export function mapHttpError(status: number, text: string): string
export function createSeedreamClient(deps: SeedreamClientDeps): SeedreamClient
