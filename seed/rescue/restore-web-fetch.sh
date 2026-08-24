#!/bin/sh
# ============================================================
# dsh 恢复脚本 (restore-web-fetch.sh)
# 用途: 在 rescue.sh 回滚之后, 把 web_fetch 功能完整恢复。
# 素材全部来自 /data/dsh/rescue/backup-good/ (救急前备份的可用状态)。
#
# 用法: sh /data/dsh/rescue/restore-web-fetch.sh
# ============================================================
set -u

RESCUE_DIR="/data/dsh/rescue"
BK="$RESCUE_DIR/backup-good"
HOME_DIR="/data/dsh"
PROFILE_DIR="${HOME_DIR}/profiles/web"

say() { printf '[restore] %s\n' "$*"; }
missing() { [ ! -e "$1" ]; }

if missing "$BK/cordis.patch.yml.good" || missing "$BK/settings.yaml.good" || missing "$BK/dsh-web-fetch-http" || missing "$BK/standard-fetch.preset"; then
  say "错误: backup-good 素材不完整, 拒绝执行"
  exit 1
fi

# 1) patch
cp "$BK/cordis.patch.yml.good" "$PROFILE_DIR/cordis.patch.yml"
say "已恢复 cordis.patch.yml"

# 2) settings
cp "$BK/settings.yaml.good" "$HOME_DIR/settings.yaml"
say "已恢复 settings.yaml"

# 3) preset
mkdir -p "$HOME_DIR/.agent-presets"
rm -rf "$HOME_DIR/.agent-presets/standard-fetch"
cp -r "$BK/standard-fetch.preset" "$HOME_DIR/.agent-presets/standard-fetch"
say "已恢复 standard-fetch preset"

# 4) 包本体 (profile node_modules)
mkdir -p "$PROFILE_DIR/node_modules/@deepseek-ai"
rm -rf "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-web-fetch-http"
cp -r "$BK/dsh-web-fetch-http" "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-web-fetch-http"
say "已恢复 dsh-web-fetch-http 包"

# 5) heal 回退层符号链接
rm -f "$HOME_DIR/profiles/node_modules/@deepseek-ai/dsh-web-fetch-http"
ln -sfn "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-web-fetch-http" "$HOME_DIR/profiles/node_modules/@deepseek-ai/dsh-web-fetch-http"
say "已恢复 profiles/node_modules 符号链接"

# 6) fileserve 文件服务插件 (聊天点链接新标签页看产物)
if [ -d "$BK/dsh-fileserve" ]; then
  rm -rf "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-fileserve"
  cp -r "$BK/dsh-fileserve" "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-fileserve"
  say "已恢复 dsh-fileserve 插件"
fi

# 7) balance 余额命令插件
if [ -d "$BK/dsh-balance" ]; then
  rm -rf "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-balance"
  cp -r "$BK/dsh-balance" "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-balance"
  say "已恢复 dsh-balance 插件"
fi

# 8) pwa + notify 插件
for p in dsh-pwa dsh-notify; do
  if [ -d "$BK/$p" ]; then
    rm -rf "$PROFILE_DIR/node_modules/@deepseek-ai/$p"
    cp -r "$BK/$p" "$PROFILE_DIR/node_modules/@deepseek-ai/$p"
    say "已恢复 $p 插件"
  fi
done

say "完成。全部本地插件已恢复, 重启 dsh web 服务生效。"
