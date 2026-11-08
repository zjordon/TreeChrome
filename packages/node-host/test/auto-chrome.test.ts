// auto-chrome 离线单测（issue #26 D2）：路径候选表 / 二进制解析 / 拉起-就绪-回收
//（spawn/probe/killTree/rm 全注入）；纪律断言——回收只动自己 spawn 的 pid。

import { describe, expect, test, vi } from "vitest";
import {
  chromePathCandidates,
  type LaunchedChrome,
  launchAutoChrome,
  resolveChromeBinary,
} from "../src/index.js";

describe("chromePathCandidates / resolveChromeBinary", () => {
  test("CHROME_PATH 显式优先；平台候选表按序（win/mac/linux 各证）", () => {
    const win = chromePathCandidates("win32", { CHROME_PATH: "D:/chrome.exe" }, "C:/Users/u");
    expect(win[0]).toBe("D:/chrome.exe");
    expect(win[1]).toContain("Google\\Chrome");
    // LOCALAPPDATA 注入时进候选（join 产物分隔符随宿主平台——断言前归一，评审轮 1 [4]）
    const winLocal = chromePathCandidates(
      "win32",
      { LOCALAPPDATA: "C:/Users/u/AppData/Local" },
      "C:/Users/u",
    );
    expect(winLocal[0].replaceAll("\\", "/")).toContain("AppData/Local");
    const mac = chromePathCandidates("darwin", {}, "/Users/u");
    expect(mac).toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    const linux = chromePathCandidates("linux", {}, "/home/u");
    expect(linux[0]).toBe("/usr/bin/google-chrome");
  });

  test("resolveChromeBinary：首个 exists 命中；全不存在 → null", () => {
    expect(
      resolveChromeBinary({
        env: { CHROME_PATH: "D:/custom/chrome.exe" },
        exists: (p) => p === "D:/custom/chrome.exe",
      }),
    ).toBe("D:/custom/chrome.exe");
    expect(resolveChromeBinary({ env: {}, exists: () => false })).toBeNull();
  });
});

