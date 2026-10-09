import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // 组件测试面（段 E）：jsdom + @testing-library/react；renderToString 冒烟同成立
    environment: "jsdom",
    // RTL 自动 cleanup 依赖全局 afterEach——globals 开（测试内仍显式 import，不依赖推断）
    globals: true,
    coverage: {
      provider: "v8",
      enabled: true,
      include: ["src/**/*.ts", "src/**/*.tsx"],
      // 宿主粘合层（sidepanel/options 的 main.tsx 装配）不在本包；组件即被测面
      thresholds: { statements: 85, lines: 85, functions: 85, branches: 85 },
      reporter: ["text", "html"],
    },
  },
});
