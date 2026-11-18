#!/usr/bin/env node
/**
 * WeChat bridge for Max — standalone, no OpenClaw gateway.
 *
 * Reuses the login session created by @tencent-weixin/openclaw-weixin-cli
 * (account file under ~/.openclaw/openclaw-weixin/accounts/) and speaks the
 * same ilink bot HTTP protocol directly. Protocol rules per
 * tencent/openclaw-weixin docs/protocol_zh_CN.md; media up/download per
 * ./wxmedia.mjs (same doc, "CDN 媒体流程" section).
 *
 * Commands:
 *   node wxbridge.mjs poll [--quick]
 *     Poll for new inbound USER messages. Only the bound user's 1:1 chat
 *     messages are accepted; group messages and other senders are skipped
 *     (counted in summary.skipped). Fresh messages are appended to inbox.jsonl
 *     with status "received" and a per-round batch_id; image/video/voice/file
 *     items are downloaded+decrypted into media/inbound/<date>/.
 *     Exit 0 always (unless fatal); prints JSON summary.
 *
 *   node wxbridge.mjs send --to <user_id> (--text <t> | --text-file <p>) [--context-token <ct>]
 *     Send a text reply, chunked at paragraph boundaries. Network failures
 *     are retried (3x backoff); business errors fail fast. Every chunk is
 *     logged to outbox.jsonl with sent/failed status.
 *
 *   node wxbridge.mjs sendmedia --to <user_id> --file <path> --type image|video|file
 *       [--caption <text>] [--context-token <ct>]
 *     Upload a file via getuploadurl -> CDN -> sendmessage, then optionally
 *     send the caption as a separate text message (protocol: caption and
 *     media travel as independent requests).
 *
 *   node wxbridge.mjs mark --id <inbox_id> --status received|executing|replied [--note <text>]
 *     Move an inbox message through the 4-state pipeline:
 *     received (poll) -> executing (agent starts) -> replied (agent answered).
 *     "pending-send/sent" live in outbox.jsonl per send chunk.
 *
 *   node wxbridge.mjs typing --to <user_id> <start|stop>
 *     点亮/取消微信里的“正在输入”提示（学 gfydfhcf/wechat-ilink-muse-bridge：
 *     getconfig 取 typing_ticket 缓存 9 分钟 + sendtyping 开关）。装饰性功能，
 *     失败只打印 ok:false，永不抛错、永不阻塞调用方。票据缓存只含 ticket，不含 token。
 *
 *   node wxbridge.mjs status
 *     Read-only health snapshot from local files (no network, no secrets).
 *
 *   node wxbridge.mjs login
 *     Standalone QR login (unchanged legacy flow).
 *
 * The API token is read from the account file at runtime and never logged.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  downloadMediaItem,
  sniffExt,
  getUploadUrl,
  uploadCipher,
  randomHex,
  MEDIA_TYPE_NUM,
} from "./wxmedia.mjs";

const BRIDGE_DIR = path.dirname(new URL(import.meta.url).pathname);
const ACCOUNT_ID =
  process.env.WXBRIDGE_ACCOUNT_ID || "YOUR_BOT_ACCOUNT_ID-im-bot";
const ACCOUNT_FILE = path.join(
  os.homedir(),
  ".openclaw/openclaw-weixin/accounts",
  `${ACCOUNT_ID}.json`,
);
const STATE_FILE = path.join(BRIDGE_DIR, "state.json");
const INBOX_FILE = path.join(BRIDGE_DIR, "inbox.jsonl");
const OUTBOX_FILE = path.join(BRIDGE_DIR, "outbox.jsonl");
const REPLIED_FILE = path.join(BRIDGE_DIR, "replied.txt");
const LAST_POLL_FILE = path.join(BRIDGE_DIR, "last_poll.json");
const HEALTH_FILE = path.join(BRIDGE_DIR, "health.json");
const TYPING_TICKET_FILE = path.join(BRIDGE_DIR, "typing_ticket.json");
const UNKNOWN_SENDERS_FILE = path.join(BRIDGE_DIR, "unknown_senders.json");
const TYPING_TICKET_TTL_MS = 540_000; // 9 分钟（学 gfydfhcf/wechat-ilink-muse-bridge）
/** wx-bot 式健康心跳：连续失败 ≥3 次或 5 分钟无更新即视为异常。 */
const HEALTH_STALE_MS = 5 * 60_000;
const MINUS14_CONFIRM_MS = 5 * 60_000; // -14 可能是限流：先观察 5 分钟，持续才判过期（学 Liu-zhongxian/wechat-bridge）
const LOGIN_STATUS_FILE = path.join(BRIDGE_DIR, "login.json");
const MEDIA_INBOUND_DIR = path.join(BRIDGE_DIR, "media", "inbound");

