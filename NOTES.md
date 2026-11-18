# 微信直连桥 · 运维笔记（2026-10-11 全量改造版）

## 命令
- `node wxbridge.mjs poll [--quick]` — 收消息（只收绑定用户私聊，群/他人跳过并计数）。
  新消息进 `inbox.jsonl`，`status=received`，同轮共享 `batch_id`；
  图片/视频/语音/文件自动下载解密到 `media/inbound/<日期>/`。
- `node wxbridge.mjs send --to <uid> --text ...` — 发文字（自动分片；网络失败重试3次，业务错误直接停）。
- `node wxbridge.mjs sendmedia --to <uid> --file <path> --type image|video|file [--caption ...]` — 发媒体。
- `node wxbridge.mjs mark --id <inbox_id> --status executing|replied` — 推四态。
- `node wxbridge.mjs status` — 只读健康快照（无网络、不碰凭据）。
- `node wxbridge.mjs login` — 扫码登录（2026-10-05 验证过的流程）。

## 2026-11-17 提升方案（已执行，用户指令“先备份、再执行”）
备份：`~/workspace/backups/weixin-bridge-20261117-1841/`（桥全量 + media + hook 定义/脚本 + RESTORE.md 回滚步骤 + sha256，token 未进备份）。
对照研究的两个仓库：Liu-zhongxian/wechat-bridge（Python）、lawrencewzen/wx-bot（TS），落地 6 项，全部可回滚：
1. 游标后推进：get_updates_buf 只在整批消息入库后才保存，中途崩溃会重放、inbox 按 id 去重，不丢消息。
2. -14 先观察：首次 -14 不立即判过期，观察 5 分钟、持续出现才判 session 过期（可能是限流）。
3. 长轮询超时跟随服务端：非 quick 轮询用服务端建议的 longpolling_timeout_ms（+10s，上限 120s）；quick 保持 7s。
4. 健康心跳：每轮 poll 写 `health.json`（last_ok_at / failures / failing_since），`status` 新增 `poll_state`（ok/failing/stalled/not_running，5 分钟无更新即 stalled）。
5. 媒体双源回退：下载先试 encrypt_query_param 地址、再试 full_url，下载或解密失败换源再试（视频只认 param 地址是对方实测结论）。
6. 防重复唤醒：hook 脚本在有消息且 10 分钟内已有 executing 时不再唤醒（学 wx-bot lease）；检查失败时 fail-open 照常唤醒。hook 提示词加“先回执再干活、简单问答一句话”。
刻意没动的：不改轮询间隔（20s 不是瓶颈）、不迁 SQLite、不改常驻 serve 部署形态、不动图片密钥优先级（图片识别是现有优势）、不建 GitHub 公开/私有仓库（方法论分享另等用户点头）。

## 2026-11-18 提升方案（已执行，用户指令“只要是优点都学、授权直接执行”）
备份：`~/workspace/backups/weixin-bridge-20261118-1615/`（桥全量 + hook 定义/脚本 + RESTORE.md + sha256，token 未进备份）。
对照研究的第三个仓库：gfydfhcf/wechat-ilink-muse-bridge（Python，284★，2026-11-17 更新，同构：iLink + Muse hook，README + ilink.py + hook 脚本全读过），落地 5 项，全部可回滚：
1. 正在输入提示：`typing --to <uid> start|stop`（getconfig 取 typing_ticket 缓存 9 分钟 + sendtyping 开关，体裁照抄对方生产验证版）；hook 唤醒时即亮、worker 开工续亮、回完熄灭；失败永不阻塞。2026-11-18 实测 ok:true。
2. 发送守卫：send 拒绝空正文与 `--` 开头正文（对方 2026-10-27 `--key` 误发事故的教训），只记审计、不发；caption 同理（丢弃 caption、媒体照发）。实测拦截 `--key` 成功。
3. 陌生发信人登记：poll 丢弃非绑定用户消息时记 `unknown_senders.json`（id→次数/最后出现），放行只能主聊天人工定。
4. 引用还原：poll 解析 ref_msg，用本地 inbox 历史还原被引原文（`quoted_text`/`quoted_from`），查不到只留 `quoted_fragment`；出站引用通道侧不支持，不实现。
5. 发送前复查合并：发最终回复前再读一遍 inbox.jsonl，同一发送者更新的未回复消息并进来一起回（对方“发送前复查”的做法，流程级落地、无代码改动）。
刻意没动的：媒体断点续传（media 目录仅 416K，文件小、双源回退已够用）、warm-wait 常驻守候（本机 hook 每次唤醒是全新 worker，无常驻 worker 可守）、发送幂等账本（本桥重试复用同一 client_id，服务端去重已覆盖；outbox 已有全量审计）、告警状态机/看门狗 cron（poll_failing 满 10 分钟才报、恢复报平安——需新增 cron 唤醒路径，本次未动）、版本订阅/自动更新（对方自有 release 体系，本桥私有仓库 webber181/wechat-bridge 另行管理）。

## 四态流转
`received`(poll) → `executing`(agent 开工时 mark) → 发回复(`send`/`sendmedia` 记 outbox) → `replied`(agent 收尾时 mark)。
`status` 命令看未回复数；`replied.txt` 是旧账本，`status` 会兼容它。

## Agent 处理微信消息的标准动作（被 hook 唤醒后）
1. 读 `inbox.jsonl` 找 `status=received` 的新消息；`mark --status executing`；开工即 `typing --to <from> start` 点亮“正在输入”（hook 唤醒时已亮过一次，这里是续亮）。
2. 有 `media[].path` → 用 read 看图/看视频；`media_unavailable=true` → 回「这条图片/视频没能下载成功，请用文字描述一下内容」。有 `quoted_text` → 先看被引原文再回。
3. 文字任务正常执行；发之前再读一遍 inbox.jsonl（发送前复查）：同一发送者如有更新的未回复消息，并进来一起回，只回一条。
4. `send`/`sendmedia` 回结果；回完 `typing --to <from> stop`；`mark --status replied`。

## 过滤规则
只处理 `from_user_id` = 账号文件 `userId`（扫码绑定用户）且 `group_id` 为空的消息。
userId 丢失时 fail-open（照单全收，summary.warn 提示）。

## 凭据
token 只在 `~/.openclaw/openclaw-weixin/accounts/` 的账号文件里，运行时读取；
`status`/日志/记忆里永不出现完整凭据。
