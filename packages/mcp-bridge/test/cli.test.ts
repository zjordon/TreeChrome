// CLI 单测（issue #31 M1 P1）：端口解析 + connect/status 命令（fetch 注入，不发真
// 网络）+ 落盘 store/令牌生成/serveBridge 真回环装配；serve 常驻分支由 e2e（P5）覆盖。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  defaultPairingPath,
  FsPairingStore,
  newPairingToken,
  resolveBridgePort,
  runBridgeCli,
  serveBridge,
} from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function collectors(): { log: string[]; err: string[] } {
  return { log: [], err: [] };
}

describe("resolveBridgePort", () => {
  it("TC_BRIDGE_PORT 生效；垃圾/越界值回缺省 18730", () => {
    expect(resolveBridgePort({ TC_BRIDGE_PORT: "9999" })).toBe(9999);
    expect(resolveBridgePort({})).toBe(18730);
    expect(resolveBridgePort({ TC_BRIDGE_PORT: "abc" })).toBe(18730);
    expect(resolveBridgePort({ TC_BRIDGE_PORT: "70000" })).toBe(18730);
    expect(resolveBridgePort({ TC_BRIDGE_PORT: "0" })).toBe(18730);
  });
});

describe("runBridgeCli", () => {
  it("未知命令 → usage + exit 2", async () => {
    const c = collectors();
    const code = await runBridgeCli(["frob"], {
      env: {},
      log: (m) => c.log.push(m),
      err: (m) => c.err.push(m),
    });
    expect(code).toBe(2);
    expect(c.err[0]).toContain("usage");
  });

  it("--port 非法 / 缺值 → exit 2", async () => {
    const c = collectors();
    const code = await runBridgeCli(["status", "--port", "nope"], {
      env: {},
      log: (m) => c.log.push(m),
      err: (m) => c.err.push(m),
    });
    expect(code).toBe(2);
    expect(c.err[0]).toContain("invalid port");

    const tail = collectors();
    const codeTail = await runBridgeCli(["status", "--port"], {
      env: {},
      log: (m) => tail.log.push(m),
      err: (m) => tail.err.push(m),
    });
    expect(codeTail).toBe(2);
    expect(tail.err[0]).toContain("invalid port");
  });

  it("不注入 deps：usage 路径走缺省 env/log/err（不触网络）", async () => {
    expect(await runBridgeCli(["frob"])).toBe(2);
  });

  it("connect：打印桥签发的配对 URL", async () => {
    const c = collectors();
    const code = await runBridgeCli(["connect"], {
      env: {},
      log: (m) => c.log.push(m),
      err: (m) => c.err.push(m),
      fetch: async () =>
        jsonResponse({ ok: true, t: "t0", url: "http://127.0.0.1:18730/tc-connect?t=t0" }),
    });
    expect(code).toBe(0);
    expect(c.log.join("\n")).toContain("/tc-connect?t=t0");
  });

  it("connect：桥未起（fetch 抛）→ exit 2 + 提示", async () => {
    const c = collectors();
    const code = await runBridgeCli(["connect"], {
      env: {},
      log: (m) => c.log.push(m),
      err: (m) => c.err.push(m),
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(code).toBe(2);
    expect(c.err[0]).toContain("unavailable");
  });

  it("status：打印 health JSON；非 2xx → exit 2", async () => {
    const ok = collectors();
    const code = await runBridgeCli(["status"], {
      env: {},
      log: (m) => ok.log.push(m),
      err: (m) => ok.err.push(m),
      fetch: async () => jsonResponse({ ok: true, instanceId: "inst-9", status: {} }),
    });
    expect(code).toBe(0);
    expect(ok.log[0]).toContain("inst-9");

    const bad = collectors();
    const codeBad = await runBridgeCli(["status"], {
      env: {},
      log: (m) => bad.log.push(m),
      err: (m) => bad.err.push(m),
      fetch: async () => jsonResponse({ error: "down" }, 503),
    });
    expect(codeBad).toBe(2);
    expect(bad.err[0]).toContain("unavailable");
  });

  it("connect：桥拒绝（非 2xx）→ exit 2", async () => {
    const c = collectors();
    const code = await runBridgeCli(["connect"], {
      env: {},
      log: (m) => c.log.push(m),
      err: (m) => c.err.push(m),
      fetch: async () => jsonResponse({ error: "no" }, 500),
    });
    expect(code).toBe(2);
  });

  it("connect：响应缺 url → 打印占位", async () => {
    const c = collectors();
    const code = await runBridgeCli(["connect"], {
      env: {},
      log: (m) => c.log.push(m),
      err: (m) => c.err.push(m),
      fetch: async () => jsonResponse({ ok: true }),
    });
    expect(code).toBe(0);
    expect(c.log.join("\n")).toContain("(no url)");
  });

  it("serve：起服务打印端点后常驻不结算（serve 注入）", async () => {
    const c = collectors();
    // void 表达永不结算——serve 的常驻语义就是挂着不返回
    void runBridgeCli(["serve"], {
      env: {},
      log: (m) => c.log.push(m),
      err: (m) => c.err.push(m),
      serve: async () =>
        ({
          endpoint: "http://127.0.0.1:19999",
          port: 19999,
          instanceId: "i",
          state: null,
          close: async () => {},
        }) as unknown as import("../src/index.js").BridgeServer,
    });
    await vi.waitFor(() => expect(c.log.join("\n")).toContain("listening"));
  });
});

describe("FsPairingStore（落盘免再确认）", () => {
  it("save/load/remove 往返；缺文件与坏文件都回 null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-bridge-store-"));
    try {
      const store = new FsPairingStore(join(dir, "pairing.json"));
      await expect(store.load()).resolves.toBeNull();
      const record = { pairingToken: "p", extensionId: "e", name: "n" };
      await store.save(record);
      await expect(store.load()).resolves.toEqual(record);
      await store.remove();
      await expect(store.load()).resolves.toBeNull();
      writeFileSync(join(dir, "pairing.json"), "{bad", "utf8");
      await expect(store.load()).resolves.toBeNull();
      writeFileSync(join(dir, "pairing.json"), "[]", "utf8");
      await expect(store.load()).resolves.toBeNull();
      writeFileSync(
        join(dir, "pairing.json"),
        JSON.stringify({ pairingToken: 1, extensionId: "e", name: "n" }),
        "utf8",
      );
      await expect(store.load()).resolves.toBeNull();
      await store.remove();
      await expect(store.load()).resolves.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaultPairingPath：~/.tc/bridge/pairing.json", () => {
    expect(defaultPairingPath()).toContain(join(".tc", "bridge", "pairing.json"));
  });
});

describe("newPairingToken", () => {
  it("base64url 32 字节（43 字符）且每次随机", () => {
    const a = newPairingToken();
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(a).not.toBe(newPairingToken());
  });
});

describe("serveBridge（装配面：instanceId 单源 + 真回环）", () => {
  it("/health 可达且 instanceId 一致", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-bridge-serve-"));
    const server = await serveBridge({
      port: 0,
      pairingPath: join(dir, "pairing.json"),
      instanceId: "inst-x",
    });
    try {
      const res = await fetch(`${server.endpoint}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { instanceId: string; status: { paired: boolean } };
      expect(body.instanceId).toBe("inst-x");
      expect(body.status.paired).toBe(false);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
