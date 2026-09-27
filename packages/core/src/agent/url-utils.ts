// URL host 解析（url_utils.py 全量）：skill 目录 key / sensitive URL 过滤 / obs host 共用。
// WHATWG URL 与 urlparse 语义差：schemeless 串（www.x.com/y）在 URL 构造器不可解析
//（urlparse 视 netloc）——统一补 https: 前缀归一（仅取 host/port，scheme 不参与语义）。

function parseUrl(url: string): URL | null {
  const candidate = url.includes("://")
    ? url
    : `https://${url.startsWith("//") ? url.slice(2) : url}`;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname;
    if (!host || host.includes(" ")) return null; // 垃圾输入（"not a url" 解析出含空 host）
    return parsed;
  } catch {
    return null;
  }
}

/** 提取 hostname（schemeless 形态按补 scheme 重解析；垃圾输入返回 null） */
export function extractHost(url: string | null | undefined): string | null {
  if (!url) return null;
  return parseUrl(url)?.hostname ?? null;
}

/** skill 目录 key：显式端口的 URL 用 `host_port` 形态（localhost_7780），否则 host */
export function extractHostWithPort(url: string | null | undefined): string | null {
  if (!url) return null;
  const parsed = parseUrl(url);
  if (parsed === null) return null;
  return parsed.port ? `${parsed.hostname}_${parsed.port}` : parsed.hostname;
}
