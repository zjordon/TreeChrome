// decide 决策表纯函数全组合（04 §1.2：once/always 命中、fail-closed、默认 prompt）
// + PolicyGate 组合面（判定顺序/交互异常超时按 deny/allow-once·always 记账/
// clearOnce）+ AutoAllowPolicy 记账。

import { describe, expect, it } from "vitest";
import { AutoAllowPolicy } from "../../src/policy/auto-allow.js";
import { decide } from "../../src/policy/gate.js";
import type { Grant, GrantStore } from "../../src/policy/grants.js";
import { InMemoryGrantStore } from "../../src/policy/grants.js";
import {
  type PermissionRequest,
  type PermissionVerdict,
  PolicyGate,
} from "../../src/policy/policy.js";

const REQ = {
  actionName: "click",
  params: { index: 3 },
  tabId: "TAB1",
  elementIndex: 3,
  elementBbox: { left: 0, top: 0, width: 10, height: 10 },
  elementXpath: "//a[1]",
} as const;

function gateWith(
  verdicts: PermissionVerdict[] | "deny" | Error,
  store: GrantStore | null = null,
  options: { promptTimeoutMs?: number } = {},
) {
  const seen: PermissionRequest[] = [];
  const interaction = {
    requestPermission: async (req: PermissionRequest): Promise<PermissionVerdict> => {
      seen.push(req);
      if (verdicts instanceof Error) throw verdicts;
      if (verdicts === "deny") return "deny";
      const v = verdicts.shift();
      return (v ?? "deny") as PermissionVerdict;
    },
    confirmSubmit: async () => true,
  };
  return { gate: new PolicyGate(interaction, store, options), seen };
}

describe("decide 决策表（纯函数）", () => {
  const onceAllow: Grant = {
    capability: "CLICK",
    host: "a.example",
    decision: "allow",
    duration: "once",
    tabId: "TAB1",
    createdAt: 0,
  };
  const alwaysDeny: Grant = { ...onceAllow, decision: "deny", duration: "always", tabId: null };

  it("无授权 → prompt（默认保守面）", () => {
    expect(decide("CLICK", "a.example", [])).toBe("prompt");
  });

  it("授权命中 → 其决定", () => {
    expect(decide("CLICK", "a.example", [onceAllow])).toBe("allow");
    expect(decide("CLICK", "a.example", [alwaysDeny])).toBe("deny");
  });

  it("host/capability 不匹配不命中", () => {
    expect(decide("CLICK", "b.example", [onceAllow])).toBe("prompt");
    expect(decide("TYPE", "a.example", [onceAllow])).toBe("prompt");
  });

  it("host 空 → fail-closed deny", () => {
    expect(decide("CLICK", "", [])).toBe("deny");
    expect(decide("CLICK", "", [onceAllow])).toBe("deny");
  });
});

