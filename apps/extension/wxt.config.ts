// WXT 配置（m5/01 §1.4）：React 经 @vitejs/plugin-react（WXT 官方接入方式）+ 关闭
// auto-import（显式 import 符合仓库风格，避免 biome 未解析符号误报）+ manifest 权限面。
// 图标走 public/icon/ 约定自动填充。

import react from "@vitejs/plugin-react";
import { defineConfig } from "wxt";

export default defineConfig({
  vite: () => ({ plugins: [react()] }),
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
  },
});
