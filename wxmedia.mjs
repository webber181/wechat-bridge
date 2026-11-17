/**
 * wxmedia.mjs — ilink bot 协议的多媒体收发。
 *
 * 依据：tencent/openclaw-weixin docs/protocol_zh_CN.md
 *   - "CDN 媒体引用" / "CDN 媒体流程" / "客户端使用的媒体字段" 三节。
 * 不要编造接口规则：实现只覆盖文档明确写出的行为。
 *
 * 收（下载）：
 *   - 下载地址优先用 media.full_url；否则按
 *     <cdn>/download?encrypted_query_param=<url编码> 构造，
 *     cdn = https://novac2c.cdn.weixin.qq.com/c2c
 *   - 密钥优先级：图片优先 image_item.aeskey（32 位十六进制串）；
 *     其次 media.aes_key（base64，解码后为 16 字节原始密钥，
 *     或 32 位十六进制串的 base64）。
 *   - AES-128-ECB + PKCS#7 解密。图片无任何可用密钥时按文档当明文处理；
 *     语音/文件/视频缺密钥则按文档跳过（抛错，由调用方记录）。
 *
 * 发（上传）：
 *   - getuploadurl → 密文 POST 到上传 URL → 读 x-encrypted-param →
 *     sendmessage 带 image_item/video_item/file_item。
 *   - 成功判定：HTTP 200 且 x-encrypted-param 非空；HTTP 4xx 立即终止；
 *     其他失败最多试 3 次（与文档的客户端行为一致）。
 */
import crypto from "node:crypto";

export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const MEDIA_TYPE_NUM = { image: 1, video: 2, file: 3, voice: 4 };

export function buildDownloadUrl(media) {
  return buildDownloadUrls(media)[0];
}

/**
 * 下载地址候选：encrypt_query_param 拼的地址在前、full_url 在后。
 * Liu-zhongxian/wechat-bridge 的实测结论：视频必须用 param 地址，
 * full_url 的数据解密会失败；图片则两者都可能通，所以逐个试、失败换源。
 */
export function buildDownloadUrls(media) {
  const urls = [];
  if (media?.encrypt_query_param) {
    urls.push(
      `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(
        media.encrypt_query_param,
      )}`,
    );
  }
  if (media?.full_url) urls.push(media.full_url);
  if (!urls.length) {
    throw new Error("media has neither full_url nor encrypt_query_param");
  }
  return urls;
}

/**
 * 按文档解析 16 字节 AES 密钥；无可用密钥返回 null。
 */
