# 微信直连桥 wechat-bridge

把微信变成 AI 助手的直连通道：**不用 OpenClaw 网关**，Node.js 脚本直接讲
微信 ilink bot 协议（`@tencent-weixin/openclaw-weixin-cli` 建好的登录态复用），
再由 Agent（本仓库以 Muse 为例）认领收件箱里的消息、回微信。

这份仓库是可直接跑的部署方法论：脚本 + 轮询 hook + 运维笔记。
私有仓库，先私有、确认无敏感信息后再考虑公开。

## 它能做什么

- 收：只收绑定用户的一对一私聊；群消息、陌生人消息跳过并计数。
- 回：文字自动按段落分片发送；图片 / 视频 / 语音 / 文件可收可发。
- **能看懂图片**：图片消息下载后按协议解密落盘成明文文件，Agent
  直接读图批改、认字、答题——不是只回一句“收到一张图片”。
- 稳：游标后推进（崩溃重放不丢消息）、-14 先观察 5 分钟再判过期、
  健康心跳 `health.json`、防重复唤醒（执行中 10 分钟内不再唤醒）。

## 架构

```
微信 ──ilink bot 协议──> wxbridge.mjs poll ──> inbox.jsonl (status=received)
                                                        │
                              hook (20s 轮询, poll --quick) 发现未回复消息
                                                        │ 唤醒 Agent
                                                        ▼
                              Agent: 读 inbox → mark executing → 干活
                                                        │ 媒体: media/inbound/<日期>/ 已解密
                                                        ▼
                              Agent: send / sendmedia ──> 微信
                                                        │ 记 outbox.jsonl
                                                        ▼
                              mark replied + 记入 replied.txt
```

消息四态：`received` → `executing` →（发回复）→ `replied`。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `wxbridge.mjs` | 桥本体：poll / send / sendmedia / mark / status / login |
| `wxmedia.mjs` | 媒体收发：CDN 下载、AES 解密、上传（getuploadurl → CDN → sendmessage） |
| `hooks/weixin-inbox.sh` | 轮询脚本：20 秒一次 `poll --quick`，只在有未回复消息或 session 过期时唤醒 Agent |
| `hooks/weixin-inbox.json` | hook 定义：提示词、轮询间隔、唤醒条件 |
| `NOTES.md` | 运维笔记：命令、四态流转、过滤规则、凭据说明、2026-11-17 提升方案 |
| `.gitignore` | 运行数据黑名单：inbox / outbox / state / media / 登录态一律不进仓库 |

## 快速开始

```bash
# 1. 先用 openclaw-weixin-cli 扫码登录一次，账号文件落在
#    ~/.openclaw/openclaw-weixin/accounts/<ACCOUNT_ID>.json
# 2. 告诉桥你的 bot 账号 id
export WXBRIDGE_ACCOUNT_ID="你的bot账号id-im-bot"

# 3. 收消息（常驻轮询）
node wxbridge.mjs poll
# 只做一次快速检查（给 hook 用，不耗 token）
node wxbridge.mjs poll --quick

# 4. 发文字 / 发图
node wxbridge.mjs send --to <用户id> --text "你好"
node wxbridge.mjs sendmedia --to <用户id> --file ./a.jpg --type image

# 5. 看健康
node wxbridge.mjs status
# 6. Agent 认领 / 收尾
node wxbridge.mjs mark --id <inbox消息id> --status executing
node wxbridge.mjs mark --id <inbox消息id> --status replied
```

Node.js ≥ 18 即可，无第三方依赖（只有 `node:crypto / fs / path / os`）。

## 为什么它能识别图片，别人的仓库不行

对照研究过两个同类仓库（`Liu-zhongxian/wechat-bridge` Python 版、
`lawrencewzen/wx-bot` TS 版）后，关键差在媒体链路是否走完：

- 图片不是“收到占位文本就完事”：`poll` 收到图片消息后，按协议取
  `image_item.aeskey`（优先）或 `media.aes_key` 解密，AES-128-ECB +
  PKCS#7，还原成明文图片落到 `media/inbound/<日期>/`。
- Agent 处理消息的标准动作是“有 `media[].path` 就直接读文件”，
  所以批改作业、认图、读表都能做。
- 常见缺口：只存了加密后的 CDN 密文、没实现解密；或只认 `full_url`、
  没试 `encrypt_query_param` 地址（实测视频必须用 param 地址，
  `full_url` 解出来是坏的）。本仓库双源回退：先 param 地址、再
  full_url，下载或解密失败换源再试。

从那两个仓库学来、已落地的 6 项改进，见 `NOTES.md`
“2026-11-17 提升方案”一节：游标后推进、-14 先观察、长轮询超时跟随
服务端、健康心跳、媒体双源回退、防重复唤醒。

## 安全红线（API Key 保护）

- Token 只在 `~/.openclaw/openclaw-weixin/accounts/` 的账号文件里，
  运行时读取，**永不进仓库、永不进日志、永不进记忆**。
- `.gitignore` 已屏蔽：`state.json`、`inbox.jsonl`、`outbox.jsonl`、
  `replied.txt`、`login.json`、`login-qr.png`、`media/`、一切 `*.bak`。
- 发仓库前自查：`grep -r "你的账号id\|你的用户id" .` 应无命中；
  不要把 `inbox.jsonl` / `media/` 打包进任何备份里对外发。
- 仓库默认私有；公开前重新扫一遍提交历史，不只是扫当前文件。

## 微信排版约定（实测）

- 段落之间空一行，单换行会被微信吞掉；分隔线用全角长线
  `──────────────`，不用 markdown 的 `---`。
- 紧凑版：正文条目之间不空行，只有段落 / 区块之间空一行分段；
  分点内容默认每点换行显示。
- 支持的 markdown 子集：`**加粗**`、换行分段、行内代码、代码块、
  简单表格；不要用图片、删除线、五级以下标题、复杂嵌套。

## 局限

- 微信登录态过期（errcode -14）需重新扫码，桥本身不代扫。
- 语音转文字、图片 / 文件 / 视频占位以外的多媒体，需 Agent
  侧另行处理；`media_unavailable=true` 时如实告诉用户看不到。
- `hooks/` 的轮询唤醒是按 Muse 的 hook 机制写的，用别的 Agent
  框架时按自己家的调度方式改，桥的 `poll / mark / status` 接口不变。
