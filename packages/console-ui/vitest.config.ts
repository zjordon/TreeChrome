import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
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
