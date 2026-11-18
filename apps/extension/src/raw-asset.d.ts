// vite ?raw 资产声明（#39 批 D）：导出 HTML 注入聚合主题 CSS 文本——WXT 项目
// 未带 vite/client types，此处补通配声明。
declare module "*?raw" {
  const content: string;
  export default content;
}
