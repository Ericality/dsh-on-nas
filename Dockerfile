# ============================================================
# 自建 DeepSeek Harness 镜像 — 无 Caddy / 无强制 HTTPS / 可追新版本
#
# 与原 ghcr.io/kanzuori197/deepseek-harness-nas 的区别:
#   - 去掉 Caddy + 自签名 HTTPS + basic auth 弹窗
#   - 改为纯 Node 认证代理 (auth-proxy.js): 前端登录页面 + 会话 Cookie
#   - 对外访问 http://NAS_IP:3080, 不再有证书警告
#   - dsh 版本用 ARG 控制, 配合 GitHub Actions / build.sh 可一键追最新版本
#
# 为什么还要一层反代? 官方 dsh web 出于安全考虑禁止绑定 0.0.0.0
# ("would expose remote code execution to the network"), host 只接受
# 127.0.0.1, 所以必须由本地代理对外提供服务。auth-proxy.js 零依赖,
# 只做登录 + 转发, 无 TLS。
#
# 端口分配 (避免监听冲突):
#   - dsh web        127.0.0.1:3081  (仅回环)
#   - auth-proxy     0.0.0.0:3080    (对外, 登录页 + 转发)
#
# 用法: docker build -t dsh-nas:0.1.0-rc.7 .
# ============================================================

# 基础镜像 digest 固定 (与已审计的 ghcr.io 镜像同一基础, 逐层一致)
FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a

ARG DSH_VERSION=0.1.0-rc.7
ARG NPM_REGISTRY=https://registry.npmjs.org

ENV HOME=/data/dsh \
    DSH_HOME=/data/dsh \
    DSH_TELEMETRY_DISABLED=1

# 构建依赖 (dsh 部分插件需要原生编译)
RUN echo '#!/bin/sh\nexit 0' > /usr/sbin/policy-rc.d \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       git \
       python3 \
       make \
       g++ \
    && rm -f /usr/sbin/policy-rc.d \
    && rm -rf /var/lib/apt/lists/*

# 从 npm 官方源安装 dsh (DSH_VERSION 决定版本, 不会锁死旧 rc)
RUN npm install --global --no-audit --no-fund --registry="${NPM_REGISTRY}" "@deepseek-ai/dsh@${DSH_VERSION}" \
    && dsh --help >/dev/null

COPY entrypoint.sh /usr/local/bin/dsh-entrypoint
COPY auth-proxy.js /usr/local/lib/dsh-auth-proxy.js
RUN sed -i 's/\r$//' /usr/local/bin/dsh-entrypoint \
    && chmod 0755 /usr/local/bin/dsh-entrypoint \
    && mkdir -p /data/dsh /workspace

WORKDIR /workspace
EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/dsh-entrypoint"]
