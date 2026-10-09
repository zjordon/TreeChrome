// TaskBar 测试：空任务禁用开始/起跑回调/运行态切换（停止 + 输入锁定）/附件挑选与
// 移除（File 对象经 onPickFiles 原样出组件——零 IO）。

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskBar } from "../src/index.js";

const ATT = { attachmentId: "att_1", name: "a.mp4", mimeType: "video/mp4", size: 10 };

function setup(runStatus: "running" | null = null) {
  const calls: Record<string, unknown[]> = { task: [], files: [], remove: [], start: [], stop: [] };
  const utils = render(
    <TaskBar
      task="做任务"
      onTaskChange={(t) => calls.task.push(t)}
      attachments={[ATT]}
      onPickFiles={(f) => calls.files.push(f)}
      onRemoveAttachment={(id) => calls.remove.push(id)}
      runStatus={runStatus}
      onStart={() => calls.start.push(1)}
      onStop={() => calls.stop.push(1)}
    />,
  );
  return { calls, ...utils };
}

describe("TaskBar", () => {
  it("空闲态：附件清单可见、开始可点、任务输入回调", () => {
    const { calls } = setup();
    fireEvent.click(screen.getByRole("button", { name: "▶ 开始" }));
    expect(calls.start).toEqual([1]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "新任务" } });
    expect(calls.task).toEqual(["新任务"]);
    expect(screen.getByText(/a\.mp4/)).toBeDefined();
  });

  it("运行态：textarea 禁用、附件移除禁用、停止可点", () => {
    const { calls } = setup("running");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "⏹ 停止" }));
    expect(calls.stop).toEqual([1]);
    expect(screen.queryByRole("button", { name: "▶ 开始" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "移除附件 a.mp4" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("附件挑选：隐藏 input change → onPickFiles(File[])；移除回调带 id", () => {
    const { calls, container } = setup();
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "v.mp4", { type: "video/mp4" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(calls.files).toHaveLength(1);
    expect((calls.files[0] as File[])[0].name).toBe("v.mp4");
    // 选择后清空（同名文件可重选）
    expect(input.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "移除附件 a.mp4" }));
    expect(calls.remove).toEqual(["att_1"]);
  });

  it("空任务（trim）禁用开始", () => {
    render(
      <TaskBar
        task="   "
        onTaskChange={() => {}}
        attachments={[]}
        onPickFiles={() => {}}
        onRemoveAttachment={() => {}}
        runStatus={null}
        onStart={() => {}}
        onStop={() => {}}
      />,
    );
    expect((screen.getByRole("button", { name: "▶ 开始" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
