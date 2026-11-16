// 扩展侧直驱命令面（issue #32 M2 P2）：drive/session_stop 的 SW 实现。链序：
// 动词校验（core verb-specs 单源）→ run 互斥（BUSY，先查后 ensure 不白附
// debugger）→ 在场门（写类动词 SIDEPANEL_REQUIRED——决策点 ②；只读单源 =
// core resolveCapability "none"）→ 会话 ensure（epoch 就位）→ locator 代次
// 校验（INDEX_REQUIRES_STATE / EPOCH_STALE——决策点 ①）→ core 派发（特殊面
// 直调 browser，工具动词 tools.execute 走 lastState 线程）→ 响应恒携 epoch
// （桥侧簿记）。全动词审计留痕（注入 sink；upload 记完整路径——决策点 ④）。
// 领域错走 BridgeDriveResult 信封值而非 throw——bridge-runtime 的兜底会把抛出
// 抹成 TOOL_EXECUTION_FAILED，drive 专属 code 必须走信封。

import {
  type ActionResult,
  type BrowserStateSummary,
  type FileSystemProvider,
  findDriveVerb,
  projectDriveActionResult,
  projectDriveState,
  projectDriveTabs,
  resolveCapability,
  validateDriveParams,
} from "@tw/core";
import type { BridgeDriveResult, BridgeSessionStopResult, RunJournalSnapshot } from "@tw/protocol";
import type { StorageArea } from "../host/chrome-apis.js";
import type { DriveCore, DriveSession } from "./drive-session.js";

/** gateway 消费的最小会话面（DriveSession 结构性满足；测试可注入假件） */
export type DriveSessionFace = Pick<
  DriveSession,
  "active" | "busy" | "epoch" | "ensure" | "touch" | "stop"
>;

/** run 互斥判定面（RunJournal 结构性满足） */
export interface DriveJournalFace {
  current(): RunJournalSnapshot | null;
}

export interface DriveAuditEntry {
  at: number;
  verb: string;
  ok: boolean;
  code?: string;
  /** 审计细节（决策点 ④：upload_file 记完整绝对路径） */
  detail?: Record<string, unknown>;
}

export interface DriveGatewayDeps {
  session: DriveSessionFace;
  journal: DriveJournalFace;
  /** sidepanel 在场判定（决策点 ②：PortServer.hasPorts 注入） */
  hasSidepanel: () => boolean;
  audit: (entry: DriveAuditEntry) => void;
  now(): number;
  log?(message: string): void;
}

const TERMINAL_STATUS = new Set<string>(["done", "error", "interrupted"]);

const errText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function driveError(code: string, message: string, epoch?: number): BridgeDriveResult {
  return { ok: false, error: { code, message }, ...(epoch === undefined ? {} : { epoch }) };
}

export function createDriveGateway(
  deps: DriveGatewayDeps,
): (
  request: { method: string; params: Record<string, unknown> },
  signal: AbortSignal,
) => Promise<unknown> {
  let lastState: BrowserStateSummary | null = null;
  return async (request) => {
    if (request.method === "session_stop") {
      // busy（在位或创建在途）：stop() 会并入在途 flight 等落成再收口——
      // stopped 如实反映（评审轮 1 [2]：只看 active 时撞上在途 create 会假报
      // stopped:false，随后会话落成持 hold 困住 run_task）
      const wasBusy = deps.session.busy;
      const epoch = deps.session.epoch;
      await deps.session.stop();
      deps.audit({ at: deps.now(), verb: "session_stop", ok: true });
      const result: BridgeSessionStopResult = { stopped: wasBusy, epoch };
      return result;
    }
    const wire = request.params;
    const verb = typeof wire.verb === "string" ? wire.verb : "";
    const args = isRecord(wire.args) ? wire.args : {};
    const spec = verb === "" ? null : findDriveVerb(verb);
    if (spec === null) {
      return driveError("INVALID_ARGUMENTS", `unknown drive verb: ${JSON.stringify(verb)}`);
    }
    const validated = validateDriveParams(spec, args);
    if (!validated.ok) {
      return driveError("INVALID_ARGUMENTS", validated.message);
    }
    // run 互斥（先查后 ensure——run 在跑就不白附 debugger）
    const current = deps.journal.current();
    if (current !== null && !TERMINAL_STATUS.has(current.status)) {
      deps.audit({ at: deps.now(), verb, ok: false, code: "BUSY" });
      return driveError(
        "BUSY",
        `run ${current.runId} is ${current.status} — stop_run first or wait.`,
      );
    }
    // 在场门：只读（特殊面 / resolveCapability "none"）放行，写类须 sidepanel 在场
    const capability =
      spec.browser !== null ? "none" : resolveCapability(spec.tool ?? "", validated.params);
    if (capability !== "none" && !deps.hasSidepanel()) {
      deps.audit({ at: deps.now(), verb, ok: false, code: "SIDEPANEL_REQUIRED" });
      return driveError(
        "SIDEPANEL_REQUIRED",
        "Direct-drive write actions need the TreeChrome sidepanel open (presence gate).",
      );
    }
    // 会话就位（NO_ACTIVE_TAB / RESTRICTED_TAB / SESSION_START_FAILED 透传）
    let core: DriveCore;
    try {
      core = await deps.session.ensure();
    } catch (error) {
      const code = (error as { code?: string }).code ?? "SESSION_START_FAILED";
      deps.audit({ at: deps.now(), verb, ok: false, code });
      return driveError(code, errText(error));
    }
    const epoch = deps.session.epoch;
    // locator 代次校验（决策点 ①：桥侧簿记的 lastObservedEpoch 必须等于当前代次）
    if (spec.locator) {
      if (typeof wire.epoch !== "number") {
        return driveError(
          "INDEX_REQUIRES_STATE",
          "Locator action without epoch — run get_state first to obtain fresh indexes.",
          epoch,
        );
      }
      if (wire.epoch !== epoch) {
        return driveError(
          "EPOCH_STALE",
          `Session rebuilt (epoch ${epoch} now, caller had ${wire.epoch}). Re-run get_state to refresh indexes.`,
          epoch,
        );
      }
    }
    deps.session.touch();
    try {
      let data: unknown;
      if (spec.browser === "get_state") {
        const st = await core.browser.getState({ includeScreenshot: false });
        lastState = st;
        data = projectDriveState(st, core.browser.currentTargetId);
      } else if (spec.browser === "get_tabs") {
        data = projectDriveTabs(await core.browser.getTabs(), core.browser.currentTargetId);
      } else {
        const result: ActionResult = await core.tools.execute(
          spec.tool ?? "",
          validated.params,
          core.browser,
          lastState,
        );
        data = projectDriveActionResult(result);
      }
      deps.audit({
        at: deps.now(),
        verb,
        ok: true,
        ...(verb === "upload_file"
          ? { detail: { path: String(validated.params.path ?? "") } }
          : {}),
      });
      return { ok: true, data, epoch };
    } catch (error) {
      deps.audit({ at: deps.now(), verb, ok: false, code: "DRIVE_EXECUTION_FAILED" });
      return driveError("DRIVE_EXECUTION_FAILED", errText(error), epoch);
    }
  };
}

