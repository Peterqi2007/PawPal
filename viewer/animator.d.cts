// PawPal 动画绘制类型声明（animator.cjs 的 TS 包装）
export const MAX_SHEET_WIDTH: number
export const DEFAULT_CELL: number
export const DEFAULT_FRAMES: number
export const DEFAULT_FPS: number
export const MIN_FRAMES: number
export const MAX_FRAMES: number
export const DEFAULT_PADDING: number
export const CHROMA_KEY: number[]
export const BG_HEX: string

export interface SheetCheck {
  ok: boolean
  error?: string
}

export interface SheetLayout {
  ok: boolean
  width?: number
  height?: number
  cell?: number
  frames?: number
  error?: string
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export function validateSheet(frames: number, cell: number): SheetCheck
export function edgeFloodAlpha(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opts?: { tolerance?: number; feather?: number }
): { removed: number; bg: [number, number, number] }
export function softEdges(data: Uint8ClampedArray, width: number, height: number, radius: number): void
export function chromaKeyAlpha(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opts?: { keyColor?: number[]; autoKey?: boolean; tolerance?: number; minGreen?: number; feather?: number }
): { removed: number; key: number[]; tolerance: number; dominanceGate: number }
export function borderColorStats(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { key: number[]; p75: number; p95: number; count: number }
export function detectGreenBackground(data: Uint8ClampedArray, width: number, height: number): number
export function greenRatioOfBitmap(buf: Uint8ClampedArray | Buffer, width: number, height: number): number
export function keepLargestForeground(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold?: number
): { kept: number; removed: number }
export function trimBounds(data: Uint8ClampedArray, width: number, height: number, threshold?: number): Bounds | null
export function layoutSheet(frames: number, cell: number): SheetLayout
export interface PetActionSpec {
  file: string
  frames: number
  fps: number
  loop: boolean
  weight: number
  frameWidth: number
  frameHeight: number
  scale: number
  label: string
  diary: { mood: string; text: string }
}

export function buildActionSpec(opts: {
  action: string
  frames: number
  cell: number
  fps?: number
}): PetActionSpec
export function safeSlug(name: string): string
export function sampleTimes(durationSec: number, frames: number): number[]
