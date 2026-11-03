/// <reference types="vite/client" />

// Vite 资源导入（?url）的类型声明：让 `import ding from '../assets/ding.wav?url'` 通过 tsc
declare module '*?url' {
  const src: string
  export default src
}
