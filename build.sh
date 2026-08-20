#!/usr/bin/env bash
# 一键构建 + 自动追 @deepseek-ai/dsh 最新版本
#
# 用法:
#   ./build.sh              # 构建 npm "latest" 版本
#   ./build.sh next         # 构建 npm "next" 版本 (最新尝鲜, 可能不稳)
#   DSH_VERSION=0.1.0-rc.8 ./build.sh          # 指定精确版本
#   NPM_REGISTRY=https://registry.npmmirror.com ./build.sh   # 国内 npm 镜像
set -euo pipefail
cd "$(dirname "$0")"

DSH_TAG="${1:-latest}"
DSH_VERSION="${DSH_VERSION:-}"
NPM_REGISTRY="${NPM_REGISTRY:-}"

if [ -z "$DSH_VERSION" ]; then
  echo ">> 查询 npm 上 @deepseek-ai/dsh 的 '$DSH_TAG' 版本 ..."
  DSH_VERSION="$(docker run --rm node:22-alpine npm view "@deepseek-ai/dsh@$DSH_TAG" version 2>/dev/null | tail -1)"
  if [ -z "$DSH_VERSION" ]; then
    echo "!! 版本查询失败 (网络不通或 npm 被墙), 可指定: DSH_VERSION=0.1.0-rc.8 ./build.sh" >&2
    exit 1
  fi
fi

echo ">> 构建 dsh-nas:$DSH_VERSION ..."
docker build \
  --build-arg "DSH_VERSION=$DSH_VERSION" \
  ${NPM_REGISTRY:+--build-arg "NPM_REGISTRY=$NPM_REGISTRY"} \
  -t "dsh-nas:$DSH_VERSION" .

docker tag "dsh-nas:$DSH_VERSION" dsh-nas:latest

echo ">> 完成: dsh-nas:$DSH_VERSION (已同时打上 dsh-nas:latest)"
echo ">> 更新运行中的容器: docker compose up -d --force-recreate"
