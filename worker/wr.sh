#!/usr/bin/env bash
# wrangler 包装脚本：把所有状态都钉在 D 盘。
#
# 为什么需要它：wrangler 默认把登录凭据写到 %USERPROFILE%\.config\.wrangler，
# 也就是 C 盘。C 盘只剩 3.4G，而且这台机器的约定是尽量装 D 盘。
# 用 XDG_CONFIG_HOME 改配置目录，WRANGLER_LOG_PATH 改日志目录。
#
# 用法：./wr.sh login / ./wr.sh d1 create mo-stats / ./wr.sh deploy
set -euo pipefail

export XDG_CONFIG_HOME=/d/local_translate_tool/wrangler_home
export WRANGLER_LOG_PATH=/d/local_translate_tool/wrangler_home/logs
mkdir -p "$XDG_CONFIG_HOME" "$WRANGLER_LOG_PATH"

exec wrangler "$@"
