// Chrome 自动拉起（issue #26 D2，`tc run --auto-chrome`）：发现 CDP 不通时 spawn
// 临时 profile 的 headless Chrome、等待就绪、按 PID 树精确回收。IO 全注入（可离线单测）。
// 纪律（#25 期间实证教训）：**绝不按映像名杀 Chrome**——只 kill 自己 spawn 的 pid
//（Windows `taskkill /PID x /T /F` 杀树；POSIX detached 进程组 kill）。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 平台标准 Chrome 路径候选（先 CHROME_PATH env，再按平台候选表） */
export function chromePathCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string[] {
  const explicit = env.CHROME_PATH || undefined;
  const localAppData = env.LOCALAPPDATA;
  const byPlatform: Record<string, string[]> = {
    win32: [
      ...(localAppData !== undefined
        ? [join(localAppData, "Google", "Chrome", "Application", "chrome.exe")]
        : []),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
    darwin: [
      join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ],
  };
  return [...(explicit !== undefined ? [explicit] : []), ...(byPlatform[platform] ?? [])];
}

export interface AutoChromeDeps {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (path: string) => boolean;
  mkdtemp?: (prefix: string) => string;
  /** 真实现：spawn chrome（detached）；测试注入记录参数并回假 pid */
  spawnChrome?: (binary: string, args: string[]) => { pid: number };
  sleep?: (ms: number) => Promise<void>;
  /** CDP 就绪探针（GET /json/version）；测试注入失败次数序列 */
  probe?: (url: string) => Promise<unknown>;
  /** 真实现：按 pid 杀进程树；测试注入记录 */
  killTree?: (pid: number) => Promise<void>;
  rm?: (dir: string) => void;
}

const READY_TIMEOUT_MS = 15_000;
const PROBE_INTERVAL_MS = 250;

export interface LaunchedChrome {
  pid: number;
  profileDir: string;
  cdpPort: number;
  /** 幂等；清理失败只 warn 不抛（run 结果不受收尾影响） */
  stop: (warn: (message: string) => void) => Promise<void>;
}

/** 解析 Chrome 可执行文件路径（CHROME_PATH > 平台候选表逐个 exists）；找不到返回 null */
export function resolveChromeBinary(deps: AutoChromeDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const exists = deps.exists ?? existsSync;
  for (const candidate of chromePathCandidates(platform, env, home)) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

const defaultSpawnChrome = (binary: string, args: string[]): { pid: number } => {
  const child = spawn(binary, args, {
    detached: true, // POSIX 进程组（负 pid 组杀）；Windows 无组概念但不碍 taskkill /T
    stdio: "ignore",
  });
  // spawn 失败（路径是目录/EACCES/检查到拉起间 TOCTOU）已由 pid=-1 同步上抛收口；
  // 吞掉异步 'error' 事件——无监听的 EventEmitter 'error' 会 throw → 整进程崩溃
  //（评审轮 1 [1]）
  child.on("error", () => {});
  // 父进程不等长命子进程：--keep-chrome 下终态已打印、exitCode 已置，但事件循环
  // 仍被 child 句柄占住 → tc 挂起不退出（两个入口均只置 process.exitCode；评审轮 1 [2]）
  child.unref();
  return { pid: child.pid ?? -1 };
};

const defaultKillTree = async (pid: number): Promise<void> => {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM"); // detached → 负 pid = 进程组
  } catch {
    // 进程已退出：按已清理处理
  }
};

/**
 * 拉起临时 profile 的 headless Chrome 并等待 CDP 就绪。
 * 失败语义：找不到二进制 / 拉起失败 / 就绪超时 → 抛中文文案错误（main 侧收口
 * exit 2）；超时路径抛出前已回收（kill + rm），不留半启动状态。
 */
export async function launchAutoChrome(options: {
  port: number;
  deps?: AutoChromeDeps;
  log?: (message: string) => void;
}): Promise<LaunchedChrome> {
  const deps = options.deps ?? {};
  const log = options.log ?? (() => {});
  const binary = resolveChromeBinary(deps);
  if (binary === null) {
    throw new Error("未找到 Chrome 可执行文件（设 CHROME_PATH 或安装 Chrome 后重试）");
  }
  const mkdtemp = deps.mkdtemp ?? ((prefix: string) => mkdtempSync(prefix));
  const spawnChrome = deps.spawnChrome ?? defaultSpawnChrome;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const probe =
    deps.probe ??
    ((url: string) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()));

  const profileDir = mkdtemp(join(tmpdir(), "tc-auto-chrome-"));
  const killTree = deps.killTree ?? defaultKillTree;
  const rm = deps.rm ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));
  // Windows：taskkill /F 后句柄异步释放，立即 rm 常撞锁（真机实证）——短候 + 三次
  // 重试，穷尽才提示（可手删）；**清理失败绝不顶替/掩盖原始错误**（评审轮 1 [3][5]）
  const rmBestEffort = async (dir: string, warn: (message: string) => void): Promise<void> => {
    await sleep(300);
    for (let attempt = 0; ; attempt += 1) {
      try {
        rm(dir);
        return;
      } catch (e) {
        if (attempt >= 2) {
          warn(
            `[auto-chrome] 临时 profile 清理失败（${dir}，可手删）：${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          return;
        }
        await sleep(500);
      }
    }
  };

  const child = spawnChrome(binary, [
    "--headless=new",
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);
  if (child.pid <= 0) {
    // 拉起失败也回收 profile（mkdtemp 已建目录），不留残留；尽力清理不掩盖原始错误
    await rmBestEffort(profileDir, log);
    throw new Error(`Chrome 拉起失败（pid=${child.pid}）`);
  }
  log(`[auto-chrome] 已拉起 pid=${child.pid}（端口 ${options.port}，临时 profile）`);

  const url = `http://127.0.0.1:${options.port}/json/version`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      await probe(url);
      break;
    } catch {
      if (Date.now() >= deadline) {
        await killTree(child.pid).catch(() => {});
        await rmBestEffort(profileDir, log);
        throw new Error(`Chrome CDP 就绪超时（${READY_TIMEOUT_MS / 1000}s，端口 ${options.port}）`);
      }
      await sleep(PROBE_INTERVAL_MS);
    }
  }
  log(`[auto-chrome] CDP 就绪：${url}`);

  let stopped = false;
  return {
    pid: child.pid,
    profileDir,
    cdpPort: options.port,
    stop: async (warn) => {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        await killTree(child.pid);
      } catch (e) {
        warn(
          `[auto-chrome] 进程回收失败（pid=${child.pid}）：${e instanceof Error ? e.message : String(e)}`,
        );
      }
      await rmBestEffort(profileDir, warn);
    },
  };
}
