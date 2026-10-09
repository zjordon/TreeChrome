// assemble + task-text 单测（m5/04 §2）：activeProviderCard 解析、附属卡构造/
// 复用主卡（llmFactory 记录）、扩展覆盖 settings（submitConfirmEnabled 等恒 true、
// agent 覆盖透传）、附件任务文本拼接、decoratedFs 的 readAttachment 装饰——真
// assembleRun + fake llmFactory + 内存 OpfsFs 假根。

import type { CdpTransport, LLMClient, ProviderConfig } from "@tw/core";
import { describe, expect, it } from "vitest";
import { AttachmentRegistry, MAX_ATTACHMENT_BYTES } from "../src/host/attachment-registry.js";
import type { DirHandleLike, FileHandleLike } from "../src/host/opfs-fs.js";
import { OpfsFs } from "../src/host/opfs-fs.js";
import { parseExtensionSettings } from "../src/host/settings-store.js";
import { activeProviderCard, assembleRun, decoratedFs } from "../src/runtime/assemble.js";
import { attachmentLine, attachTaskText, humanSize } from "../src/runtime/task-text.js";

const CARD: ProviderConfig = {
  name: "main",
  protocol: "anthropic-messages",
  baseUrl: "https://api",
  apiKey: "k",
  model: "glm",
  maxTokens: 4096,
};
const SUB_CARD: ProviderConfig = { ...CARD, name: "sub", model: "glm-mini" };

/** 内存 OPFS 假根（decoratedFs 透传链用——与 host-opfs-fs.test 同构的精简版） */
function makeFakeOpfsRoot(): DirHandleLike {
  const files = new Map<string, Uint8Array>();
  class NF extends Error {
    constructor() {
      super("NotFoundError");
      this.name = "NotFoundError";
    }
  }
  const makeFile = (b: Uint8Array) => ({
    size: b.length,
    async text() {
      return new TextDecoder().decode(b);
    },
    async arrayBuffer() {
      return b.slice().buffer as ArrayBuffer;
    },
    slice(s: number, e: number) {
      return makeFile(b.slice(s, e));
    },
  });
  const makeHandle = (key: string): FileHandleLike => ({
    async getFile() {
      const b = files.get(key);
      if (b === undefined) throw new NF();
      return makeFile(b);
    },
    async createWritable(opts) {
      let buf =
        opts?.keepExistingData === true ? new Uint8Array(files.get(key) ?? []) : new Uint8Array(0);
      let pos = 0;
      return {
        async write(data) {
          if (typeof data === "object" && !(data instanceof Uint8Array) && "type" in data) {
            pos = data.position;
            return;
          }
          const c =
            typeof data === "string" ? new TextEncoder().encode(data) : (data as Uint8Array);
          const n = new Uint8Array(Math.max(buf.length, pos + c.length));
          n.set(buf);
          n.set(c, pos);
          buf = n;
          pos += c.length;
        },
        async close() {
          files.set(key, buf);
        },
      };
    },
  });
  const hasPrefix = (k: string) => [...files.keys()].some((x) => x === k || x.startsWith(`${k}/`));
  const makeDir = (segs: string[]): DirHandleLike => ({
    async getDirectoryHandle(name, opts) {
      const c = [...segs, name];
      if (!hasPrefix(c.join("/")) && opts?.create !== true) throw new NF();
      return makeDir(c);
    },
    async getFileHandle(name, opts) {
      const k = [...segs, name].join("/");
      if (!files.has(k) && opts?.create !== true) throw new NF();
      if (!files.has(k)) files.set(k, new Uint8Array(0));
      return makeHandle(k);
    },
  });
  return makeDir([]);
}

const noRoot: DirHandleLike = {
  async getDirectoryHandle() {
    throw new Error("unused");
  },
  async getFileHandle() {
    throw new Error("unused");
  },
};

function makeDeps() {
  const cardsSeen: ProviderConfig[] = [];
  const llmFactory = (card: ProviderConfig): LLMClient => {
    cardsSeen.push(card);
    return {} as LLMClient;
  };
  const attachments = new AttachmentRegistry();
  const deps = {
    transportFactory: (() => Promise.resolve({} as CdpTransport)) as () => Promise<CdpTransport>,
    fs: new OpfsFs(async () => noRoot),
    attachments,
    skillSource: {
      loadHostSkill: async () => null,
      taskCatalog: async () => [],
      taskCardText: async () => "",
    },
    policyInteraction: null,
    grantStore: null,
    llmFactory,
  };
  return { deps, cardsSeen, attachments };
}

describe("activeProviderCard", () => {
  it("activeCard 命中 → 卡；未设/未命中 → null", () => {
    const settings = parseExtensionSettings({
      providerCards: [CARD, SUB_CARD],
      activeCard: "sub",
    });
    expect(activeProviderCard(settings)?.name).toBe("sub");
    expect(activeProviderCard(parseExtensionSettings({ providerCards: [CARD] }))).toBeNull();
  });
});

