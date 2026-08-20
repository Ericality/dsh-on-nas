#!/bin/sh
# 默认方案: dsh web (127.0.0.1:3081) + auth-proxy.js (0.0.0.0:3080, 前端登录页)
set -eu

# dsh web 只监听回环 (官方禁止 0.0.0.0), 端口 3081 避免与对外端口冲突
dsh web --port 3081 &
dsh_pid=$!

# auth-proxy: 登录页 + 会话 Cookie + 转发 (改写 Host/Origin 通过信任围栏)
# 设置了 DSH_AUTH_USERNAME/DSH_AUTH_PASSWORD 才启用登录; 否则纯转发(仅限可信局域网)
node /usr/local/lib/dsh-auth-proxy.js &
proxy_pid=$!

terminate() {
  kill "$dsh_pid" "$proxy_pid" 2>/dev/null || true
}

trap terminate INT TERM EXIT

while kill -0 "$dsh_pid" 2>/dev/null && kill -0 "$proxy_pid" 2>/dev/null; do
  sleep 2
done

if ! kill -0 "$dsh_pid" 2>/dev/null; then
  wait "$dsh_pid"
else
  wait "$proxy_pid"
fi
