#!/bin/sh
# 默认方案: dsh web (127.0.0.1:3081) + auth-proxy.js 双端口 (0.0.0.0)
#   :3080 HTTP  给 Cloudflare Tunnel 回源 / SSH 隧道 / localhost (免证书)
#   :8443 HTTPS 给局域网直连 (设置 HTTPS_ACCESS_HOST 后启用, 自签名证书,
#               浏览器首次访问点一次"继续前往"; HTTPS 是安全上下文, UI 才能用)
set -eu

# ---- 可选: 首次启动释放本地自定义插件 (DSH_DEPLOY_PLUGINS=1 才启用) ----
# 默认不释放; 配置为 1 时只在第一次启动时"只补不覆盖"地播种进 /data/dsh,
# 之后重启由 .seeded 标记跳过, 不会动已有数据。
# 涉及密钥的插件 (notify 群晖 webhook 等) 需在播种后到配置文件里填写才生效,
# 详见 /workspace/docs/插件部署手册.md 与 seed/cordis.patch.yml 注释。
if [ "${DSH_DEPLOY_PLUGINS:-0}" = "1" ] && [ -d /opt/dsh-seed ] && [ ! -f /data/dsh/.seeded ]; then
  echo ">> DSH_DEPLOY_PLUGINS=1: 首次释放本地插件与配置 ..."
  # 注意顺序: 必须先落地插件包和 patch, 再初始化 profile —— 初始化只会生成
  # 空 patch, 而 cp -n 不会覆盖已存在文件, 顺序反了 seed 的 patch 会被跳过。
  mkdir -p /data/dsh/profiles/web/node_modules/@deepseek-ai
  cp -rn /opt/dsh-seed/plugins/@deepseek-ai/* /data/dsh/profiles/web/node_modules/@deepseek-ai/ 2>/dev/null || true
  cp -rn /opt/dsh-seed/cordis.patch.yml /data/dsh/profiles/web/ 2>/dev/null || true
  cp -rn /opt/dsh-seed/settings.yaml    /data/dsh/ 2>/dev/null || true
  cp -rn /opt/dsh-seed/.agent-presets   /data/dsh/ 2>/dev/null || true
  cp -rn /opt/dsh-seed/AGENTS.md        /data/dsh/ 2>/dev/null || true
  cp -rn /opt/dsh-seed/ENV.md.template  /workspace/ENV.md 2>/dev/null || true
  cp -rn /opt/dsh-seed/assets           /workspace/ 2>/dev/null || true
  cp -rn /opt/dsh-seed/rescue           /data/dsh/ 2>/dev/null || true
  # 初始化 web profile (生成 cordis.yml/package.json 等; 已存在的 patch 不会被覆盖)
  dsh --profile web --dump-config >/dev/null 2>&1 || true
  touch /data/dsh/.seeded
  echo ">> 播种完成 (标记 /data/dsh/.seeded, 后续重启不再释放)"
fi

# dsh web 只监听回环 (官方禁止 0.0.0.0), 端口 3081 避免与对外端口冲突
dsh web --port 3081 &
dsh_pid=$!

# 可选: 生成自签名证书, 启用 8443 HTTPS 端口
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
  echo ">> HTTPS 已启用: https://${HTTPS_ACCESS_HOST}:8443 (局域网直连用, 自签名证书)"
else
  echo ">> 未设置 HTTPS_ACCESS_HOST -> 无 HTTPS 端口; 局域网直连请改用 Cloudflare 隧道或 SSH 隧道"
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