export function resolveMediaKey(media, itemAeskeyHex) {
  const hex = (itemAeskeyHex ?? "").trim();
  if (/^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, "hex");
  const b64 = media?.aes_key;
  if (!b64) return null;
  let raw;
  try {
    raw = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (raw.length === 16) return raw;
  const asAscii = raw.toString("ascii");
  if (raw.length === 32 && /^[0-9a-fA-F]{32}$/.test(asAscii)) {
    return Buffer.from(asAscii, "hex");
  }
  return null;
}

export function aesEcbDecrypt(cipherBytes, keyBytes) {
  const d = crypto.createDecipheriv("aes-128-ecb", keyBytes, null);
  d.setAutoPadding(true);
  return Buffer.concat([d.update(cipherBytes), d.final()]);
}

export function aesEcbEncrypt(plainBytes, keyBytes) {
  const e = crypto.createCipheriv("aes-128-ecb", keyBytes, null);
  e.setAutoPadding(true);
  return Buffer.concat([e.update(plainBytes), e.final()]);
}

export async function downloadBytes(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`CDN HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

const HOLDER_FIELD = { image: "image_item", video: "video_item", voice: "voice_item", file: "file_item" };

/**
 * 下载并解密一条媒体 item。返回 { bytes, isThumb }；失败抛错。
 */
export async function downloadMediaItem(kind, item, timeoutMs = 20000) {
  const holder = item?.[HOLDER_FIELD[kind]] ?? {};
  const candidates = [];
  if (holder.media) candidates.push({ media: holder.media, thumb: false });
  if (holder.thumb_media) candidates.push({ media: holder.thumb_media, thumb: true });
  if (!candidates.length) throw new Error(`no media object in ${HOLDER_FIELD[kind]}`);
  let lastErr = null;
  for (const c of candidates) {
    // 同一媒体逐个试下载源：下载失败或解密失败都换下一个源再试。
    let downloaded = null;
    for (const url of buildDownloadUrls(c.media)) {
      try {
        downloaded = await downloadBytes(url, timeoutMs);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (downloaded === null) continue;
    try {
      const bytes = downloaded;
      const key = resolveMediaKey(c.media, kind === "image" ? holder.aeskey : undefined);
      if (key) return { bytes: aesEcbDecrypt(bytes, key), isThumb: c.thumb };
      // 文档：图片两者都不存在时，直接将下载内容作为明文图片使用。
      if (kind === "image") return { bytes, isThumb: c.thumb };
      // 文档：下载器会跳过缺少 media.aes_key 的语音、文件和视频。
      throw new Error(`${kind}: no usable aes key, skipped per protocol doc`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("media download failed");
}

/** 按魔数猜扩展名，猜不出按 kind 给默认。 */
export function sniffExt(bytes, kind) {
  const h = bytes.subarray(0, 12);
  if (h[0] === 0xff && h[1] === 0xd8) return ".jpg";
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return ".png";
  if (h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46) return ".gif";
  if (
    h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 &&
    h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50
  )
    return ".webp";
  if (h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70) return ".mp4";
  if (kind === "image") return ".jpg";
  if (kind === "video") return ".mp4";
  if (kind === "voice") return ".silk";
  return ".bin";
}

export function md5Hex(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

export function randomHex(nBytes) {
  return crypto.randomBytes(nBytes).toString("hex");
}

/**
 * 调 getuploadurl 拿上传地址（同时返回加密后的密文）。
 * 上传地址优先用 upload_full_url；缺失时按参考实现 buildCdnUploadUrl
 * 以 {cdn}/upload?encrypted_query_param={upload_param}&filekey={filekey} 构造。
 */
export async function getUploadUrl({ baseUrl, headers, baseInfo, filekey, mediaType, toUserId, rawBytes, keyHex, timeoutMs = 15000 }) {
  const keyBytes = Buffer.from(keyHex, "hex");
  if (keyBytes.length !== 16) throw new Error("keyHex must decode to 16 bytes");
  const cipher = aesEcbEncrypt(rawBytes, keyBytes);
  const body = {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: rawBytes.length,
    rawfilemd5: md5Hex(rawBytes),
    filesize: cipher.length,
    no_need_thumb: true,
    aeskey: keyHex,
    base_info: baseInfo,
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/ilink/bot/getuploadurl`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`getuploadurl HTTP ${res.status}: ${text.slice(0, 160)}`);
    const resp = JSON.parse(text);
    // 参考实现 cdn-url.js buildCdnUploadUrl：优先 upload_full_url；
    // 否则按 {cdn}/upload?encrypted_query_param={upload_param}&filekey={filekey} 构造。
    const full = (resp.upload_full_url ?? "").trim();
    const uploadUrl = full
      ? full
      : resp.upload_param
        ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(resp.upload_param)}&filekey=${encodeURIComponent(filekey)}`
        : null;
    if (!uploadUrl) {
      throw new Error("getuploadurl returned neither upload_full_url nor upload_param");
    }
    return { uploadUrl, cipher };
  } finally {
    clearTimeout(t);
  }
}

/** 上传密文，返回 x-encrypted-param（下载参数）。 */
export async function uploadCipher(uploadUrl, cipher, timeoutMs = 30000) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: cipher,
        signal: ctrl.signal,
      });
      const param = res.headers.get("x-encrypted-param");
      if (res.status === 200 && param) return param;
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`upload HTTP ${res.status}: aborting, no retry on 4xx`);
      }
      lastErr = new Error(
        `upload attempt ${attempt}: HTTP ${res.status}, x-encrypted-param ${param ? "present" : "missing"}`,
      );
    } catch (err) {
      if (/no retry on 4xx/.test(String(err?.message))) throw err;
      lastErr = err;
    } finally {
      clearTimeout(t);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  throw lastErr ?? new Error("upload failed");
}
