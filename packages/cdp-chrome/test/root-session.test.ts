// 段 A 骨架测试：根会话标记语义（transport 本体段 B 落地后扩面）。

import { describe, expect, it } from "vitest";
import { isRootSessionId, ROOT_SESSION_ID } from "../src/index.js";

describe("cdp-chrome 骨架", () => {
  it("ROOT_SESSION_ID 是私有命名空间标记（防与真实 CDP sessionId 撞车）", () => {
    // CDP sessionId 形如十六进制串；双下划线前缀不在其字符集内
    expect(ROOT_SESSION_ID).toBe("__tc_root__");
    expect(ROOT_SESSION_ID).not.toMatch(/^[0-9A-F]+$/);
  });

  it("isRootSessionId：undefined/null/标记 都算根会话（bindSend 的 ?? undefined 形态）", () => {
    expect(isRootSessionId(undefined)).toBe(true);
    expect(isRootSessionId(null)).toBe(true);
    expect(isRootSessionId(ROOT_SESSION_ID)).toBe(true);
  });

  it("isRootSessionId：真实子会话 id 不算根", () => {
    expect(isRootSessionId("4A5B6C7D8E9F00112233445566778899")).toBe(false);
    expect(isRootSessionId("")).toBe(false);
  });
});