describe("PolicyGate.check", () => {
  it("fail-closed：host 空 → 拒绝（不问交互）", async () => {
    const { gate, seen } = gateWith("deny");
    const out = await gate.check({ ...REQ, capability: "CLICK", host: "" });
    expect(out.allowed).toBe(false);
    expect(out.reason).toContain("无法识别目标站点 host");
    expect(seen.length).toBe(0);
  });

  it("判定顺序一：once 命中（本 tab）直过——后续同键不再问", async () => {
    const { gate, seen } = gateWith(["allow-once", "allow-once"]);
    expect((await gate.check({ ...REQ, capability: "CLICK", host: "a.example" })).allowed).toBe(
      true,
    );
    const again = await gate.check({ ...REQ, capability: "CLICK", host: "a.example" });
    expect(again.allowed).toBe(true);
    expect(seen.length).toBe(1);
  });

  it("once 绑 tab：他 tab 的 once 授权不可见（各问各的）", async () => {
    const { gate, seen } = gateWith(["allow-once", "allow-once"]);
    await gate.check({ ...REQ, tabId: "TAB1", capability: "CLICK", host: "a.example" });
    const out = await gate.check({ ...REQ, tabId: "TAB2", capability: "CLICK", host: "a.example" });
    expect(out.allowed).toBe(true);
    expect(seen.length).toBe(2);
  });

  it("判定顺序二：always 命中（store 载入，deny 同样直效）——不问交互", async () => {
    const store = new InMemoryGrantStore();
    await store.saveAlways([
      {
        capability: "CLICK",
        host: "a.example",
        decision: "deny",
        duration: "always",
        tabId: null,
        createdAt: 0,
      },
    ]);
    const { gate, seen } = gateWith(["allow-once"], store);
    const out = await gate.check({ ...REQ, tabId: "TAB1", capability: "CLICK", host: "a.example" });
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("用户拒绝在 a.example 上 点击，不要重试，可改道或询问");
    expect(seen.length).toBe(0);
  });

  it("prompt → allow-always：记账 + 持久化 + 同键覆盖 + 跨 tab 全局", async () => {
    const store = new InMemoryGrantStore();
    const { gate, seen } = gateWith(["allow-always"], store);
    expect((await gate.check({ ...REQ, capability: "CLICK", host: "a.example" })).allowed).toBe(
      true,
    );
    expect(seen[0]?.capability).toBe("CLICK");
    const persisted = await store.loadAlways();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      capability: "CLICK",
      host: "a.example",
      duration: "always",
    });
    // 再查同键：always 命中，不再问
    expect((await gate.check({ ...REQ, capability: "CLICK", host: "a.example" })).allowed).toBe(
      true,
    );
    expect(
      (await gate.check({ ...REQ, tabId: "OTHER", capability: "CLICK", host: "a.example" }))
        .allowed,
    ).toBe(true);
    expect(seen.length).toBe(1);
  });

  it("prompt → deny：拒绝文案（架构 §5.1 模板逐字）", async () => {
    const { gate } = gateWith("deny");
    const out = await gate.check({ ...REQ, capability: "CLICK", host: "a.example" });
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("用户拒绝在 a.example 上 点击，不要重试，可改道或询问");
  });

  it("交互异常 → 按 deny（边界纪律）", async () => {
    const { gate } = gateWith(new Error("UI crashed"));
    const out = await gate.check({ ...REQ, capability: "TYPE", host: "a.example" });
    expect(out.allowed).toBe(false);
    expect(out.reason).toContain("用户拒绝在 a.example 上 输入");
  });

  it("交互超时 → 按 deny；迟到结果不记账", async () => {
    // holder 对象规避 TS CFA 对闭包内赋值的 null 收窄（executor 同步先跑，必非 null）
    const late: { resolve: ((v: PermissionVerdict) => void) | null } = { resolve: null };
    const interaction = {
      requestPermission: () =>
        new Promise<PermissionVerdict>((resolve) => {
          late.resolve = resolve;
        }),
      confirmSubmit: async () => true,
    };
    const gate = new PolicyGate(interaction, null, { promptTimeoutMs: 20 });
    const out = await gate.check({ ...REQ, capability: "CLICK", host: "a.example" });
    expect(out.allowed).toBe(false);
    expect(out.reason).toContain("用户拒绝在 a.example 上 点击");
    late.resolve?.("allow-always");
    await new Promise((r) => setTimeout(r, 5));
    // 迟到的 allow 不落账：同 gate 复检同键仍走 prompt（本交互永挂 → 再超时按 deny）
    const again = await gate.check({ ...REQ, capability: "CLICK", host: "a.example" });
    expect(again.allowed).toBe(false);
  });

  it("clearOnce：按 tab 清；always 不受影响", async () => {
    const store = new InMemoryGrantStore();
    const { gate } = gateWith(["allow-always", "allow-once", "deny"], store);
    await gate.check({ ...REQ, tabId: "TAB1", capability: "CLICK", host: "a.example" }); // always
    await gate.check({ ...REQ, tabId: "TAB1", capability: "TYPE", host: "a.example" }); // once
    gate.clearOnce("TAB1");
    // TYPE once 已清 → 重新问（脚本队列下一个是 deny）
    const out = await gate.check({ ...REQ, tabId: "TAB1", capability: "TYPE", host: "a.example" });
    expect(out.allowed).toBe(false);
    // CLICK always 仍在
    const keep = await gate.check({
      ...REQ,
      tabId: "TAB1",
      capability: "CLICK",
      host: "a.example",
    });
    expect(keep.allowed).toBe(true);
  });

  it("store 读失败 → 按空授权起步（不抛，走 prompt）", async () => {
    const broken: GrantStore = {
      loadAlways: () => Promise.reject(new Error("storage down")),
      saveAlways: () => Promise.resolve(),
    };
    const { gate, seen } = gateWith("deny", broken);
    const out = await gate.check({ ...REQ, capability: "CLICK", host: "a.example" });
    expect(out.allowed).toBe(false);
    expect(seen.length).toBe(1);
  });

  it("store 写失败 → 本回合授权仍生效（尽力持久化）", async () => {
    const store = new InMemoryGrantStore();
    const originalSave = store.saveAlways.bind(store);
    let saved = false;
    const flaky: GrantStore = {
      loadAlways: () => store.loadAlways(),
      saveAlways: async (grants) => {
        try {
          await originalSave(grants);
        } finally {
          saved = true;
        }
        throw new Error("quota exceeded");
      },
    };
    const { gate } = gateWith(["allow-always"], flaky);
    expect((await gate.check({ ...REQ, capability: "CLICK", host: "a.example" })).allowed).toBe(
      true,
    );
    expect(saved).toBe(true);
    const again = await gate.check({ ...REQ, capability: "CLICK", host: "a.example" });
    expect(again.allowed).toBe(true);
  });

  it("listAlwaysGrants 暴露当前 always 面（设置页撤销可见）", async () => {
    const store = new InMemoryGrantStore();
    const { gate } = gateWith(["allow-always"], store);
    await gate.check({ ...REQ, capability: "CLICK", host: "a.example" });
    expect(await gate.listAlwaysGrants()).toHaveLength(1);
  });
});

describe("AutoAllowPolicy（评测口径）", () => {
  it("无条件放行 + 请求全量记账", async () => {
    const auto = new AutoAllowPolicy();
    const req: PermissionRequest = { ...REQ, capability: "CLICK", host: "a.example" };
    await expect(auto.requestPermission(req)).resolves.toBe("allow-once");
    await expect(auto.requestPermission({ ...req, capability: "TYPE" })).resolves.toBe(
      "allow-once",
    );
    expect(auto.requests.map((r) => r.capability)).toEqual(["CLICK", "TYPE"]);
    await expect(auto.confirmSubmit(req)).resolves.toBe(true);
  });
});
