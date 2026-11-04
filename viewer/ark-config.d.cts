// PawPal 外网生成配置类型声明（ark-config.cjs 的 TS 包装）
export interface ArkConfig {
  apiKey: string
  baseUrl: string
  model: string
  /** 视频生成模型（Seedance） */
  videoModel: string
  style: string
}

export interface ArkPublicStatus {
  configured: boolean
  masked: string
  baseUrl: string
  baseUrlKind: 'standard' | 'plan'
  model: string
  videoModel: string
  style: string
  styles: string[]
  presets: { standard: string; plan: string }
  /** 主进程附加：重绘所需的姿势参考图下限 */
  minPose?: number
}

export const BASE_STANDARD: string
export const BASE_PLAN: string
export const DEFAULTS: ArkConfig
export const MODEL_ALIASES: Record<string, string>
export const STYLES: string[]

export function normalizeBaseUrl(url: string): string
export function resolveModel(value: string): string
export function baseUrlPreset(kind: string): string
export function baseUrlKind(url: string): 'standard' | 'plan'
export function maskKey(key: string): string
export function loadConfig(file: string, env?: Record<string, string | undefined>): ArkConfig
export function saveConfig(file: string, patch?: Partial<ArkConfig>): ArkConfig
export function publicStatus(cfg: ArkConfig): ArkPublicStatus
