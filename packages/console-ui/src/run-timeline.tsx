// RunTimeline（m5/05 §1）：journal 事件流渲染。step 分组（step_start 开组 →
// step_end 收组，<details> 折叠体；组外事件进尾组）；条目按 type 分色：tool_result
// success/error 着色、anomaly 警示色、model_result usage 徽章。data 是 SW 压缩投影
// （unknown）——逐字段防御收窄。长文本折叠：工具参数行 500 字符、结果/错误 1000
// 字符内建截断（展开式 title 全文）。

import type { JournalEvent } from "@tw/protocol";
import { Badge } from "./primitives.js";

interface StepGroup {
  key: string;
  step: number | null;
  events: JournalEvent[];
}

/** step_start 开新组；无组前缀的事件进无号首组（恢复态/异常流）；其余入当前组 */
export function groupByStep(events: JournalEvent[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const e of events) {
    if (e.type === "step_start") {
      groups.push({ key: `s${e.seq}`, step: stepOf(e), events: [e] });
    } else if (groups.length === 0) {
      groups.push({ key: "head", step: null, events: [e] });
    } else {
      groups[groups.length - 1].events.push(e);
    }
  }
  return groups;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** 步号在压缩投影 data 内（JournalEvent 顶层无 step 字段——protocol 形态） */
function stepOf(event: JournalEvent): number | null {
  return isRecord(event.data) ? num(event.data.step) : null;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function EventLine({ event }: { event: JournalEvent }) {
  const d = isRecord(event.data) ? event.data : {};
  switch (event.type) {
    case "step_start":
      return <div className="tc-ev-muted">第 {stepOf(event) ?? "?"} 步开始</div>;
    case "step_end": {
      const secs = num(d.durationSeconds);
      return (
        <div className="tc-ev-muted">
          第 {stepOf(event) ?? "?"} 步完成{secs !== null ? `（${secs}s）` : ""}
        </div>
      );
    }
    case "tool_call": {
      const action = str(d.actionName) ?? event.type;
      const idx = num(d.elementIndex);
      return (
        <div>
          ▸ {action}
          {idx !== null ? ` #${idx}` : ""}
        </div>
      );
    }
    case "tool_result": {
      // core 三值语义（views.ts:59-64 核实）：success=true 仅 done 动作、常规成功
      // 恒 null（构造器强制）——判 ok 不能用 success===true（全部常规成功会被渲染
      // 成失败）；失败 = error 非空（act.ts 同款判据）或 success===false（denied/
      // submit 拒绝路径显式置 false）
      const error = str(d.error);
      const ok = error === null && d.success !== false;
      const secs = num(d.durationSeconds);
      if (ok) {
        return <div className="tc-ev-ok">✓ 动作成功{secs !== null ? `（${secs}s）` : ""}</div>;
      }
      return (
        <div className="tc-ev-err" title={error ?? undefined}>
          ✗ {clip(error ?? "动作失败", 1000)}
        </div>
      );
    }
    case "model_result": {
      const action = str(d.actionName);
      const goal = str(d.nextGoal);
      const inTok = num(d.inputTokens);
      const outTok = num(d.outputTokens);
      return (
        <div>
          ✦ {action ?? "模型"}
          {goal !== null ? `：${clip(goal, 500)}` : ""}
          {inTok !== null || outTok !== null ? (
            <>
              {" "}
              <Badge tone="accent">
                ⇅ {inTok ?? "?"}/{outTok ?? "?"}
              </Badge>
            </>
          ) : null}
        </div>
      );
    }
    case "model_call": {
      const count = num(d.messageCount);
      return (
        <div className="tc-ev-muted">模型调用{count !== null ? `（${count} 条消息）` : ""}</div>
      );
    }
    case "session_end": {
      const summary = str(d.summary);
      return (
        <div className="tc-ev-ok" title={summary ?? undefined}>
          ■ 会话结束{summary !== null ? `：${clip(summary, 1000)}` : ""}
        </div>
      );
    }
    case "anomaly": {
      const rule = str(d.rule) ?? "anomaly";
      const desc = str(d.description) ?? "";
      const severity = str(d.severity);
      return (
        <div className="tc-ev-warn" title={desc}>
          ⚠ [{rule}]{severity !== null ? `(${severity})` : ""} {clip(desc, 500)}
        </div>
      );
    }
    case "skill_active": {
      const host = str(d.host);
      const slug = str(d.taskSlug);
      const loaded = d.skillLoaded === true;
      return (
        <div className="tc-ev-muted">
          ✚ skill {host ?? "?"}
          {slug !== null ? `/${slug}` : ""} {loaded ? "命中" : "未命中"}
        </div>
      );
    }
    default:
      return <div className="tc-ev-muted">{event.type}</div>;
  }
}

/**
 * 连续重复 skill_active 的展示去重（段 F 验收反馈：未命中站点每步一行是噪音）。
 * 数据层不动（每步一条是 Python 同款可观测契约——host 随导航变化须逐步解析），
 * 仅显示层折叠：与上一条 skill_active 同 host 且同命中态 → 不渲染。
 */
export function repeatedSkillSeqs(events: JournalEvent[]): Set<number> {
  const hidden = new Set<number>();
  let prev: { host: string | null; loaded: boolean } | null = null;
  for (const e of events) {
    if (e.type !== "skill_active") continue;
    const d = isRecord(e.data) ? e.data : {};
    const host = str(d.host);
    const loaded = d.skillLoaded === true;
    if (prev !== null && prev.host === host && prev.loaded === loaded) {
      hidden.add(e.seq);
    }
    prev = { host, loaded };
  }
  return hidden;
}

export interface RunTimelineProps {
  events: JournalEvent[];
  /** 环淘汰提示（seq 之前有被丢弃事件时 UI 留痕） */
  discardedBeforeSeq?: number;
  stepCount?: number;
}

export function RunTimeline({ events, discardedBeforeSeq = 0, stepCount }: RunTimelineProps) {
  if (events.length === 0 && discardedBeforeSeq === 0) {
    return <p className="tc-ev-muted">（尚无事件）</p>;
  }
  const groups = groupByStep(events);
  const hidden = repeatedSkillSeqs(events);
  return (
    <div className="tc-timeline" data-testid="run-timeline">
      {discardedBeforeSeq > 0 ? (
        <div className="tc-ev-muted">⋯ seq {discardedBeforeSeq} 之前的事件已被淘汰</div>
      ) : null}
      {groups.map((g) => (
        <details key={g.key} open>
          <summary>
            {g.step !== null ? `第 ${g.step} 步` : "事件流"}
            {stepCount !== undefined ? ` / 共 ${stepCount} 步` : ""}
          </summary>
          <div className="tc-timeline-body">
            {g.events.map((e) => (hidden.has(e.seq) ? null : <EventLine key={e.seq} event={e} />))}
          </div>
        </details>
      ))}
    </div>
  );
}
