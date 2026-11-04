// PawPal 参考图库类型声明（refs-store.cjs 的 TS 包装）
export type RefRole = 'setup' | 'pose'

export interface RefGroup {
  id: string
  name: string
  createdAt: number
  /** 仅 state()/groups 返回时带：该分组图片数 */
  count?: number
}

export interface RefItem {
  id: string
  file: string
  thumb: string
  originalName: string
  group: string
  role: RefRole
  /** upload = 用户导入；ai = 面板重绘生成 */
  source: 'upload' | 'ai'
  width: number
  height: number
  bytes: number
  addedAt: number
}

export interface RefThumb {
  data: Buffer
  ext: string
  width: number
  height: number
}

export interface RefsStoreOptions {
  /** 解码校验 + 缩略图生成；返回 null 表示不是有效图片（fail-closed） */
  thumbMaker: (buf: Buffer, originalName?: string) => RefThumb | null
}

export interface RefsStoreStats {
  count: number
  bytes: number
  setupCount: number
  poseCount: number
}

export interface RefsState {
  groups: RefGroup[]
  activeGroupId: string
  items: RefItem[]
  stats: RefsStoreStats
}

export interface AddResult {
  ok: boolean
  item?: RefItem
  items?: RefItem[]
  error?: string
}

export interface MutateResult {
  ok: boolean
  items?: RefItem[]
  error?: string
}

export interface CreateGroupResult {
  ok: boolean
  group?: RefGroup
  groups: RefGroup[]
  existed?: boolean
  error?: string
}

export interface DeleteGroupResult {
  ok: boolean
  groupId?: string
  removed?: { items: number; files: number }
  error?: string
}

export interface RefsStore {
  rootDir: string
  imagesDir: string
  indexPath: string
  groups(): RefGroup[]
  list(groupId?: string): RefItem[]
  getItem(id: string): RefItem | null
  createGroup(name: string): CreateGroupResult
  addFromBuffer(buf: Buffer, originalName: string, groupId?: string, opts?: { source?: 'upload' | 'ai' }): AddResult
  setRole(id: string, role: RefRole): MutateResult
  remove(id: string): MutateResult
  getThumb(id: string): Buffer | null
  stats(groupId?: string): RefsStoreStats
  state(groupId?: string): RefsState
  setActiveGroup(groupId?: string): RefsState
  /** 删除整个分组（组内图片一并清理）；拒绝删除最后一个分组 */
  deleteGroup(groupId: string): DeleteGroupResult
}

export function createRefsStore(rootDir: string, opts: RefsStoreOptions): RefsStore
export function sanitizeName(name: string): string
export function sanitizeGroupName(name: string): string
export function extOf(name: string): string
export function normalizeRoles(items: RefItem[]): RefItem[]
export const ALLOWED_EXT: Set<string>
export const MAX_FILE_BYTES: number
export const MAX_ITEMS: number
export const MAX_GROUPS: number
export const MAX_NAME_LEN: number
export const MAX_GROUP_NAME_LEN: number
export const DEFAULT_GROUP_NAME: string
export const ROLES: string[]
export const ID_RE: RegExp
export const GROUP_ID_RE: RegExp
