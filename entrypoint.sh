#!/bin/sh
# 默认方案: dsh web (127.0.0.1:3081) + auth-proxy.js (0.0.0.0:3080)
# 访问方式:
#   - 设置 HTTPS_ACCESS_HOST=NAS的IP或域名 -> 自动生成自签名证书, HTTPS 访问
#     (浏览器首次访问点一次"继续前往"即可; 之后 UI 正常, 因为 HTTPS 是安全上下文)
#   - 不设置 HTTPS_ACCESS_HOST              -> 纯 HTTP, 仅限 localhost / SSH 隧道 /
#     Cloudflare 隧道回源; 局域网 http://IP:3080 直连会因浏览器安全上下文限制
#     (crypto.randomUUID 不可用) 导致 UI 报错
set -eu

# dsh web 只监听回环 (官方禁止 0.0.0.0), 端口 3081 避免与对外端口冲突
dsh web --port 3081 &
dsh_pid=$!

# 可选: 生成自签名证书, 启用 HTTPS
if [ -n "${HTTPS_ACCESS_HOST:-}" ]; then
  mkdir -p /etc/dsh-tls
  case "$HTTPS_ACCESS_HOST" in
    *[!0-9.]*) SAN="DNS:${HTTPS_ACCESS_HOST}" ;;  # 域名
    *)          SAN="IP:${HTTPS_ACCESS_HOST}" ;;  # 纯 IP
  esac
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout /etc/dsh-tls/key.pem -out /etc/dsh-tls/cert.pem \
    -subj "/CN=${HTTPS_ACCESS_HOST}" \
    -addext "subjectAltName=${SAN}" >/dev/null 2>&1
  export DSH_TLS=1 DSH_TLS_CERT=/etc/dsh-tls/cert.pem DSH_TLS_KEY=/etc/dsh-tls/key.pem
  echo ">> HTTPS 已启用: https://${HTTPS_ACCESS_HOST}:3080 (自签名证书, 首次访问需点一次信任)"
else
  echo ">> 未设置 HTTPS_ACCESS_HOST -> 纯 HTTP (仅限 localhost/SSH 隧道/Cloudflare 隧道回源)"
fi

# auth-proxy: 登录页 + 会话 Cookie + 转发 (改写 Host/Origin 通过信任围栏)
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
