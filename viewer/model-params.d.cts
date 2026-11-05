// PawPal 模型参数适配层类型声明（model-params.cjs 的 TS 包装）
export const RATIOS: string[]
export const RESOLUTIONS: string[]
export const IMAGE_FORMATS: string[]
export const DEFAULT_DURATION: number
export const DEFAULT_RATIO: string
export const DEFAULT_RESOLUTION: string
export const DEFAULT_IMAGE_SIZE: string
export const MAX_PARAM_RETRIES: number
export const VIDEO_DROPPABLE: string[]
export const IMAGE_DROPPABLE: string[]
export const VIDEO_REQUIRED: string[]
export const IMAGE_REQUIRED: string[]

export interface ParamNote {
  param: string
  action: 'drop' | 'default' | 'clamp' | string
  detail: string
}

export interface VideoModelProfile {
  id: string
  family: string
  ratioWithImage: boolean
  supportsSeed: boolean
  supportsCameraFixed: boolean
}

export interface VideoBodyInput {
  model?: string
  prompt?: string
  imageDataUri?: string | null
  duration?: number | string
  ratio?: string
  resolution?: string
  watermark?: boolean
  seed?: number | string
  cameraFixed?: boolean
}

export interface ImageBodyInput {
  model?: string
  prompt?: string
  imageDataUris?: string[]
  size?: string
  outputFormat?: string
  watermark?: boolean
}

export function videoModelProfile(model?: string): VideoModelProfile
export function buildVideoBody(opts?: VideoBodyInput): {
  body: Record<string, unknown>
  profile: VideoModelProfile
  notes: ParamNote[]
}
export function buildImageBody(opts?: ImageBodyInput): {
  body: Record<string, unknown>
  notes: ParamNote[]
}
export function parseRejectedParam(
  status: number,
  text: string
): { param: string | null; generic: boolean; detail: string } | null
export function dropParam(body: Record<string, unknown>, name: string): Record<string, unknown> | null
export function nextDropCandidate(body: Record<string, unknown>, order?: string[]): string | null
export function describeNotes(notes?: ParamNote[]): string
export function normalizeRatio(value?: string | null): string | null
export function normalizeResolution(value?: string | null): string | null
export function normalizeDuration(value?: number | string | null): number | null
export function isValidImageSize(value?: string | null): boolean
