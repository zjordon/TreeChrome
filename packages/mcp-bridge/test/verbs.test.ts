// 直驱动词 MCP 面单测（issue #32 M2 P3）：core 规格 → inputSchema 生成、
// camel/snake 互转、15+1 工具目录顺序锚定。

import { describe, expect, it } from "vitest";
import { buildDriveTools, camelOf, DRIVE_TOOLS, snakeOf } from "../src/index.js";

describe("buildDriveTools", () => {
  it("15 动词 + session_stop，顺序锚定（tools/list 契约）", () => {
    expect(DRIVE_TOOLS.map((tool) => tool.name)).toEqual([
      "get_state",
      "navigate",
      "click",
      "input_text",
      "select_dropdown",
      "scroll",
      "find_text",
      "read_grid",
      "evaluate",
      "screenshot",
      "upload_file",
      "go_back",
      "tabs",
      "switch_tab",
      "close_tab",
      "session_stop",
    ]);
  });

  it("schema 生成：snake→camel 属性名、required、四类型映射", () => {
    const tools = new Map(buildDriveTools().map((tool) => [tool.name, tool]));
    const navigate = tools.get("navigate");
    expect(navigate?.inputSchema).toEqual({
      type: "object",
      properties: { url: { type: "string" }, newTab: { type: "boolean" } },
      required: ["url"],
    });
    const click = tools.get("click");
    expect(click?.inputSchema.properties).toEqual({
      index: { type: "integer" },
      elementId: { type: "integer" },
    });
    expect(click?.inputSchema.required).toBeUndefined(); // XOR 无法用 required 表达
    expect(tools.get("upload_file")?.inputSchema.required).toEqual(["index", "path"]);
    expect(tools.get("read_grid")?.inputSchema.properties).toMatchObject({
      fields: { type: "array", items: { type: "string" } },
      pageSize: { type: "integer" },
      groupCount: { type: "string" },
    });
    expect(tools.get("get_state")?.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("camelOf/snakeOf 互转（含连续大写与无下划线恒等）", () => {
    for (const name of ["element_id", "new_tab", "case_sensitive", "timeout_ms", "index"]) {
      expect(snakeOf(camelOf(name))).toBe(name);
    }
    expect(camelOf("element_id")).toBe("elementId");
    expect(snakeOf("elementId")).toBe("element_id");
    expect(camelOf("index")).toBe("index");
  });

  it("每工具带描述（供给面 UX 文案不空）", () => {
    for (const tool of DRIVE_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(4);
    }
  });
});
