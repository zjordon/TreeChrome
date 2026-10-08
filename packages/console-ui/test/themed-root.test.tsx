// ThemedRoot 冒烟（react-dom/server renderToString——node 环境零 jsdom 依赖；段 E
// 引入 jsdom + testing-library 后渲染断言面扩全组件）。

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemedRoot } from "../src/index.js";

describe("ThemedRoot", () => {
  it("缺省主题 auto：作用域根 + data-tc-theme + children 透传", () => {
    const html = renderToString(
      <ThemedRoot>
        <p>hello</p>
      </ThemedRoot>,
    );
    expect(html).toContain('class="tc-root"');
    expect(html).toContain('data-tc-theme="auto"');
    expect(html).toContain("<p>hello</p>");
  });

  it("显式 dark 覆盖媒体查询", () => {
    const html = renderToString(<ThemedRoot theme="dark">x</ThemedRoot>);
    expect(html).toContain('data-tc-theme="dark"');
  });

  it("无 children 不炸（空容器）", () => {
    const html = renderToString(<ThemedRoot />);
    expect(html).toContain('class="tc-root"');
  });
});
