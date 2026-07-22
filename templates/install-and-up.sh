#!/usr/bin/env bash
set -Eeuo pipefail

# This script is meant to live in the same directory as the unified onboard.yaml.
# It prepares Node.js, installs nemoclaw-deploy, then runs the full up flow.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NODE_VERSION="${NODE_VERSION:-20}"
REQUIRED_NODE_MAJOR="${REQUIRED_NODE_MAJOR:-20}"
NVM_VERSION="${NVM_VERSION:-v0.40.3}"

PACKAGE_NAME="${PACKAGE_NAME:-@advantech-axa/nemoclaw-deploy}"
PACKAGE_VERSION="${PACKAGE_VERSION:-}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
NPM_PREFIX="${NPM_PREFIX:-$SCRIPT_DIR/.nemoclaw-deploy/npm-global}"
# 默认优先复用本地 CLI；设为 1/true/yes/on 才强制重新安装。
FORCE_CLI_INSTALL="${FORCE_CLI_INSTALL:-0}"

CONFIG="${CONFIG:-$SCRIPT_DIR/onboard.yaml}"

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

die() {
  printf '\n错误: %s\n' "$*" >&2
  exit 1
}

have_command() {
  command -v "$1" >/dev/null 2>&1
}

node_is_usable() {
  have_command node || return 1
  REQUIRED_NODE_MAJOR="$REQUIRED_NODE_MAJOR" \
    node -e "process.exit(Number(process.versions.node.split('.')[0]) >= Number(process.env.REQUIRED_NODE_MAJOR) ? 0 : 1)"
}

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    return 0
  fi
  return 1
}

install_nvm() {
  have_command curl || die "需要 curl 才能安装 Node.js，请先安装 curl。"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  log "未找到可用 Node.js，安装 nvm $NVM_VERSION..."
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
  load_nvm || die "nvm 安装完成但无法加载 $NVM_DIR/nvm.sh"
}

ensure_node() {
  if node_is_usable; then
    log "Node.js 已满足要求: $(node -v)"
    return
  fi

  if ! load_nvm; then
    install_nvm
  fi

  log "安装/切换 Node.js $NODE_VERSION..."
  nvm install "$NODE_VERSION"
  nvm use "$NODE_VERSION"
  hash -r

  node_is_usable || die "Node.js 版本仍不满足要求，需要 >= $REQUIRED_NODE_MAJOR，当前: $(node -v 2>/dev/null || echo missing)"
  have_command npm || die "已找到 Node.js，但 npm 不可用。"
  log "Node.js 准备完成: $(node -v), npm $(npm -v)"
}

ensure_configs() {
  [ -f "$CONFIG" ] || die "找不到统一 onboard 配置: $CONFIG"
}

force_cli_install_requested() {
  case "${FORCE_CLI_INSTALL,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

use_existing_deploy_cli() {
  force_cli_install_requested && return 1

  if have_command nemoclaw-deploy; then
    log "检测到本地 nemoclaw-deploy，跳过 npm 安装: $(command -v nemoclaw-deploy)"
    return 0
  fi

  local prefix_cli="$NPM_PREFIX/bin/nemoclaw-deploy"
  if [ -x "$prefix_cli" ]; then
    export PATH="$NPM_PREFIX/bin:$PATH"
    log "检测到脚本本地 npm prefix 中的 nemoclaw-deploy，跳过 npm 安装: $prefix_cli"
    return 0
  fi

  return 1
}

ensure_deploy_cli() {
  if use_existing_deploy_cli; then
    log "nemoclaw-deploy 本地版本: $(nemoclaw-deploy --version 2>/dev/null || printf 'unknown')"
    return
  fi

  mkdir -p "$NPM_PREFIX"
  export PATH="$NPM_PREFIX/bin:$PATH"

  local package_spec="$PACKAGE_NAME"
  if [ -n "$PACKAGE_VERSION" ]; then
    package_spec="$PACKAGE_NAME@$PACKAGE_VERSION"
  fi

  log "安装/更新 $package_spec..."
  npm install -g --prefix "$NPM_PREFIX" "$package_spec" --registry "$NPM_REGISTRY"

  have_command nemoclaw-deploy || die "nemoclaw-deploy 安装后仍不可用，请检查 npm prefix: $NPM_PREFIX"
  log "nemoclaw-deploy 已可用: $(command -v nemoclaw-deploy)"
}

run_up() {
  log "开始执行 nemoclaw-deploy up..."
  exec nemoclaw-deploy up \
    --config "$CONFIG" \
    "$@"
}

main() {
  ensure_configs
  ensure_node
  ensure_deploy_cli
  run_up "$@"
}

main "$@"
