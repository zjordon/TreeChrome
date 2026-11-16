// verb-parity 锚定测试（issue #32 决策点 3）：daemon CLI 旗标表（本包私有解析层）
// 与 core 宿主中立动词面（DRIVE_VERBS 单源）必须同动词/同参数（名+类型）/同必填/
// 同 XOR——两表演进时本测试强制同步（invert 是 CLI 呈现细节，不在比对面）。

import { DRIVE_VERBS, findDriveVerb } from "@tw/core";
import { describe, expect, it } from "vitest";
import { DAEMON_VERBS } from "../src/daemon/protocol.js";

describe("daemon 旗标表 ↔ core DRIVE_VERBS 奇偶校验", () => {
  it("动词集合一致（15 件）", () => {
    expect(new Set(DAEMON_VERBS.map((v) => v.verb))).toEqual(
      new Set(DRIVE_VERBS.map((v) => v.verb)),
    );
    expect(DAEMON_VERBS).toHaveLength(15);
    expect(DRIVE_VERBS).toHaveLength(15);
  });

  it("每动词参数（名+类型）/必填/XOR 逐项一致", () => {
    for (const daemon of DAEMON_VERBS) {
      const core = findDriveVerb(daemon.verb);
      expect(core, `core 缺动词 ${daemon.verb}`).not.toBeNull();
      if (core === null) continue;
      const daemonParams = daemon.flags.map((f) => `${f.param}:${f.type}`).sort();
      const coreParams = core.params.map((p) => `${p.name}:${p.type}`).sort();
      expect(daemonParams, `参数面分歧：${daemon.verb}`).toEqual(coreParams);
      const daemonRequired = [...daemon.required].sort();
      const coreRequired = core.params
        .filter((p) => p.required === true)
        .map((p) => p.name)
        .sort();
      expect(daemonRequired, `必填分歧：${daemon.verb}`).toEqual(coreRequired);
      expect(daemon.xor.map((g) => [...g].sort()).sort(), `XOR 分歧：${daemon.verb}`).toEqual(
        core.xor.map((g) => [...g].sort()).sort(),
      );
    }
  });

  it("browser 特殊面对齐（get_state/tabs 的 special 标记 ↔ core browser 派发）", () => {
    for (const daemon of DAEMON_VERBS) {
      const core = findDriveVerb(daemon.verb);
      if (core === null) continue;
      if (daemon.special !== undefined) {
        expect(core.tool).toBeNull();
        expect(core.browser).toBe(daemon.special === "tabs" ? "get_tabs" : "get_state");
      } else {
        expect(core.browser).toBeNull();
        expect(core.tool).toBe(daemon.verb);
      }
    }
  });
});
