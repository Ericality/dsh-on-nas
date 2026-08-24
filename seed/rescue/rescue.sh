#!/bin/sh
# ============================================================
# dsh 救急回滚脚本 (rescue.sh)
# 用途: 当 dsh web 因 patch/settings/preset 改动导致启动失败时,
#       把相关配置一键恢复到"出厂安全状态", 让容器能重新启动。
# 放在持久卷 /data/dsh/rescue/ 下, 容器重建也不会丢。
#
# 用法:
#   sh /data/dsh/rescue/rescue.sh          # 执行回滚(先备份现场)
#   DRY_RUN=1 sh /data/dsh/rescue/rescue.sh  # 只打印将要做什么, 不实际改动
# ============================================================
set -u

RESCUE_DIR="/data/dsh/rescue"
PROFILE_DIR="/data/dsh/profiles/web"
HOME_DIR="/data/dsh"
TS=$(date +%Y%m%d-%H%M%S)
DRY="${DRY_RUN:-0}"

say() { printf '[rescue] %s\n' "$*"; }
run() {
  if [ "$DRY" = "1" ]; then say "DRY: $*"; return 0; fi
  "$@" || say "WARN: command failed (non-fatal): $*"
}

# 回滚前把当前现场备份到 backup/crash-<ts>/, 方便事后排查
if [ "$DRY" != "1" ]; then
  mkdir -p "$RESCUE_DIR/backup/crash-$TS"
  for f in "$PROFILE_DIR/cordis.patch.yml" "$HOME_DIR/settings.yaml"; do
    [ -f "$f" ] && cp "$f" "$RESCUE_DIR/backup/crash-$TS/" 2>/dev/null
  done
  [ -d "$HOME_DIR/.agent-presets/standard-fetch" ] && \
    cp -r "$HOME_DIR/.agent-presets/standard-fetch" "$RESCUE_DIR/backup/crash-$TS/" 2>/dev/null
  say "现场已备份到 $RESCUE_DIR/backup/crash-$TS/"
fi

# 1) 主开关: profile patch 恢复为空层 (dsh 启动失败的 90% 原因)
say "步骤1: 重置 profile patch -> []"
run cp "$RESCUE_DIR/cordis.patch.yml.safe" "$PROFILE_DIR/cordis.patch.yml"

# 2) settings.yaml 去掉 agent-presets 默认预设覆盖
say "步骤2: 重置 settings.yaml -> 仅 permission 块"
run cp "$RESCUE_DIR/settings.yaml.safe" "$HOME_DIR/settings.yaml"

# 3) 移除自定义 preset (standard-fetch), 彻底回到出厂预设
say "步骤3: 移除 $HOME_DIR/.agent-presets/standard-fetch"
if [ "$DRY" = "1" ]; then
  say "DRY: rm -rf $HOME_DIR/.agent-presets/standard-fetch"
else
  rm -rf "$HOME_DIR/.agent-presets/standard-fetch"
fi

# 4) 移除手工安装的插件包与符号链接 (web-fetch-http + fileserve)
say "步骤4: 移除手工安装的插件 (dsh-web-fetch-http + dsh-fileserve)"
if [ "$DRY" = "1" ]; then
  say "DRY: rm -rf $PROFILE_DIR/node_modules/@deepseek-ai/dsh-web-fetch-http"
  say "DRY: rm -f $HOME_DIR/profiles/node_modules/@deepseek-ai/dsh-web-fetch-http"
  say "DRY: rm -rf $PROFILE_DIR/node_modules/@deepseek-ai/dsh-fileserve"
  say "DRY: rm -rf $PROFILE_DIR/node_modules/@deepseek-ai/dsh-balance"
  say "DRY: rm -rf $PROFILE_DIR/node_modules/@deepseek-ai/dsh-pwa"
  say "DRY: rm -rf $PROFILE_DIR/node_modules/@deepseek-ai/dsh-notify"
else
  rm -rf "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-web-fetch-http"
  rm -f "$HOME_DIR/profiles/node_modules/@deepseek-ai/dsh-web-fetch-http"
  rm -rf "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-fileserve"
  rm -rf "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-balance"
  rm -rf "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-pwa"
  rm -rf "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-notify"
fi

say "完成。现在可以重新启动容器: 请用你的部署方式重启 dsh web 服务。"
say "想恢复 web_fetch 功能时: cp $RESCUE_DIR/backup-good/cordis.patch.yml.good $PROFILE_DIR/cordis.patch.yml"
say "                           cp $RESCUE_DIR/backup-good/settings.yaml.good $HOME_DIR/settings.yaml"