describe("assembleRun", () => {
  it("无可用卡片 → 抛用户可见错误", () => {
    const { deps } = makeDeps();
    expect(() =>
      assembleRun({ task: "t", tabId: 1, settings: parseExtensionSettings({}) }, deps),
    ).toThrow("No active provider card");
  });

  it("主卡构造 + 附属卡按名独立构造；未设附属卡不构造（复用主 llm = null 注入）", () => {
    const { deps, cardsSeen } = makeDeps();
    const settings = parseExtensionSettings({
      providerCards: [CARD, SUB_CARD],
      activeCard: "main",
      taskSkillCard: "sub",
    });
    const assembled = assembleRun({ task: "t", tabId: 1, settings }, deps);
    expect(cardsSeen.map((c) => c.name)).toEqual(["main", "sub"]);
    // extract/judge 未设 → null（Agent 复用主 llm 语义）
    expect(assembled.agent).toBeDefined();
    expect(assembled.bus).toBeDefined();
    // 附件数据通道上限对齐注册表（评审轮 1 [4]）：core 缺省 32MB < 注册表 100MB
    // 时 33-100MB 附件入表后 upload 必被拒——拒绝还发生在 resolve() 全量转码之后
    const ctx = (assembled.agent as unknown as { tools: { ctx: { maxAttachmentBytes: number } } })
      .tools.ctx;
    expect(ctx.maxAttachmentBytes).toBe(MAX_ATTACHMENT_BYTES);
  });

  it("附件注册表有附件 → taskText 拼接 [Attachments] 段；无附件原样", () => {
    const { deps, attachments } = makeDeps();
    const settings = parseExtensionSettings({ providerCards: [CARD], activeCard: "main" });
    attachments.add(btoa("xyz"), "v.mp4", "video/mp4");
    const assembled = assembleRun({ task: "做任务", tabId: 1, settings }, deps);
    expect(assembled.taskText).toContain("做任务\n\n[Attachments]");
    expect(assembled.taskText).toContain("- att_1: v.mp4 (3 B, video/mp4)");
    expect(assembled.taskText).toContain('"attachment:<id>"');
    // 清表后零附件 → 原样（注册表共享 deps——上一 add 不应串场）
    attachments.clearForRun();
    const empty = assembleRun({ task: "做任务", tabId: 1, settings }, deps);
    expect(empty.taskText).toBe("做任务");
  });
});

describe("decoratedFs（附件缝消费）", () => {
  it("readAttachment 装饰：attachment: 前缀走注册表，其余透传 opfs（全方法透传链）", async () => {
    const { attachments } = makeDeps();
    attachments.add(btoa("bin"), "a.bin", "application/octet-stream");
    // 真 OPFS 假根（透传链全方法走一遍；单根复用——getRoot 每调用返回同一根）
    const root = makeFakeOpfsRoot();
    const real = new OpfsFs(async () => root);
    const fs = decoratedFs(real, attachments);
    const hit = await fs.readAttachment?.("attachment:att_1");
    expect(hit).toMatchObject({ filename: "a.bin", size: 3 });
    expect(await fs.readAttachment?.("/os/path")).toBeNull();
    expect(fs.resolve("a\\b")).toBe("/a/b");
    await fs.ensureDir("/w");
    await fs.writeTextFile("/w/t.txt", "内容");
    expect(await fs.readTextFile("/w/t.txt")).toBe("内容");
    await fs.appendTextFile("/w/t.txt", "+");
    expect(await fs.readTextFile("/w/t.txt")).toBe("内容+");
    await fs.writeBytes("/w/b.bin", new Uint8Array([1, 2]));
    expect(await fs.stat("/w/b.bin")).toEqual({ size: 2 });
    expect(await fs.isFile("/w/b.bin")).toBe(true);
    expect(await fs.readHead("/w/b.bin", 1)).toEqual(new Uint8Array([1]));
  });

  it("缺省 llmFactory（真 LLMClient 构造——零网络）", () => {
    const assembled = assembleRun(
      {
        task: "t",
        tabId: 1,
        settings: parseExtensionSettings({ providerCards: [CARD], activeCard: "main" }),
      },
      {
        transportFactory: (() =>
          Promise.resolve({} as CdpTransport)) as () => Promise<CdpTransport>,
        fs: new OpfsFs(async () => noRoot),
        attachments: new AttachmentRegistry(),
        skillSource: {
          loadHostSkill: async () => null,
          taskCatalog: async () => [],
          taskCardText: async () => "",
        },
        policyInteraction: null,
        grantStore: null,
      },
    );
    expect(assembled.agent).toBeDefined();
  });
});

describe("task-text 纯函数", () => {
  it("humanSize 三档 + attachmentLine 形态", () => {
    expect(humanSize(89)).toBe("89 B");
    expect(humanSize(456 * 1024)).toBe("456.0 KB");
    expect(humanSize(12.3 * 1024 * 1024)).toBe("12.3 MB");
    expect(
      attachmentLine({ attachmentId: "att_2", name: "v.mp4", mimeType: "video/mp4", size: 3 }),
    ).toBe("- att_2: v.mp4 (3 B, video/mp4)");
  });
  it("attachTaskText 空附件零行为面", () => {
    expect(attachTaskText("t", [])).toBe("t");
  });
});
