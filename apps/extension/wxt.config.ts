// WXT 配置（m5/01 §1.4）：React 经 @vitejs/plugin-react（WXT 官方接入方式）+ 关闭
// auto-import（显式 import 符合仓库风格，避免 biome 未解析符号误报）+ manifest 权限面。
// 图标走 public/icon/ 约定自动填充。
// resolve.alias：@tw/core 源码进 bundle 后，WXT 管线在某虚拟模块上产生对
// "wxt/browser" 的解析（rollup 归因到 core 文件——变换后代码无此 import，虚警），
// 从 packages/* 侧 node 解析找不到 wxt（pnpm 严格隔离）——显式别名收口。
// buildStart 钩子：built-in skills 打包（domain-skills/ → public/domain-skills.json，
// m5/04 §5——dev/build 都先跑；SW onInstalled fetch 后 upsert IndexedDB）。

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "wxt";

const wxtBrowser = fileURLToPath(new URL("./node_modules/wxt/dist/browser.mjs", import.meta.url));
const embedSkillsScript = fileURLToPath(new URL("./scripts/embed-skills.mjs", import.meta.url));

export default defineConfig({
  vite: () => ({
    plugins: [
      react(),
      {
        name: "tc-embed-skills",
        // 子进程跑独立脚本（.mjs 无类型面不进 tsconfig；await 保证 public/ 拷贝前产物就绪）
        async buildStart() {
          await new Promise<void>((resolve) => {
            execFile(process.execPath, [embedSkillsScript], (_err, stdout) => {
              const line = String(stdout).trim();
              if (line !== "") console.log(line);
              resolve();
            });
          });
        },
      },
    ],
    resolve: { alias: { "wxt/browser": wxtBrowser } },
  }),
  imports: false,
  manifest: {
    name: "TreeChrome",
    description: "TreeWalker 引擎的 Chrome 扩展宿主——CDP agent 侧边栏",
    permissions: [
      "sidePanel",
      "storage",
      "unlimitedStorage",
      "tabs",
      "debugger",
      "downloads",
      "alarms",
    ],
    host_permissions: ["<all_urls>"],
    // domain-skills.json 走 web_accessible_resources（SW fetch 自身资源不需
    // web_accessible——但显式声明无害且便于诊断页直读）
    web_accessible_resources: [{ resources: ["domain-skills.json"], matches: ["<all_urls>"] }],
  },
});
