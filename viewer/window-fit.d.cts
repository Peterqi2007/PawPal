// window-fit.cjs 的类型声明
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export declare function clampToWorkArea(rect: Rect, workArea: Rect): Rect
