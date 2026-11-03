// PetPet 桌宠装配器类型声明（pet-assembler.cjs 的 TS 包装）
export const MAX_SHEET_WIDTH: number

export interface SheetEntry {
  action: string
  file: string
  abs: string
}

export interface SheetMeta {
  ok: boolean
  frames?: number
  cell?: number
  error?: string
}

export interface AssembleResult {
  ok: boolean
  id?: string
  dir?: string
  actions?: string[]
  error?: string
}

export function safeId(name: string, fallback?: string): string
export function collectSheets(animDir: string): SheetEntry[]
export function inferSheetMeta(absPath: string): SheetMeta
export function buildAction(
  action: string,
  opts: { file: string; frames: number; cell: number; fps?: number }
): Record<string, unknown>
export function assemblePet(opts: {
  petsRoot: string
  name: string
  sheets: SheetEntry[]
  idHint?: string
  style?: string
  fps?: number
}): AssembleResult
