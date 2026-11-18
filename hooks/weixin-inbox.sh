#!/usr/bin/env bash
# WeChat inbox watcher for Max's direct WeChat bridge.
# Runs frequently (cheap: one HTTPS poll, no agent). Wakes an agent only when
# there are unreplied user messages or the WeChat session expired.
# Control flow guarantees exactly one terminal call (wake/silent).
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

BRIDGE="$HOME/workspace/weixin-bridge"
STATE_DIR="$HOME/hooks/state"
SESSION_FLAG="$STATE_DIR/weixin-session-notified"
DRY="${HATCH_HOOK_DRY_RUN:-0}"

mkdir -p "$STATE_DIR"

poll_out="$(node "$BRIDGE/wxbridge.mjs" poll --quick 2>/dev/null)" || {
  log "wechat poll failed (inconclusive)"
  silent "poll failed, will retry next interval" '{}'
}

ok="$(printf '%s' "$poll_out" | jq -r '.ok // false')"
session_valid="$(printf '%s' "$poll_out" | jq -r '.session_valid // true')"
new_messages="$(printf '%s' "$poll_out" | jq -r '.new_messages // 0')"

if [ "$ok" != "true" ]; then
  log "wechat poll not ok"
  silent "poll inconclusive" '{}'
elif [ "$session_valid" != "true" ]; then
  if [ -f "$SESSION_FLAG" ]; then
    silent "session expired, already notified" '{}'
  else
    if [ "$DRY" != "1" ]; then
      touch "$SESSION_FLAG"
    fi
    wake "wechat-session-expired" '{"session_valid":false}'
  fi
else
  # Session healthy: clear any stale notified flag (real runs only).
  if [ "$DRY" != "1" ] && [ -f "$SESSION_FLAG" ]; then
    rm -f "$SESSION_FLAG"
  fi
  if [ "$new_messages" -gt 0 ] 2>/dev/null; then
    # 已有 agent 在处理（executing 且 10 分钟内）时不再重复唤醒，避免
    # 多次唤醒堆积（学 wx-bot 的 lease 思路：处理中的事件不重复计数）。
    # 检查失败时 fail-open：照常唤醒，绝不因 guard 本身丢消息。
    if BRIDGE="$BRIDGE" node -e 'const fs=require("fs");const f=process.env.BRIDGE+"/inbox.jsonl";let busy=false;try{for(const l of fs.readFileSync(f,"utf-8").split("\n")){if(!l.trim())continue;const e=JSON.parse(l);if(e.status==="executing"&&e.status_at&&Date.now()-Date.parse(e.status_at)<600000){busy=true;break;}}}catch{}process.exit(busy?0:1);' 2>/dev/null; then
      log "skip wake: an agent is already executing a message"
      silent "already executing" '{}'
    else
      # 点亮“正在输入”（学 gfydfhcf/wechat-ilink-muse-bridge：批次落地即亮，
      # 不等 worker 启动）：让用户立刻看到机器人在干活；失败忽略，绝不阻塞唤醒。
      sender="$(BRIDGE="$BRIDGE" node -e 'const fs=require("fs");let s="";try{for(const l of fs.readFileSync(process.env.BRIDGE+"/inbox.jsonl","utf-8").split("\n")){if(!l.trim())continue;const e=JSON.parse(l);if(e.status==="received"&&!e.group_id&&e.from)s=e.from;}}catch{}process.stdout.write(s);' 2>/dev/null)"
      if [ -n "$sender" ]; then
        timeout 10 node "$BRIDGE/wxbridge.mjs" typing --to "$sender" start >/dev/null 2>&1 || true
      fi
      wake "wechat-new-messages" "{\"count\":$new_messages}"
    fi
  else
    silent "no new wechat messages" '{}'
  fi
fi