const CHANNEL_VERSION = "2.4.9";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 9); // 2.4.9
const BOT_AGENT = "Max";
const POLL_TIMEOUT_MS = 25_000;
const API_TIMEOUT_MS = 15_000;
const MEDIA_TIMEOUT_MS = 20_000;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024; // protocol doc: image size cap 100MB
const STALE_TOKEN_ERRCODE = -14;
const CHUNK_LIMIT = 1800;
const LOGIN_QR_FILE = path.join(BRIDGE_DIR, "login-qr.png");
const LOGIN_VERIFY_FILE = path.join(BRIDGE_DIR, "verify_code.txt");
const QR_STATUS_TIMEOUT_MS = 30_000;
const LOGIN_DEADLINE_MS = 8 * 60_000;
const MAX_QR_REFRESH = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadAccount() {
  const raw = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf-8"));
  if (!raw.token || !raw.baseUrl) throw new Error("account file missing token/baseUrl");
  return raw;
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { get_updates_buf: "" };
  }
}

function saveState(s) {
  atomicWrite(STATE_FILE, JSON.stringify(s));
}

function readHealth() {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/** 每轮 poll 结束写一次心跳（成功/失败都写），供 status 与 hook 判断卡死。 */
function writeHealth(summary) {
  const prev = readHealth();
  const now = new Date().toISOString();
  const h = {
    pid: process.pid,
    updated_at: now,
    last_ok_at: summary.ok ? now : (prev?.last_ok_at ?? undefined),
    failures: summary.ok ? 0 : (prev?.failures ?? 0) + 1,
    failing_since: summary.ok ? undefined : (prev?.failing_since ?? now),
    last_error: summary.ok ? undefined : (summary.error ?? "poll failed"),
  };
  try {
    atomicWrite(HEALTH_FILE, JSON.stringify(h));
  } catch {}
  return h;
}

function pollStateFromHealth(h) {
  if (!h) return { state: "not_running" };
  if (Date.now() - Date.parse(h.updated_at) > HEALTH_STALE_MS) {
    return { state: "stalled", for_ms: Date.now() - Date.parse(h.updated_at) };
  }
  if ((h.failures ?? 0) > 0) {
    return {
      state: "failing",
      for_ms: Date.now() - Date.parse(h.failing_since ?? h.updated_at),
      failures: h.failures,
      error: h.last_error,
    };
  }
  if (!h.last_ok_at) return { state: "starting" };
  return { state: "ok", for_ms: Date.now() - Date.parse(h.last_ok_at) };
}

/** 绑定用户 = 扫码登录的 ilink_user_id；比较时忽略 @im.wechat 后缀差异。 */
function normUserId(u) {
  return String(u ?? "").replace(/@im\.wechat$/, "");
}
function boundUserId() {
  try {
    return loadAccount().userId || "";
  } catch {
    return "";
  }
}

function randomWechatUin() {
  const u32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(u32), "utf-8").toString("base64");
}

function buildHeaders(token) {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
    Authorization: `Bearer ${token}`,
  };
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

async function postJson(url, token, body, timeoutMs) {
  const r = await postJsonClassified(url, token, body, timeoutMs);
  if (r.kind !== "ok") throw new Error(r.error);
  return r.data;
}

/**
 * 分类 POST：{kind:'ok',data} | {kind:'network',error} | {kind:'business',error,ret,errcode}
 * network = 抛错/超时/HTTP 5xx（可重试）；business = HTTP 4xx / ret!=0（重试无用）。
 */
async function postJsonClassified(url, token, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status >= 500) {
        return { kind: "network", error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
      }
      return { kind: "business", error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { kind: "business", error: `non-JSON response: ${text.slice(0, 160)}` };
    }
    if (data && data.ret !== undefined && data.ret !== 0) {
      return {
        kind: "business",
        error: `ret=${data.ret} errcode=${data.errcode ?? ""} errmsg=${data.errmsg ?? ""}`,
        ret: data.ret,
        errcode: data.errcode,
      };
    }
    return { kind: "ok", data };
  } catch (err) {
    return { kind: "network", error: String(err?.message ?? err) };
  } finally {
    clearTimeout(t);
  }
}

function isStaleTokenResult(r) {
  return r.kind === "business" && (r.ret === STALE_TOKEN_ERRCODE || r.errcode === STALE_TOKEN_ERRCODE);
}

/** 文本 + 媒体 item 拆解；媒体只保留引用，由 poll 负责下载。 */
function extractContent(msg) {
  const parts = [];
  const mediaItems = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) parts.push(item.text_item.text);
    else if (item.type === 2) {
      parts.push("[图片]");
      mediaItems.push({ kind: "image", item });
    } else if (item.type === 3) {
      const tr = item.voice_item?.text;
      parts.push(tr ? `[语音转写] ${tr}` : "[语音]");
      mediaItems.push({ kind: "voice", item, transcription: tr || undefined });
    } else if (item.type === 4) {
      const name = item.file_item?.file_name ?? "";
      parts.push(name ? `[文件] ${name}` : "[文件]");
      mediaItems.push({ kind: "file", item });
    } else if (item.type === 5) {
      parts.push("[视频]");
      mediaItems.push({ kind: "video", item });
    }
  }
  return { text: parts.join("\n"), mediaItems };
}

function appendInbox(entries) {
  if (!entries.length) return;
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.appendFileSync(INBOX_FILE, lines);
}

