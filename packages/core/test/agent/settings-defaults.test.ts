// DEFAULT_AGENT_SETTINGS 对拍 venv 实跑运营默认（node-host 方案 §5.1 兜底）：
// fixture = tree_walker load_settings() 无 env 产出的 agent 全量 dict（71 键）。
// 本测试持有「映射清单 + 排除清单」双名单：fixture 键集必须恰好等于两名单之并——
// Python 侧新增 agent 设置（或删改）即失败，强制显式映射或排除（漂移警报）。
// 重新生成 fixture：packages/core/tools/gen-settings-defaults.py（venv）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DEFAULT_AGENT_SETTINGS } from "../../src/agent/settings.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../fixtures/python-anchors/settings-defaults.json"), "utf8"),
) as { agent: Record<string, unknown> };

/** py agent 键 → TS AgentSettings 键（扁平直映） */
const FLAT_MAP: Record<string, string> = {
  max_steps: "maxSteps",
  max_failures: "maxFailures",
  max_infra_failures: "maxInfraFailures",
  done_uncertainty_gate: "doneUncertaintyGate",
  max_actions_per_step: "maxActionsPerStep",
  llm_timeout: "llmTimeout",
  action_timeout: "actionTimeout",
  reconnect_timeout: "reconnectTimeout",
  sensitive_data: "sensitiveData",
  track_downloads: "trackDownloads",
  message_compaction: "messageCompaction",
  enable_message_typing: "enableMessageTyping",
  enable_page_stats: "enablePageStats",
  enable_grid_meta: "enableGridMeta",
  enable_sensitive_description: "enableSensitiveDescription",
  enable_skill_injection: "enableSkillInjection",
  max_history_items: "maxHistoryItems",
  enable_recent_events: "enableRecentEvents",
  use_vision: "useVision",
  llm_screenshot_size: "llmScreenshotSize",
  enable_planning: "enablePlanning",
  exploration_threshold: "explorationThreshold",
  replan_failure_threshold: "replanFailureThreshold",
  enable_decision_attribution: "enableDecisionAttribution",
  action_page_filters: "actionPageFilters",
  allowed_upload_paths: "allowedUploadPaths",
  allowed_write_paths: "allowedWritePaths",
  allowed_read_paths: "allowedReadPaths",
  display_files_in_done_text: "displayFilesInDoneText",
  extraction_schema: "extractionSchema",
  enable_task_skill_injection: "enableTaskSkillInjection",
  exploration_actionability_check: "explorationActionabilityCheck",
  exploration_actionability_timeout: "explorationActionabilityTimeout",
  exploration_actionability_poll: "explorationActionabilityPoll",
  exploration_actionability_receives_events: "explorationActionabilityReceivesEvents",
  exploration_actionability_runtime_occlusion: "explorationActionabilityRuntimeOcclusion",
  exploration_actionability_stable: "explorationActionabilityStable",
  exploration_actionability_stable_interval: "explorationActionabilityStableInterval",
  exploration_actionability_stable_tolerance: "explorationActionabilityStableTolerance",
  exploration_page_settle: "explorationPageSettle",
  exploration_page_settle_timeout: "explorationPageSettleTimeout",
  exploration_page_settle_poll: "explorationPageSettlePoll",
  exploration_page_settle_stable_polls: "explorationPageSettleStablePolls",
};

/** truncation 子对象键映射（py → TS ToolsTruncationSettings） */
const TRUNCATION_MAP: Record<string, string> = {
  extract_page_max_chars: "extractPageMaxChars",
  extract_fallback_max_chars: "extractFallbackMaxChars",
  extract_chunk_max_chars: "extractChunkMaxChars",
  extract_save_threshold: "extractSaveThreshold",
  extract_output_dir: "extractOutputDir",
  extract_call_timeout: "extractCallTimeoutS",
  read_file_max_chars: "readFileMaxChars",
  eval_result_max_chars: "evalResultMaxChars",
  display_max_chars: "displayMaxChars",
  dom_excerpt_max_chars: "domExcerptMaxChars",
  search_page_save_threshold: "searchPageSaveThreshold",
  search_page_output_dir: "searchPageOutputDir",
  find_elements_save_threshold: "findElementsSaveThreshold",
  find_elements_output_dir: "findElementsOutputDir",
  eval_save_threshold: "evalSaveThreshold",
  eval_output_dir: "evalOutputDir",
  done_attachment_max_chars: "doneAttachmentMaxChars",
};

/** judge 子对象键映射 */
const JUDGE_MAP: Record<string, string> = {
  enabled: "enabled",
  model: "model",
  max_history_steps: "maxHistorySteps",
  trace_max_chars: "traceMaxChars",
};

/**
 * py agent 键 → 不入 TS AgentSettings 的登记清单（键→理由）。改动此清单须在
 * 对应 implement-plan 文档登记。基线：偏离 5/7（观测与重放/审计族）、P4b 结构
 * 决策（upload_verify 移居 Tools 构造默认）。
 */