// ── 直驱文件面包装（决策点 ④ 路径模式）────────────────────────────────────────

/** OS 绝对路径（Windows 盘符 / UNC——本产品宿主形态；Chrome 读盘的地址空间） */
export function looksLikeOsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

/**
 * 路径模式上传的 fs 包装：OS 绝对路径的存在/非空校验放行（SW 结构性看不到 OS
 * 文件系统——读盘的是 Chrome/浏览器进程，坏路径由 setFileInputFiles 下游暴露；
 * 决策点 ④：调用方即信任边界）；其余（OPFS 虚拟工作区，如 screenshot save_path）
 * 全部委托 inner。显式箭头委托保 inner 方法 receiver。
 */
export function driveUploadFs(inner: FileSystemProvider): FileSystemProvider {
  const osPath = (path: string): boolean => looksLikeOsAbsolutePath(path);
  return {
    resolve: (path) => (osPath(path) ? path : inner.resolve(path)),
    isFile: (path) => (osPath(path) ? Promise.resolve(true) : inner.isFile(path)),
    stat: (path) => (osPath(path) ? Promise.resolve({ size: 1 }) : inner.stat(path)),
    readTextFile: (path, maxChars) => inner.readTextFile(path, maxChars),
    ensureDir: (path) => inner.ensureDir(path),
    writeTextFile: (path, content) => inner.writeTextFile(path, content),
    appendTextFile: (path, content) => inner.appendTextFile(path, content),
    writeBytes: (path, data) => inner.writeBytes(path, data),
    readHead: (path, n) => inner.readHead(path, n),
  };
}

// ── 审计环形缓冲（background 装配面）─────────────────────────────────────────

export const DRIVE_AUDIT_KEY = "tc_driveAudit";
export const DRIVE_AUDIT_CAP = 200;

const isAuditEntry = (value: unknown): value is DriveAuditEntry =>
  isRecord(value) &&
  typeof value.at === "number" &&
  typeof value.verb === "string" &&
  typeof value.ok === "boolean";

/**
 * 审计落盘写面：tc_driveAudit 环形缓冲（200 条 FIFO）。storage 读改写经串行链
 * （并发 drive 回投不丢更）；首条惰性装载，坏形态回空环。
 */
export function createDriveAuditWriter(
  storage: StorageArea,
  log?: (message: string) => void,
): (entry: DriveAuditEntry) => void {
  let ring: DriveAuditEntry[] | null = null;
  let chain: Promise<void> = Promise.resolve();
  return (entry) => {
    chain = chain
      .then(async () => {
        if (ring === null) {
          const stored = await storage.get(DRIVE_AUDIT_KEY);
          const raw = stored[DRIVE_AUDIT_KEY];
          ring = Array.isArray(raw) ? raw.filter(isAuditEntry) : [];
        }
        ring.push(entry);
        if (ring.length > DRIVE_AUDIT_CAP) ring = ring.slice(-DRIVE_AUDIT_CAP);
        await storage.set({ [DRIVE_AUDIT_KEY]: ring });
      })
      .catch((error: unknown) => {
        log?.(`[drive] audit persist failed: ${errText(error)}`);
      });
  };
}
