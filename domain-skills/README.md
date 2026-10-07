# domain-skills（站点级 / 任务级 skill 内容库）

> 来源：**TreeWalker @640d52a** `domain-skills/`（2026-10-07 拷入，185 文件 SHA-256 清单核对
> 逐字节一致——P5.5 实施时脚本对拍）。上游后续演进不自动跟进，升级时重新拷贝并在本文件登记。

## 结构（架构 §6.1 双层模型）

```
<host_key>/                  # host 含端口形态（localhost_7780 = extractHostWithPort 产物）
  _sop.md                    # 站点级流程骨架（[SOP] 段注入）
  selectors.md               # 元素指纹（[SELECTORS] 段注入）
  quirks.md                  # 站点坑（[QUIRKS] 段注入）
  tasks/<slug>/              # 任务级卡片（口径 C）
    _task.json               # {slug, task_description, task_keywords, distilled_at}
    _sop.md / selectors.md / quirks.md
```

## 本仓三套

| host_key | 用途 |
|---|---|
| `localhost_7780` | **评测口径 B/C 主战场**（WebArena shopping_admin，182 任务 + 44 任务卡） |
| `creator.douyin.com` | 真实任务（抖音上传；upload-file 系示例） |
| `member.bilibili.com` | 真实任务（B站上传；upload-file-bilibili） |

## 消费方式

- node-host：`AGENT_SKILLS_DIR` 指向本目录（缺省 `domain-skills` 相对 CWD——在 TreeChrome
  仓根运行即命中）；`FsSkillSource` 读目录实现 core 的 `SkillSource`。
- 开关：站点级 `enableSkillInjection`（默认 true）/ 任务级 `enableTaskSkillInjection`
  （默认 false）；env 面 `AGENT_ENABLE_SKILL_INJECTION` / `AGENT_ENABLE_TASK_SKILL_INJECTION`。
- **评测口径 A（parity 基线）必须双开关 off**——参考 Python 侧 three-caliber 报告的口径定义。

## 与 TreeWalker 的同步纪律

内容是数据非代码：上游修复（如 #195 任务卡批量修复）想跟进时，从上游冻结基准拷贝并
重跑哈希清单核对，本文件登记新 commit。扩展（M5）形态改为 IndexedDB 打包技能
（provenance=built-in），届时本目录仍是蒸馏产物的交换格式。
