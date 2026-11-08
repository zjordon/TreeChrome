// tc 用法卡（issue #26 D3）：`tc skill install` / `--print` 的内容单源（TS 常量——
// 实施裁定：不落独立 .md 文件，消除与 README 的双源同步义务；README 保留更完整的
// 包文档，本卡只写 agent 需要的最小决策面）。风格对齐 browser-use SKILL.md。

export const SKILL_CARD = `---
name: tc
description: "经 TreeChrome (tc) CLI 驱动浏览器完成网页任务：需要点击/输入/登录态/JS 渲染/反爬页面时用；纯 fetch/curl 能读到的公开信息不要开浏览器。"
---

# tc — 任务级浏览器 agent CLI

把一段自然语言任务交给本机浏览器 agent（LLM 驱动，返回结构化结果）。

## When Not to Use

公开页面/API/文档，直接用 fetch/curl 就能读到的——**不要用 tc**。仅当任务需要交互
（点击/输入/提交）、登录态、JS 渲染或反爬保护时才升级到浏览器。

## 前置

- Chrome 以 \`--remote-debugging-port=9222\` 运行；或加 \`--auto-chrome\` 自动拉起临时
  headless 实例（run 结束自动回收，不碰你日常的 Chrome）
- 凭据 \`ZHIPU_API_KEY\`（环境变量，或 \`~/.tc/.env\` / 当前目录 \`.env\`）

## 用法

\`\`\`bash
# 推荐：任务文本走 stdin（中文/多行最稳）
echo "到 https://example.com 查 …" | tc run --json --auto-chrome

# 或位置参数 / 文件
tc run "打开 example.com 并把标题告诉我" --json
tc run --task-file task.txt --json
\`\`\`

## 输出契约（--json）

stdout **只有一行 JSON**（过程日志全在 stderr）：

\`\`\`json
{"isDone":true,"isSuccessful":true,"finalResult":"…","stopReason":null,
 "nSteps":3,"finalizeDegradedSteps":0,"attachments":[],"errors":[],"lastUrl":"https://…"}
\`\`\`

- \`finalResult\` = 答案；\`lastUrl\` = 最终页面；\`attachments\` = 产出文件
- 退出码：0 成功；1 跑完未成功（读 stopReason/errors 后决定改写任务或放弃）；
  **2 = 环境问题（缺 key / Chrome 不可达 / 参数错）——不要重试，先修环境或换 --auto-chrome**

## 护栏（建议显式收紧）

\`\`\`bash
… --max-steps 10 --allow-write <工作目录> --allow-upload <文件目录>
\`\`\`

不带 \`--allow-*\` 时文件面默认全放行。

## Windows

PowerShell 中文乱码先 \`chcp 65001\`；\`--json\` 输出恒 UTF-8。
`;
