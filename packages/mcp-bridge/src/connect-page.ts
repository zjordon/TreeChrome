// 配对页（issue #31 M1 P1）：tc-bridge connect 打印 URL 的落点。页面本身零权限——
// 只做两件事：展示状态 + 同源轮询 /tc-connect/state?t=… 直至扩展完成 pair（t 经
// URL 传递，扩展凭 tabs 权限从标签页 URL 捕获后走扩展 Origin 私线 pair；本页不发
// 任何跨源请求）。

export const CONNECT_PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'";

export const CONNECT_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TreeChrome 扩展配对</title>
<style>
  body { font: 15px/1.7 system-ui, sans-serif; max-width: 34em; margin: 4rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.3rem; }
  .state { padding: .8rem 1rem; border-radius: 8px; background: #f2f4f8; margin-top: 1rem; }
  .ok { background: #e8f6ec; }
  .bad { background: #fdeeee; }
  code { background: #f2f4f8; padding: .1em .4em; border-radius: 4px; font-size: .9em; }
</style>
</head>
<body>
<h1>TreeChrome 扩展配对</h1>
<p>如果本浏览器已安装 TreeChrome 扩展，它会在数秒内自动完成连接（从本页地址捕获一次性令牌）。</p>
<div class="state" id="state">等待扩展确认…</div>
<p style="color:#666">连接建立后即可关闭本页。邀请有效期 10 分钟。</p>
<script>
(() => {
  const el = document.getElementById("state");
  const t = new URLSearchParams(location.search).get("t") ?? "";
  const tick = async () => {
    try {
      const res = await fetch("/tc-connect/state?t=" + encodeURIComponent(t));
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      if (body.paired) {
        el.textContent = "已连接 ✓（本页可关闭）";
        el.className = "state ok";
        return;
      }
      if (body.expiresAt === null) {
        el.textContent = "邀请已失效——请在命令行重新运行 tc-bridge connect。";
        el.className = "state bad";
        return;
      }
    } catch { /* 桥暂不可达——下一轮再试 */ }
    setTimeout(tick, 1000);
  };
  void tick();
})();
</script>
</body>
</html>
`;
