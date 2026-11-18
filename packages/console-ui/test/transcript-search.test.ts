// 转录搜索纯函数单测（issue #41 U4 批 B，验收①）：切分/计数/序号表/查询有效性。

import { describe, expect, it } from "vitest";
import type { RunBlockItem, UserTurnItem } from "../src/transcript.js";
import {
  countItemMatches,
  countTextMatches,
  isSearchableQuery,
  ordinalBasesOf,
  searchTextsOf,
  splitTextByQuery,
  totalTranscriptMatches,
} from "../src/transcript-search.js";

const user = (over: Partial<UserTurnItem> = {}): UserTurnItem => ({
  kind: "user-turn",
  turnId: "t1",
  task: "查询价格",
  status: "done",
  attachments: [],
  createdAt: 1,
  ...over,
});

const run = (over: Partial<RunBlockItem> = {}): RunBlockItem => ({
  kind: "run-block",
  runId: "r1",
  turnId: "t1",
  status: "done",
  events: [],
  stepCount: 0,
  startedAt: 1,
  endedAt: 2,
  finalResult: "结果是 42",
  lastError: null,
  discardedBeforeSeq: 0,
  ...over,
});

describe("splitTextByQuery", () => {
  it("无命中：整段非命中；空查询同", () => {
    expect(splitTextByQuery("abc", "z")).toEqual([{ text: "abc", hit: false }]);
    expect(splitTextByQuery("abc", "")).toEqual([{ text: "abc", hit: false }]);
  });

  it("多命中交替分段；大小写不敏感", () => {
    expect(splitTextByQuery("aXbXc", "x")).toEqual([
      { text: "a", hit: false },
      { text: "X", hit: true },
      { text: "b", hit: false },
      { text: "X", hit: true },
      { text: "c", hit: false },
    ]);
  });

  it("整串即命中；重叠不重复计（顺序扫描）", () => {
    expect(splitTextByQuery("xx", "xx")).toEqual([{ text: "xx", hit: true }]);
    expect(countTextMatches("aaa", "aa")).toBe(1);
  });
});

describe("isSearchableQuery", () => {
  it("空白/空查询不可搜", () => {
    expect(isSearchableQuery("")).toBe(false);
    expect(isSearchableQuery("   ")).toBe(false);
    expect(isSearchableQuery("价")).toBe(true);
  });
});

describe("searchTextsOf / countItemMatches / totalTranscriptMatches", () => {
  it("run 块可搜索面 = lastError + finalResult（DOM 序：错误行在结果前）；null 剔除", () => {
    expect(searchTextsOf(run({ lastError: "超时" }))).toEqual(["超时", "结果是 42"]);
    expect(searchTextsOf(run({ finalResult: null, lastError: "超时" }))).toEqual(["超时"]);
    expect(searchTextsOf(user())).toEqual(["查询价格"]);
  });

  it("条目与会话级计数跨文本求和；空查询恒 0", () => {
    const items = [
      user({ task: "查价格、比价格" }),
      run({ finalResult: "价格 42", lastError: "价格超时" }),
    ];
    expect(countItemMatches(items[0], "价格")).toBe(2);
    expect(countItemMatches(items[1], "价格")).toBe(2);
    expect(totalTranscriptMatches(items, "价格")).toBe(4);
    expect(totalTranscriptMatches(items, "")).toBe(0);
  });
});

describe("ordinalBasesOf", () => {
  it("条目序累计首命中序号；空查询空表", () => {
    const items = [
      user({ turnId: "a", task: "查价格" }),
      run({ runId: "b", finalResult: "价格", lastError: null }),
      user({ turnId: "c", task: "无关" }),
      user({ turnId: "d", task: "价格再来" }),
    ];
    const bases = ordinalBasesOf(items, "价格");
    expect(bases.get("a")).toBe(0);
    expect(bases.get("b")).toBe(1);
    expect(bases.get("c")).toBe(2); // 无命中条目也占表（base=前方累计）
    expect(bases.get("d")).toBe(2);
    expect(ordinalBasesOf(items, "")).toEqual(new Map());
  });
});