function readInbox() {
  const out = [];
  try {
    for (const line of fs.readFileSync(INBOX_FILE, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
  } catch {}
  return out;
}

function seenIds() {
  return new Set(readInbox().map((e) => e.id).filter(Boolean));
}

function repliedIds() {
  const ids = new Set();
  try {
    for (const line of fs.readFileSync(REPLIED_FILE, "utf-8").split("\n")) {
      const t = line.trim();
      if (t) ids.add(t);
    }
  } catch {}
  return ids;
}

function yyyymmdd(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function sanitizeFileName(name, fallback) {
  const base = path.basename(String(name || "")).replace(/[^\w.\-()[\]{} ]+/g, "_").slice(0, 80);
  return base || fallback;
}

/** 下载一条 inbox entry 的媒体，返回 media 元数据数组（失败也记录，不抛错）。 */
async function fetchInboundMedia(entry, mediaItems) {
  const metas = [];
  let unavailable = false;
  const dir = path.join(MEDIA_INBOUND_DIR, yyyymmdd());
  fs.mkdirSync(dir, { recursive: true });
  let idx = 0;
  for (const { kind, item, transcription } of mediaItems) {
    const meta = { kind };
    if (transcription) meta.transcription = transcription;
    try {
      const { bytes, isThumb } = await downloadMediaItem(kind, item, MEDIA_TIMEOUT_MS);
      let ext = sniffExt(bytes, kind);
      if (kind === "file") {
        const rawName = item.file_item?.file_name ?? "";
        const clean = sanitizeFileName(rawName, `${entry.id}_${idx}_file`);
        const keepExt = path.extname(clean) || ".bin";
        meta.path = path.join(dir, `${entry.id}_${idx}_${kind}${keepExt}`);
        meta.file_name = rawName;
      } else {
        meta.path = path.join(dir, `${entry.id}_${idx}_${kind}${ext}`);
      }
      fs.writeFileSync(meta.path, bytes);
      meta.bytes = bytes.length;
      if (isThumb) meta.is_thumb = true;
    } catch (err) {
      meta.error = String(err?.message ?? err).slice(0, 200);
      unavailable = true;
    }
    metas.push(meta);
    idx++;
  }
  return { metas, unavailable };
}

/** 陌生发信人只登记待批（学 gfydfhcf/wechat-ilink-muse-bridge 的 unknown_senders.json）：
 *  不入队、不唤醒、不下载媒体；放行只能由主聊天人工决定，微信里说的不算。
 *  最佳努力：写失败也不影响 poll。 */
function noteUnknownSender(fromUserId) {
  try {
    const id = String(fromUserId ?? "");
    if (!id) return;
    let book = {};
    try {
      book = JSON.parse(fs.readFileSync(UNKNOWN_SENDERS_FILE, "utf-8"));
      if (!book || typeof book !== "object") book = {};
    } catch {}
    const prev = book[id] ?? { count: 0 };
    book[id] = { count: (prev.count ?? 0) + 1, last_seen_ms: Date.now() };
    atomicWrite(UNKNOWN_SENDERS_FILE, JSON.stringify(book));
  } catch {}
}

/** 引用还原：ref_msg 只带被引 id（+可选 partial_text 片段），原文查本地 inbox。 */
function resolveQuote(entry, m, inboxById) {
  try {
    const ref = m.ref_msg ?? m.refMsg ?? null;
    if (!ref || typeof ref !== "object") return;
    const refId = ref.msg_id ?? ref.message_id ?? ref.id ?? ref.svr_id;
    if (refId !== undefined && refId !== null && refId !== "") {
      entry.quoted_msg_id = String(refId);
    }
    const partial = ref.partial_text ?? ref.partialText ?? "";
    if (typeof partial === "string" && partial) entry.quoted_fragment = partial;
    if (entry.quoted_msg_id && inboxById?.has(entry.quoted_msg_id)) {
      const orig = inboxById.get(entry.quoted_msg_id);
      if (orig?.text) entry.quoted_text = orig.text;
      if (orig?.from) entry.quoted_from = orig.from;
      if (orig?.media?.length) entry.quoted_kind = "media";
      else entry.quoted_kind = "text";
    }
  } catch {}
}

async function cmdPoll(argv) {
  const quick = (argv ?? []).includes("--quick");
  // 非 quick 轮询跟随服务端建议的 longpolling_timeout_ms（两仓库同款做法）；
  // quick 保持 7s，不打乱 20s hook 节奏。
  const savedState = loadState();
  const suggestedPollMs = savedState.suggested_poll_timeout_ms;
  const pollTimeout = quick
    ? 7000
    : (typeof suggestedPollMs === "number" && suggestedPollMs > 0
      ? Math.min(suggestedPollMs, 120_000)
      : POLL_TIMEOUT_MS);
  const summary = {
    ok: false,
    session_valid: true,
    new_messages: 0,
    skipped: { group: 0, sender: 0 },
    warn: null,
    error: null,
  };
  const batchId = `b-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  try {
    const acct = loadAccount();
    const bound = boundUserId();
    if (!bound) summary.warn = "account file has no userId; sender filter fail-open (accepting all)";
    let doNotify = !quick;
    if (quick) {
      try {
        const ts = Number(fs.readFileSync(path.join(BRIDGE_DIR, "last_notifystart"), "utf-8").trim());
        doNotify = Date.now() - ts > 15 * 60_000;
      } catch {
        doNotify = true;
      }
    }
    if (doNotify) {
      try {
        await postJson(
          `${acct.baseUrl}/ilink/bot/msg/notifystart`,
          acct.token,
          { base_info: baseInfo() },
          API_TIMEOUT_MS,
        );
        fs.writeFileSync(path.join(BRIDGE_DIR, "last_notifystart"), String(Date.now()));
      } catch (err) {
        if (!quick) summary.error = `notifystart failed: ${String(err?.message ?? err)}`;
      }
    }
    const state = loadState();
    const r = await postJsonClassified(
      `${acct.baseUrl}/ilink/bot/getupdates`,
      acct.token,
      { get_updates_buf: state.get_updates_buf || "", base_info: baseInfo() },
      pollTimeout + 5000,
    );
    if (r.kind !== "ok") {
      if (isStaleTokenResult(r)) {
        // -14 也可能是限流而非过期：先观察 5 分钟，持续出现才判过期。
        const st = loadState();
        const firstSeen = st.first_minus14_at ?? 0;
        if (!firstSeen) {
          st.first_minus14_at = Date.now();
          saveState(st);
          summary.ok = true;
          summary.warn = "getupdates returned -14 once; confirming for 5 min before declaring session expired (may be rate limiting)";
        } else if (Date.now() - firstSeen >= MINUS14_CONFIRM_MS) {
          delete st.first_minus14_at;
          saveState(st);
          summary.session_valid = false;
          summary.error = "session expired (errcode -14 confirmed over 5 min): user must re-scan QR to log in";
        } else {
          summary.ok = true;
          summary.warn = `getupdates returned -14, confirming (${Math.round((Date.now() - firstSeen) / 1000)}s into 5 min window)`;
        }
      } else if (quick && r.kind === "network" && /abort/i.test(r.error || "")) {
        // quick 模式 7s 客户端超时：服务端长轮询持有约 19s，无新消息时静默超时是正常情况。
        summary.ok = true;
      } else {
        summary.error = `${r.kind} error: ${r.error}`;
      }
      if (!summary.ok || summary.error) {
        writeHealth(summary);
        console.log(JSON.stringify(summary));
        return;
      }
    }
    if (r.kind === "ok") {
      const resp = r.data;
      // 本轮成功：清除 -14 观察窗口。
      const st0 = loadState();
      if (st0.first_minus14_at) {
        delete st0.first_minus14_at;
        saveState(st0);
      }
      // 跟随服务端建议的长轮询超时（+10s，上限 120s），下次非 quick 轮询生效。
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        const st1 = loadState();
        st1.suggested_poll_timeout_ms = Math.min(
          Math.floor(resp.longpolling_timeout_ms) + 10_000,
          120_000,
        );
        saveState(st1);
      }
    const inboxEntries = readInbox();
    const known = new Set(inboxEntries.map((e) => String(e.id)).filter(Boolean));
    const inboxById = new Map(inboxEntries.map((e) => [String(e.id), e]));
    const fresh = [];
    for (const m of resp.msgs ?? []) {
      if (m.message_type !== 1) continue; // only inbound user messages
      // 过滤：只要绑定用户的私聊；群消息与他人消息跳过并计数。
      if (m.group_id) {
        summary.skipped.group++;
        continue;
      }
      if (bound && normUserId(m.from_user_id) !== normUserId(bound)) {
        summary.skipped.sender++;
        noteUnknownSender(m.from_user_id);
        continue;
      }
      const id = String(m.message_id ?? m.seq ?? `${m.create_time_ms}`);
      if (known.has(id)) continue;
      known.add(id);
      const { text, mediaItems } = extractContent(m);
      const entry = {
        id,
        from: m.from_user_id ?? "",
        to: m.to_user_id ?? "",
        session_id: m.session_id ?? "",
        group_id: m.group_id ?? "",
        context_token: m.context_token ?? "",
        time_ms: m.create_time_ms ?? Date.now(),
        text,
        media: [],
        media_unavailable: false,
        batch_id: batchId,
        status: "received",
        processed: false,
      };
      if (mediaItems.length) {
        const { metas, unavailable } = await fetchInboundMedia(entry, mediaItems);
        entry.media = metas;
        entry.media_unavailable = unavailable;
      }
      // 引用还原（学 gfydfhcf/wechat-ilink-muse-bridge）：服务端 ref_msg 只带被引
      // 消息 id（选择性引用另带 partial_text 片段），原文靠本地 inbox 历史查。
      // 查不到也不报错，只留片段；出站引用通道侧不支持，本桥不实现。
      resolveQuote(entry, m, inboxById);
      fresh.push(entry);
    }
    appendInbox(fresh);
    // 游标只在整批消息入库后才推进（学 wx-bot）：中途崩溃会重放本批，
    // inbox 按 id 去重，不会丢消息。
    if (resp.get_updates_buf !== undefined) {
      const st2 = loadState();
      st2.get_updates_buf = resp.get_updates_buf;
      saveState(st2);
    }
    summary.ok = true;
    summary.new_messages = fresh.length;
    summary.messages = fresh.map((f) => ({
      id: f.id,
      text: f.text.slice(0, 300),
      media: f.media.map((mm) => ({ kind: mm.kind, path: mm.path ?? null, error: mm.error ?? null })),
      media_unavailable: f.media_unavailable,
      context_token: f.context_token ? "<present>" : "",
    }));
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      summary.ok = true; // long-poll quiet timeout, normal
    } else {
      summary.error = String(err?.message ?? err);
    }
  }
  try {
    atomicWrite(
      LAST_POLL_FILE,
      JSON.stringify({
        time_ms: Date.now(),
        ok: summary.ok,
        session_valid: summary.session_valid,
        new_messages: summary.new_messages,
        skipped: summary.skipped,
        warn: summary.warn,
        error: summary.error,
      }),
    );
  } catch {}
  writeHealth(summary);
  console.log(JSON.stringify(summary));
}

function chunkText(text) {
  if (text.length <= CHUNK_LIMIT) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > CHUNK_LIMIT) {
    let cut = rest.lastIndexOf("\n", CHUNK_LIMIT);
    if (cut < CHUNK_LIMIT / 2) cut = CHUNK_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function logOutbox(e) {
  fs.appendFileSync(OUTBOX_FILE, JSON.stringify({ time_ms: Date.now(), ...e }) + "\n");
}

function sendMsgEnvelope({ to, clientId, itemList, contextToken }) {
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: itemList,
      ...(contextToken ? { context_token: contextToken } : {}),
    },
    base_info: baseInfo(),
  };
}

/** 发一个 sendmessage 请求：网络失败重试 3 次（退避），业务错误直接返回。 */
async function sendMessageOnce(baseUrl, token, payload) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await postJsonClassified(`${baseUrl}/ilink/bot/sendmessage`, token, payload, API_TIMEOUT_MS);
    if (r.kind === "ok") return r;
    if (r.kind === "business") return r;
    last = r;
    if (attempt < 3) await sleep(500 * 2 ** (attempt - 1));
  }
  return last;
}

async function cmdSend(argv) {
  const out = { ok: false, message_ids: [], error: null, error_kind: null };
  const get = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : "";
  };
  const to = get("--to");
  const contextToken = get("--context-token") || undefined;
  let text = get("--text");
  const textFile = get("--text-file");
  if (textFile) text = fs.readFileSync(textFile, "utf-8");
  if (!to || !text) {
    out.error = "usage: send --to <user_id> (--text <text> | --text-file <path>) [--context-token <ct>]";
    console.log(JSON.stringify(out));
    return;
  }
  // 发送守卫（学 gfydfhcf/wechat-ilink-muse-bridge 的 --key 事故手记）：正文为空或以
  // "--" 开头的一律拒绝、不发、只记审计——传错只会报错，不会把标志当消息发出去。
  if (!text.trim() || text.trimStart().startsWith("--")) {
    out.error = "refused: text is empty or starts with '--' (looks like a CLI flag, not message text)";
    logOutbox({ kind: "text", to, status: "rejected", error: out.error });
    console.log(JSON.stringify(out));
    return;
  }
  const acct = loadAccount();
  const chunks = chunkText(text);
  let failed = false;
  for (let i = 0; i < chunks.length; i++) {
    const clientId = `max-weixin:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const payload = sendMsgEnvelope({
      to,
      clientId,
      itemList: [{ type: 1, text_item: { text: chunks[i] } }],
      contextToken,
    });
    const r = await sendMessageOnce(acct.baseUrl, acct.token, payload);
    if (r.kind === "ok") {
      out.message_ids.push(r.data.message_id ?? "");
      logOutbox({ kind: "text", client_id: clientId, to, chunk_index: i, chunks_total: chunks.length, status: "sent", message_id: r.data.message_id ?? "" });
    } else {
      failed = true;
      out.error = r.error;
      out.error_kind = r.kind; // 'network'（已重试 3 次）或 'business'（未重试）
      logOutbox({ kind: "text", client_id: clientId, to, chunk_index: i, chunks_total: chunks.length, status: "failed", error: r.error, error_kind: r.kind });
      break; // 某片失败即停，避免乱序半截话
    }
    await sleep(400);
  }
  out.ok = !failed;
  console.log(JSON.stringify(out));
}

async function cmdSendMedia(argv) {
  const out = { ok: false, message_ids: [], error: null, error_kind: null };
  const get = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : "";
  };
  const to = get("--to");
  const file = get("--file");
  const type = get("--type");
  const caption = get("--caption") || "";
  // 守卫同 cmdSend：以 "--" 开头的 caption 不是正文，直接丢弃并记审计，媒体照发。
  let captionText = caption;
  if (captionText.trimStart().startsWith("--")) {
    logOutbox({ kind: "text", to, status: "rejected", error: "caption starts with '--', dropped", note: "media caption" });
    captionText = "";
  }
  const contextToken = get("--context-token") || undefined;
  if (!to || !file || !["image", "video", "file"].includes(type)) {
    out.error = "usage: sendmedia --to <user_id> --file <path> --type image|video|file [--caption <text>] [--context-token <ct>]";
    console.log(JSON.stringify(out));
    return;
  }
  try {
    const rawBytes = fs.readFileSync(file);
    if (rawBytes.length > MAX_MEDIA_BYTES) throw new Error(`file too large: ${rawBytes.length} bytes`);
    if (rawBytes.length === 0) throw new Error("file is empty");
    const acct = loadAccount();
    const headers = buildHeaders(acct.token);
    const keyHex = randomHex(16);
    const filekey = randomHex(16);
    const { uploadUrl, cipher } = await getUploadUrl({
      baseUrl: acct.baseUrl,
      headers,
      baseInfo: baseInfo(),
      filekey,
      mediaType: MEDIA_TYPE_NUM[type],
      toUserId: to,
      rawBytes,
      keyHex,
    });
    const encryptParam = await uploadCipher(uploadUrl, cipher);
    // media 引用里的 aes_key 是十六进制密钥串的 base64（按文档发送端行为）。
    const aesKeyB64 = Buffer.from(keyHex, "ascii").toString("base64");
    const mediaRef = { encrypt_query_param: encryptParam, aes_key: aesKeyB64, encrypt_type: 1 };
    let item;
    if (type === "image") {
      item = { type: 2, image_item: { media: mediaRef, mid_size: cipher.length } };
    } else if (type === "video") {
      item = { type: 5, video_item: { media: mediaRef, video_size: cipher.length } };
    } else {
      item = {
        type: 4,
        file_item: { media: mediaRef, file_name: path.basename(file), len: String(rawBytes.length) },
      };
    }
    // 说明文字与媒体拆成独立请求：caption 先发、媒体随后（与参考实现 sendMediaItems 一致）。
    if (captionText) {
      const capClientId = `max-weixin:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      const rc = await sendMessageOnce(
        acct.baseUrl,
        acct.token,
        sendMsgEnvelope({ to, clientId: capClientId, itemList: [{ type: 1, text_item: { text: captionText } }], contextToken }),
      );
      if (rc.kind === "ok") {
        out.message_ids.push(rc.data.message_id ?? "");
        logOutbox({ kind: "text", client_id: capClientId, to, chunk_index: 0, chunks_total: 1, status: "sent", message_id: rc.data.message_id ?? "", note: "media caption" });
      } else {
        out.error = `caption failed: ${rc.error}`;
        out.error_kind = rc.kind;
        logOutbox({ kind: "text", client_id: capClientId, to, chunk_index: 0, chunks_total: 1, status: "failed", error: rc.error, error_kind: rc.kind, note: "media caption" });
      }
      await sleep(400);
    }
    const clientId = `max-weixin-media:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const r = await sendMessageOnce(
      acct.baseUrl,
      acct.token,
      sendMsgEnvelope({ to, clientId, itemList: [item], contextToken }),
    );
    if (r.kind !== "ok") {
      const errMsg = `media failed: ${r.error}`;
      out.error = out.error ? `${out.error}; ${errMsg}` : errMsg;
      out.error_kind = r.kind;
      logOutbox({ kind: `media:${type}`, client_id: clientId, to, file, status: "failed", error: r.error, error_kind: r.kind });
      console.log(JSON.stringify(out));
      return;
    }
    out.message_ids.push(r.data.message_id ?? "");
    logOutbox({ kind: `media:${type}`, client_id: clientId, to, file, status: "sent", message_id: r.data.message_id ?? "" });
    out.ok = !out.error;
  } catch (err) {
    out.error = String(err?.message ?? err);
    out.error_kind = "local";
  }
  console.log(JSON.stringify(out));
}

function loadTypingTickets() {
  try {
    const t = JSON.parse(fs.readFileSync(TYPING_TICKET_FILE, "utf-8"));
    return t && typeof t === "object" ? t : {};
  } catch {
    return {};
  }
}

/** 取某用户最近一条 inbox 里的 context_token（typing 票据需要它）。 */
function latestContextToken(to) {
  const entries = readInbox();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (normUserId(e.from) === normUserId(to) && e.context_token) return e.context_token;
  }
  return "";
}

/** 取（或刷新）某用户的 typing_ticket，缓存 9 分钟（学参考实现）。体裁照抄参考实现。 */
async function fetchTypingTicket(acct, to, force) {
  const book = loadTypingTickets();
  const now = Date.now();
  const cached = book[normUserId(to)];
  if (!force && cached?.ticket && now - (cached.at ?? 0) < TYPING_TICKET_TTL_MS) return cached.ticket;
  const ctx = latestContextToken(to);
  if (!ctx) return null;
  const r = await postJsonClassified(
    `${acct.baseUrl}/ilink/bot/getconfig`,
    acct.token,
    { ilink_user_id: to, context_token: ctx, base_info: { channel_version: "1.0.2" } },
    API_TIMEOUT_MS,
  );
  if (r.kind !== "ok") return null;
  const ticket = r.data?.typing_ticket;
  if (!ticket) return null;
  book[normUserId(to)] = { ticket, at: now };
  try {
    atomicWrite(TYPING_TICKET_FILE, JSON.stringify(book));
  } catch {}
  return ticket;
}

/**
 * 显示/取消“正在输入”：typing --to <user_id> <start|stop>。
 * 装饰性功能，失败只打印 ok:false，永不抛错、永不阻塞调用方。
 */
async function cmdTyping(argv) {
  const out = { ok: false, error: null };
  const get = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : "";
  };
  const to = get("--to") || argv[0] || "";
  const word = argv[argv.length - 1] || "";
  const status = { start: 1, stop: 2 }[word];
  if (!to || status === undefined) {
    out.error = "usage: typing --to <user_id> <start|stop>";
    console.log(JSON.stringify(out));
    return;
  }
  try {
    const acct = loadAccount();
    let ticket = await fetchTypingTicket(acct, to, false);
    if (!ticket) {
      out.error = "NO_TYPING_TICKET";
      console.log(JSON.stringify(out));
      return;
    }
    const sendOnce = (t) =>
      postJsonClassified(
        `${acct.baseUrl}/ilink/bot/sendtyping`,
        acct.token,
        { ilink_user_id: to, typing_ticket: t, status, base_info: { channel_version: "1.0.2" } },
        API_TIMEOUT_MS,
      );
    let r = await sendOnce(ticket);
    if (r.kind !== "ok") {
      // 票据可能已失效：强制刷新后重试一次；仍无票据直接报错，不发必然失败的请求。
      ticket = await fetchTypingTicket(acct, to, true);
      if (!ticket) {
        out.error = "NO_TYPING_TICKET";
        console.log(JSON.stringify(out));
        return;
      }
      r = await sendOnce(ticket);
    }
    if (r.kind !== "ok") {
      out.error = `TYPING_FAILED: ${r.error}`;
      console.log(JSON.stringify(out));
      return;
    }
    out.ok = true;
  } catch (err) {
    out.error = `TYPING_ERROR: ${String(err?.message ?? err)}`;
  }
  console.log(JSON.stringify(out));
}