const EXCLUDED: Record<string, string> = {
  enable_observability: "偏离 5：obs 装配在宿主（EventBus 事件已就位）",
  observability_log_dir: "偏离 5：同上",
  upload_verify_enabled: "P4b：位于 Tools 构造默认（tools 层 settings），不随 AgentSettings",
  upload_verify_wait_s: "P4b：同上",
  upload_verify_interval_s: "P4b：同上",
  extract_llm: "复用主 llm（Agent 构造固定接线）；独立卡属宿主装配面",
  task_skill_llm: "同 extract_llm",
  rerun_history_dir: "AgentOptions 构造参数（非 AgentSettings）；重放族偏离 3",
  skills_dir: "偏离 4：skill 目录读经 SkillSource 注入",
  record_upload_dir: "偏离 7：重放/审计族",
  save_conversation_path: "偏离 7：重放/审计族",
  rerun_delay_between_actions: "偏离 3：rerun 族不移植",
  rerun_max_step_interval: "偏离 3：rerun 族不移植",
  rerun_wait_for_elements: "偏离 3：rerun 族不移植",
  rerun_wait_for_page_settle: "偏离 3：rerun 族不移植",
  rerun_actionability_check: "偏离 3：rerun 族不移植",
  rerun_actionability_timeout: "偏离 3：rerun 族不移植",
  rerun_actionability_poll: "偏离 3：rerun 族不移植",
  rerun_actionability_receives_events: "偏离 3：rerun 族不移植",
  rerun_actionability_runtime_occlusion: "偏离 3：rerun 族不移植",
  rerun_actionability_stable: "偏离 3：rerun 族不移植",
  rerun_actionability_stable_interval: "偏离 3：rerun 族不移植",
  rerun_actionability_stable_tolerance: "偏离 3：rerun 族不移植",
  rerun_wait_for_networkidle: "偏离 3：rerun 族不移植",
  rerun_upload_wait_video: "偏离 3：rerun 族不移植",
  rerun_upload_wait_image: "偏离 3：rerun 族不移植",
};

describe("DEFAULT_AGENT_SETTINGS ↔ Python load_settings() 运营默认对拍", () => {
  const agent = fixture.agent;

  test("fixture 键集恰好 = 映射清单 ∪ 排除清单（双向漂移警报）", () => {
    const expected = new Set([
      ...Object.keys(FLAT_MAP),
      "truncation",
      "judge",
      ...Object.keys(EXCLUDED),
    ]);
    const actual = new Set(Object.keys(agent));
    const missing = [...expected].filter((k) => !actual.has(k));
    const unknown = [...actual].filter((k) => !expected.has(k));
    expect(missing, "清单声称存在但 fixture 缺失（Python 侧删改？）").toEqual([]);
    expect(unknown, "fixture 有键不在任何清单——须显式映射进 FLAT_MAP 或登记 EXCLUDED").toEqual([]);
    expect(Object.keys(agent).length).toBe(
      Object.keys(FLAT_MAP).length + 2 + Object.keys(EXCLUDED).length,
    );
  });

  test("扁平键逐键对拍", () => {
    for (const [pyKey, tsKey] of Object.entries(FLAT_MAP)) {
      expect(
        DEFAULT_AGENT_SETTINGS[tsKey as keyof typeof DEFAULT_AGENT_SETTINGS],
        `${pyKey} → ${tsKey}`,
      ).toBe(agent[pyKey]);
    }
  });

  test("truncation 子对象逐键对拍", () => {
    const py = agent.truncation as Record<string, unknown>;
    for (const [pyKey, tsKey] of Object.entries(TRUNCATION_MAP)) {
      expect(
        DEFAULT_AGENT_SETTINGS.truncation[tsKey as keyof typeof DEFAULT_AGENT_SETTINGS.truncation],
        `truncation.${pyKey} → ${tsKey}`,
      ).toBe(py[pyKey]);
    }
    expect(Object.keys(py).length).toBe(Object.keys(TRUNCATION_MAP).length);
  });

  test("judge 子对象逐键对拍", () => {
    const py = agent.judge as Record<string, unknown>;
    for (const [pyKey, tsKey] of Object.entries(JUDGE_MAP)) {
      expect(
        DEFAULT_AGENT_SETTINGS.judge[tsKey as keyof typeof DEFAULT_AGENT_SETTINGS.judge],
        `judge.${pyKey} → ${tsKey}`,
      ).toBe(py[pyKey]);
    }
    expect(Object.keys(py).length).toBe(Object.keys(JUDGE_MAP).length);
  });

  test("已知运营≠dataclass 分歧键按运营默认（漂移回归锁）", () => {
    // config.py:501 env 缺省 "true"（dataclass :163 为 False）——examples/runner 实跑口径
    expect(DEFAULT_AGENT_SETTINGS.enablePlanning).toBe(true);
    // config.py:538/:540；此前 TS 误为 2.0/false（node-host 方案 §5.1 对账修正）
    expect(DEFAULT_AGENT_SETTINGS.explorationActionabilityTimeout).toBe(1.5);
    expect(DEFAULT_AGENT_SETTINGS.explorationActionabilityReceivesEvents).toBe(true);
  });
});
