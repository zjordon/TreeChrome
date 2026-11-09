// tc 用法卡（issue #26 D3 + #27 M2）：`tc skill install` / `--print` 的内容单源（TS
// 常量——实施裁定：不落独立 .md 文件，消除与 README 的双源同步义务；README 保留更
// 完整的包文档，本卡只写 agent 需要的最小决策面）。风格对齐 browser-use SKILL.md。

export const SKILL_CARD = `---
name: tc
description: "经 TreeChrome (tc) CLI 驱动浏览器完成网页任务：需要点击/输入/登录态/JS 渲染/反爬页面时用；纯 fetch/curl 能读到的公开信息不要开浏览器。两种形态：tc run 任务级（本仓 LLM 跑整段 loop）/ tc <动作> 会话级（你的 LLM 直驱浏览器原语）。"
---

# tc — 浏览器 agent CLI（任务级 + 会话级）

- **任务级** \`tc run\`：一段自然语言任务交给本机浏览器 agent（它自己的 LLM 驱动整段
  loop），返回结构化终态——适合完整委派。
- **会话级** \`tc <动作>\`（daemon 常驻）：**你的 LLM 逐步直驱**浏览器原语，每命令单
  JSON 返回——适合自己掌控决策循环的场景（browser-use 3.0 同款形态）。

## 怎么选（路由阶梯，按序判定；收到自然语言任务时照此分流）

1. **不需要浏览器**（公开信息，fetch/curl 可得）→ 不用 tc。
2. **一句话能写清目标与验收**（「帮我到 X 做 Y」「存草稿」「查…并汇报」）→ \`tc run\`
   委派：一条命令拿终态 JSON，中间步骤无需调用方过目。
3. **任一信号 → 会话级** \`tc <动作>\`：
   - 一步就完事（打开看标题/截个图/读一个值）——开 run 循环是杀鸡用牛刀
   - 探索/诊断（「看看」「为什么」「检查」「找找在哪」）——需要观察-思考-再动的循环
   - 调用方要看路或中途改道（「先给我看看页面」「别点，等我说」）
   - 浏览器内外交织（查一半读本地文件/跑命令/写代码再回来点）——run 是封闭循环做不到
   - 多轮围绕同一页面（草稿箱/设置页来回操作，靠 daemon 保 tab）
4. **模糊 → 默认 run**（省调用方上下文），并告知所用形态；run 失败（exit 1）读
   stopReason/errors 决定改写任务重发，或切会话级进同一页面现场诊断。

凭据差异：run 需要 \`ZHIPU_API_KEY\`；会话级零 LLM 凭据（daemon 内部无 LLM）。

## When Not to Use

公开页面/API/文档，直接用 fetch/curl 就能读到的——**不要用 tc**。仅当任务需要交互
（点击/输入/提交）、登录态、JS 渲染或反爬保护时才升级到浏览器。

## 前置

- Chrome 以 \`--remote-debugging-port=9222\` 运行；或 \`--auto-chrome\`（run）/ daemon
  自动拉起临时 headless 实例（用完回收，不碰你日常的 Chrome）
- 凭据 \`ZHIPU_API_KEY\`（环境变量，或 \`~/.tc/.env\` / 当前目录 \`.env\`；仅 run 需要）

## 任务级用法（tc run）

\`\`\`bash
# 推荐：任务文本走 stdin（中文/多行最稳）
echo "到 https://example.com 查 …" | tc run --json --auto-chrome

# 或位置参数 / 文件
tc run "打开 example.com 并把标题告诉我" --json
tc run --task-file task.txt --json
\`\`\`

stdout **只有一行 JSON**（过程日志全在 stderr）：

\`\`\`json
{"isDone":true,"isSuccessful":true,"finalResult":"…","stopReason":null,
 "nSteps":3,"finalizeDegradedSteps":0,"attachments":[],"errors":[],"lastUrl":"https://…"}
\`\`\`

- \`finalResult\` = 答案；\`lastUrl\` = 最终页面；\`attachments\` = 产出文件
- 退出码：0 成功；1 跑完未成功（读 stopReason/errors 后决定改写任务或放弃）；
  **2 = 环境问题（缺 key / Chrome 不可达 / 参数错）——不要重试，先修环境或换 --auto-chrome**
- 护栏（建议显式收紧）：\`… --max-steps 10 --allow-write <目录> --allow-upload <目录>\`；
  不带 \`--allow-*\` 时文件面默认全放行。

## 会话级用法（tc <动作>，#27 daemon）

daemon 首次调用**自动拉起**（127.0.0.1:9780 / TC_DAEMON_PORT），空闲 15 分钟自动回收；
跨调用保持 tab；并发命令 FIFO 串行。管理：\`tc daemon --status / --stop / --doctor\`。

\`\`\`bash
tc navigate --url https://example.com     # 打开页
tc get_state                              # ← 核心：elementTreeText + url/title/tabs
tc click --index 12                       # 按 get_state 里的 [12] 索引点击
tc input_text --index 8 --text "关键词"
tc evaluate --code "return document.title"
tc screenshot --save-path shot.jpeg --format jpeg --quality 60
                                          # 截图落盘（不给 --save-path 只回字节数回执）
tc tabs && tc switch_tab --tab-id 1a2b    # 多 tab；id 取 tabs 输出后 4 位
\`\`\`

动作全集（15）：get_state / navigate / click / input_text / select_dropdown / scroll /
find_text / read_grid / evaluate / screenshot / upload_file / go_back / tabs / switch_tab /
close_tab。参数细节 \`tc --help\`。

**纪律**：
- index 类动作（click/input_text/select_dropdown/upload_file）**先 get_state 刷新索引**
  再用其中的 [N]——索引过期会找错元素
- 每命令 stdout 恒单 JSON；退出码同上（1 = 动作执行失败，stdout JSON 的 error 字段有因）
- 会话式 upload 不设白名单（调用方 agent 即信任边界；run 面护栏不受影响）

## Windows

PowerShell 中文乱码先 \`chcp 65001\`；JSON 输出恒 UTF-8。
`;