async function cmdMark(argv) {
  const out = { ok: false, error: null };
  const get = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : "";
  };
  const id = get("--id");
  const status = get("--status");
  const note = get("--note") || undefined;
  if (!id || !["received", "executing", "replied"].includes(status)) {
    out.error = "usage: mark --id <inbox_id> --status received|executing|replied [--note <text>]";
    console.log(JSON.stringify(out));
    return;
  }
  const entries = readInbox();
  const e = entries.find((x) => String(x.id) === String(id));
  if (!e) {
    out.error = `inbox id not found: ${id}`;
    console.log(JSON.stringify(out));
    return;
  }
  e.status = status;
  e.status_at = new Date().toISOString();
  if (note !== undefined) e.status_note = note;
  atomicWrite(INBOX_FILE, entries.map((x) => JSON.stringify(x)).join("\n") + "\n");
  out.ok = true;
  console.log(JSON.stringify(out));
}

function countMediaFiles() {
  let n = 0;
  try {
    for (const day of fs.readdirSync(MEDIA_INBOUND_DIR)) {
      const d = path.join(MEDIA_INBOUND_DIR, day);
      if (!fs.statSync(d).isDirectory()) continue;
      n += fs.readdirSync(d).length;
    }
  } catch {}
  return n;
}

async function cmdStatus() {
  const entries = readInbox();
  const done = repliedIds();
  let unreplied = 0;
  let executing = 0;
  for (const e of entries) {
    if (done.has(String(e.id))) continue;
    if (e.status === "executing") executing++;
    else if (!e.status || e.status === "received") unreplied++;
  }
  let outboxTotal = 0;
  let outboxFailed = 0;
  try {
    for (const line of fs.readFileSync(OUTBOX_FILE, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      outboxTotal++;
      try {
        if (JSON.parse(line).status === "failed") outboxFailed++;
      } catch {}
    }
  } catch {}
  let login = null;
  try {
    login = JSON.parse(fs.readFileSync(LOGIN_STATUS_FILE, "utf-8"));
  } catch {}
  let lastPoll = null;
  try {
    lastPoll = JSON.parse(fs.readFileSync(LAST_POLL_FILE, "utf-8"));
  } catch {}
  const health = readHealth();
  const pollState = pollStateFromHealth(health);
  let accountPresent = false;
  let baseUrl = "";
  let boundUser = "";
  try {
    const a = loadAccount();
    accountPresent = !!a.token;
    baseUrl = a.baseUrl || "";
    boundUser = a.userId || "";
  } catch {}
  console.log(
    JSON.stringify({
      ok: true,
      account_present: accountPresent,
      base_url: baseUrl,
      bound_user: boundUser,
      login,
      last_poll: lastPoll,
      poll_state: pollState,
      poll_health: health,
      inbox_total: entries.length,
      unreplied,
      executing,
      media_inbound_files: countMediaFiles(),
      outbox_total: outboxTotal,
      outbox_failed: outboxFailed,
    }),
  );
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "poll") await cmdPoll(rest);
else if (cmd === "send") await cmdSend(rest);
else if (cmd === "sendmedia") await cmdSendMedia(rest);
else if (cmd === "mark") await cmdMark(rest);
else if (cmd === "typing") await cmdTyping(rest);
else if (cmd === "status") await cmdStatus();
else if (cmd === "login") await cmdLogin();
else {
  console.error("usage: wxbridge.mjs <poll|send|sendmedia|mark|typing|status|login> ...");
  process.exit(1);
}

// ── login (standalone QR login, no OpenClaw gateway) ─────────────────────────
// 以下为 2026-10-05 已验证的登录流程，原样保留。

async function apiGet(url, token, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: buildHeaders(token), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } catch (err) {
    if (err?.name === "AbortError") return { status: "wait" };
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function writeLoginStatus(s) {
  fs.writeFileSync(LOGIN_STATUS_FILE, JSON.stringify({ ...s, updated_at: new Date().toISOString() }));
}

async function fetchQr(baseUrl, localTokens) {
  const resp = await postJson(
    `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`,
    undefined,
    { local_token_list: localTokens },
    API_TIMEOUT_MS,
  );
  if (!resp.qrcode || !resp.qrcode_img_content) {
    throw new Error(`get_bot_qrcode unexpected response: ${JSON.stringify(resp).slice(0, 200)}`);
  }
  return resp;
}

async function cmdLogin() {
  const baseUrl = "https://ilinkai.weixin.qq.com";
  // Existing token (if any) goes into local_token_list so the server can reuse it.
  let localTokens = [];
  try {
    const acct = loadAccount();
    if (acct.token) localTokens = [acct.token];
  } catch {}
  try { fs.unlinkSync(LOGIN_VERIFY_FILE); } catch {}

  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  let refreshCount = 0;

  while (Date.now() < deadline && refreshCount <= MAX_QR_REFRESH) {
    let qr;
    try {
      qr = await fetchQr(baseUrl, localTokens);
    } catch (err) {
      writeLoginStatus({ status: "error", error: `获取二维码失败: ${err.message}` });
      console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
      return;
    }
    // QR image PNG for the user to scan (generated by the caller via make-qr).
    writeLoginStatus({ status: "waiting_scan", qrcode_url: qr.qrcode_img_content, refresh: refreshCount });
    console.log(JSON.stringify({ status: "waiting_scan", qrcode_url: qr.qrcode_img_content }));

    let currentBase = baseUrl;
    let scannedAnnounced = false;
    while (Date.now() < deadline) {
      // Pick up a user-supplied verify code if the server asked for one.
      let verifyCode;
      try {
        const v = fs.readFileSync(LOGIN_VERIFY_FILE, "utf-8").trim();
        if (v) verifyCode = v;
      } catch {}
      let endpoint = `${currentBase}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`;
      if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;

      let st;
      try {
        st = await apiGet(endpoint, undefined, QR_STATUS_TIMEOUT_MS);
      } catch (err) {
        writeLoginStatus({ status: "waiting_scan", qrcode_url: qr.qrcode_img_content, note: `网络抖动，重试中 (${err.message})` });
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      if (st.status === "wait") {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (st.status === "scaned") {
        if (!scannedAnnounced) {
          scannedAnnounced = true;
          writeLoginStatus({ status: "scanned", qrcode_url: qr.qrcode_img_content, note: "已扫码，等待手机上确认" });
          console.log(JSON.stringify({ status: "scanned" }));
        }
        try { fs.unlinkSync(LOGIN_VERIFY_FILE); } catch {}
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (st.status === "need_verifycode") {
        writeLoginStatus({ status: "need_verifycode", qrcode_url: qr.qrcode_img_content, note: "手机微信显示了一串数字，请告诉 Max，把数字写入 verify_code.txt 后会自动继续" });
        console.log(JSON.stringify({ status: "need_verifycode" }));
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (st.status === "verify_code_blocked") {
        writeLoginStatus({ status: "error", error: "验证码多次输错被锁定，请稍后再试" });
        console.log(JSON.stringify({ ok: false, error: "verify_code_blocked" }));
        return;
      }
      if (st.status === "scaned_but_redirect" && st.redirect_host) {
        currentBase = `https://${st.redirect_host}`;
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (st.status === "binded_redirect") {
        writeLoginStatus({ status: "done", note: "该微信已绑定过，无需重复登录" });
        console.log(JSON.stringify({ ok: true, already_bound: true }));
        return;
      }
      if (st.status === "expired") {
        refreshCount++;
        writeLoginStatus({ status: "refreshing", note: `二维码过期，正在刷新 (${refreshCount}/${MAX_QR_REFRESH})` });
        console.log(JSON.stringify({ status: "refreshing", refresh: refreshCount }));
        break; // outer loop fetches a new QR
      }
      if (st.status === "confirmed") {
        if (!st.ilink_bot_id || !st.bot_token) {
          writeLoginStatus({ status: "error", error: "服务器确认了登录但没返回凭证" });
          console.log(JSON.stringify({ ok: false, error: "confirmed without credentials" }));
          return;
        }
        // Backup old account file, save new credentials.
        try {
          const old = fs.readFileSync(ACCOUNT_FILE, "utf-8");
          fs.writeFileSync(ACCOUNT_FILE + ".bak", old);
        } catch {}
        fs.writeFileSync(
          ACCOUNT_FILE,
          JSON.stringify({
            token: st.bot_token,
            savedAt: new Date().toISOString(),
            baseUrl: st.baseurl || currentBase,
            userId: st.ilink_user_id || "",
            accountId: st.ilink_bot_id,
          }),
        );
        try { fs.unlinkSync(LOGIN_VERIFY_FILE); } catch {}
        writeLoginStatus({ status: "done", account_id: st.ilink_bot_id, note: "登录成功" });
        console.log(JSON.stringify({ ok: true, account_id: st.ilink_bot_id }));
        return;
      }
      // Unknown status — keep waiting briefly.
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  writeLoginStatus({ status: "error", error: "登录超时，请重试" });
  console.log(JSON.stringify({ ok: false, error: "timeout" }));
}
