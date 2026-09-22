/** cdp-batch 移植单测：两阶段超时 + 选择性重试的状态机全覆盖 */
import { describe, expect, it } from "vitest";
import { CdpSourceStatus, runCdpBatch, withTimeoutMs } from "../src/cdp-batch.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAST = { firstTimeout: 1, retryTimeout: 1 };

describe("runCdpBatch", () => {
  it("全部成功：逐源 ok，按名取值", async () => {
    const batch = await runCdpBatch(
      new Map<string, () => Promise<unknown>>([
        ["a", async () => 1],
        ["b", async () => "x"],
      ]),
      FAST,
    );
    expect(batch.get("a")).toBe(1);
    expect(batch.get("b")).toBe("x");
    expect(batch.get("missing", "dft")).toBe("dft");
    expect(batch.failedNames).toEqual([]);
    expect([...batch.sources.keys()]).toEqual(["a", "b"]);
    expect(batch.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("首批失败、重试成功 → retried_ok，值可用", async () => {
    let calls = 0;
    const batch = await runCdpBatch(
      new Map<string, () => Promise<unknown>>([
        [
          "flaky",
          () => {
            if (calls++ === 0) return Promise.reject(new Error("first boom"));
            return Promise.resolve(42);
          },
        ],
      ]),
      FAST,
    );
    expect(batch.get("flaky")).toBe(42);
    expect(batch.sources.get("flaky")?.status).toBe(CdpSourceStatus.RetriedOk);
    expect(batch.sources.get("flaky")?.firstAttemptMs).toBeGreaterThanOrEqual(0);
    expect(batch.failedNames).toEqual([]);
  });

  it("两阶段均挂起 → timeout，默认值回退，永不抛", async () => {
    const batch = await runCdpBatch(
      new Map<string, () => Promise<unknown>>([["hang", () => new Promise<never>(() => {})]]),
      {
        firstTimeout: 0.02,
        retryTimeout: 0.02,
      },
    );
    expect(batch.sources.get("hang")?.status).toBe(CdpSourceStatus.Timeout);
    expect(batch.get("hang", "fallback")).toBe("fallback");
    expect(batch.failedNames).toEqual(["hang"]);
  });

  it("首批快速失败、重试挂起 → timeout（覆盖 failed→timeout 迁移）", async () => {
    let calls = 0;
    const batch = await runCdpBatch(
      new Map<string, () => Promise<unknown>>([
        [
          "mixed",
          () => {
            if (calls++ === 0) return Promise.reject(new Error("boom"));
            return new Promise<never>(() => {});
          },
        ],
      ]),
      { firstTimeout: 0.05, retryTimeout: 0.02 },
    );
    expect(batch.sources.get("mixed")?.status).toBe(CdpSourceStatus.Timeout);
    expect(batch.sources.get("mixed")?.error).toBe("timed out");
  });

  it("两阶段均抛错 → failed，错误消息保留", async () => {
    const batch = await runCdpBatch(
      new Map<string, () => Promise<unknown>>([
        [
          "bad",
          () => {
            throw new Error("always broken");
          },
        ],
      ]),
      FAST,
    );
    expect(batch.sources.get("bad")?.status).toBe(CdpSourceStatus.Failed);
    expect(batch.sources.get("bad")?.error).toBe("always broken");
    expect(batch.failedNames).toEqual(["bad"]);
  });

  it("底层恰好以同文案 'timed out' reject → 仍是 failed 非超时（评审 #8）", async () => {
    const batch = await runCdpBatch(
      new Map<string, () => Promise<unknown>>([
        ["mimic", () => Promise.reject(new Error("timed out"))],
      ]),
      FAST,
    );
    expect(batch.sources.get("mimic")?.status).toBe(CdpSourceStatus.Failed);
  });

  it("成功源不受失败源重试拖累（选择性重试只跑失败者）", async () => {
    let okCalls = 0;
    let flakyCalls = 0;
    const batch = await runCdpBatch(
      new Map<string, () => Promise<unknown>>([
        [
          "ok",
          () => {
            okCalls++;
            return Promise.resolve("v");
          },
        ],
        [
          "flaky",
          () => {
            flakyCalls++;
            return flakyCalls === 1 ? Promise.reject(new Error("x")) : Promise.resolve("r");
          },
        ],
      ]),
      FAST,
    );
    expect(okCalls).toBe(1);
    expect(flakyCalls).toBe(2);
    expect(batch.get("ok")).toBe("v");
    expect(batch.get("flaky")).toBe("r");
  });
});

describe("withTimeoutMs", () => {
  it("截止内完成 → 原值", async () => {
    expect(await withTimeoutMs(Promise.resolve("v"), 1000)).toBe("v");
  });

  it("超时 → 拒绝且底层 Promise 的迟来拒绝被吞掉", async () => {
    const late = sleep(50).then(() => {
      throw new Error("late rejection");
    });
    await expect(withTimeoutMs(late, 10)).rejects.toThrow("timed out");
    await sleep(80); // 等 late 真正 reject，验证无 unhandledRejection
  });
});
