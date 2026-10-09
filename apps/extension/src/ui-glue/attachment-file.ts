// 附件文件编码（m5/05 §2）：File → base64（attachment-add 的 payload 形态）。
// 分块 string 拼接（String.fromCharCode 展开上限 0x8000——整块展开炸调用栈）。

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