describe("launchAutoChrome（注入面）", () => {
  const depsOf = (over: {
    probeCalls?: number; // 前几次 probe 失败
    spawnPid?: number;
  }) => {
    let probeCalls = 0;
    const spawned: { binary: string; args: string[] }[] = [];
    const killed: number[] = [];
    const removed: string[] = [];
    const deps = {
      env: { CHROME_PATH: "C:/x/chrome.exe" },
      exists: () => true,
      mkdtemp: (prefix: string) => `${prefix}ABC`,
      spawnChrome: (binary: string, args: string[]) => {
        spawned.push({ binary, args });
        return { pid: over.spawnPid ?? 4242 };
      },
      sleep: async () => {},
      probe: async () => {
        probeCalls += 1;
        if (probeCalls <= (over.probeCalls ?? 0)) {
          throw new Error("not ready");
        }
        return {};
      },
      killTree: async (pid: number) => {
        killed.push(pid);
      },
      rm: (dir: string) => {
        removed.push(dir);
      },
    };
    return { deps, spawned, killed, removed };
  };

  test("拉起参数完整（headless/端口/临时 profile）；probe 失败两次后就绪", async () => {
    const { deps, spawned } = depsOf({ probeCalls: 2 });
    const chrome = await launchAutoChrome({ port: 9333, deps });
    expect(spawned[0].binary).toBe("C:/x/chrome.exe");
    expect(spawned[0].args).toContain("--headless=new");
    expect(spawned[0].args).toContain("--remote-debugging-port=9333");
    expect(spawned[0].args.some((a) => a.startsWith("--user-data-dir="))).toBe(true);
    expect(chrome.pid).toBe(4242);
    expect(chrome.cdpPort).toBe(9333);
  });

  test("找不到二进制 → 中文文案错误", async () => {
    const { deps } = depsOf({});
    deps.exists = () => false;
    await expect(launchAutoChrome({ port: 9333, deps })).rejects.toThrow("CHROME_PATH");
  });

  test("pid 非法（<=0）→ 拉起失败错误，且 profile 已尽力回收（不留残留，评审轮 1 [5]）", async () => {
    const { deps, removed } = depsOf({ spawnPid: -1 });
    await expect(launchAutoChrome({ port: 9333, deps })).rejects.toThrow("拉起失败");
    expect(removed).toHaveLength(1);
  });

  test("stop 回收纪律：只杀自己 spawn 的 pid + 删自己的 profile；幂等", async () => {
    const { deps, killed, removed } = depsOf({});
    const chrome: LaunchedChrome = await launchAutoChrome({ port: 9333, deps });
    const warns: string[] = [];
    await chrome.stop((m) => warns.push(m));
    expect(killed).toEqual([4242]); // 只杀自己 spawn 的 pid
    expect(removed).toEqual([chrome.profileDir]);
    expect(warns).toHaveLength(0);
    // 幂等：二次 stop 不再杀/删
    await chrome.stop((m) => warns.push(m));
    expect(killed).toHaveLength(1);
    expect(removed).toHaveLength(1);
  });

  test("stop 清理失败只 warn 不抛（kill 抛 / rm 恒抛各证）", async () => {
    const base = depsOf({});
    base.deps.killTree = async () => {
      throw new Error("kill boom");
    };
    const a: LaunchedChrome = await launchAutoChrome({ port: 9333, deps: base.deps });
    const warns: string[] = [];
    await expect(a.stop((m) => warns.push(m))).resolves.toBeUndefined();
    expect(warns.some((w) => w.includes("kill boom"))).toBe(true);

    const b2 = depsOf({});
    b2.deps.rm = () => {
      throw new Error("rm boom");
    };
    const b: LaunchedChrome = await launchAutoChrome({ port: 9333, deps: b2.deps });
    const warns2: string[] = [];
    await expect(b.stop((m) => warns2.push(m))).resolves.toBeUndefined();
    expect(warns2.some((w) => w.includes("rm boom"))).toBe(true); // 3 次重试穷尽后 warn
  });

  test("stop 的 rm 撞锁重试：首败次成 → 不告警（Windows 句柄异步释放场景）", async () => {
    const { deps } = depsOf({});
    let rmCalls = 0;
    deps.rm = (dir: string) => {
      rmCalls += 1;
      if (rmCalls === 1) {
        throw new Error("EBUSY");
      }
      return undefined;
    };
    const chrome: LaunchedChrome = await launchAutoChrome({ port: 9333, deps });
    const warns: string[] = [];
    await chrome.stop((m) => warns.push(m));
    expect(rmCalls).toBe(2);
    expect(warns).toHaveLength(0);
  });

  test("就绪超时路径：抛错前回收（kill + rm）；rm 恒败不顶替「就绪超时」原始错误（评审轮 1 [3]）", async () => {
    vi.useFakeTimers();
    try {
      const { deps, killed, removed } = depsOf({});
      deps.probe = async () => {
        throw new Error("never ready");
      };
      // fake timers + 真实 deadline：把系统时钟推进 16s 再断言抛错
      const p = launchAutoChrome({ port: 9333, deps });
      // deadline 在 await 挂起期间判定——推进虚拟时钟让 Date.now() 越过窗口
      vi.setSystemTime(Date.now() + 16_000);
      // sleep 是注入的立即 resolve，循环会快速空转至 deadline
      await expect(p).rejects.toThrow("就绪超时");
      expect(killed).toEqual([4242]);
      expect(removed).toHaveLength(1);

      // rm 恒抛（EBUSY 竞态穷尽）：错误仍必须是「就绪超时」，不得被 rm 异常顶替
      const b2 = depsOf({});
      b2.deps.probe = async () => {
        throw new Error("never ready");
      };
      b2.deps.rm = () => {
        throw new Error("EBUSY");
      };
      const p2 = launchAutoChrome({ port: 9333, deps: b2.deps });
      vi.setSystemTime(Date.now() + 16_000);
      await expect(p2).rejects.toThrow("就绪超时");
    } finally {
      vi.useRealTimers();
    }
  });
});
