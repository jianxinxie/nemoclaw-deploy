#!/usr/bin/env bash
set -Eeuo pipefail

# Standalone entrypoint; bundled IEMS copies set BUNDLE_PLATFORM=linux-x64.
BUNDLE_PLATFORM=any
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
NODE_VERSION="${NODE_VERSION:-24}"
REQUIRED_NODE_VERSION="${REQUIRED_NODE_VERSION:-22.19.0}"
MIN_DEPLOY_CLI_VERSION="0.0.9"
NVM_VERSION="${NVM_VERSION:-v0.40.3}"
PACKAGE_NAME="${PACKAGE_NAME:-@advantech-axa/nemoclaw-deploy}"
PACKAGE_VERSION="${PACKAGE_VERSION:-0.0.9}"
PACKAGE_SPEC="${PACKAGE_SPEC:-}"
PACKAGE_SHA256="${PACKAGE_SHA256:-}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
NPM_PREFIX="${NPM_PREFIX:-$SCRIPT_DIR/.nemoclaw-deploy/npm-global}"
NPM_OFFLINE="${NPM_OFFLINE:-0}"
FORCE_CLI_INSTALL="${FORCE_CLI_INSTALL:-0}"
CONFIG="${CONFIG:-$SCRIPT_DIR/onboard.yaml}"
DRY_RUN=0
PREPARE_ONLY=0
DEPLOY_CLI=''
BUNDLED_SHA256=''
TEMP_INSTALLER=''
STAGED_PREFIX=''
PHASE='参数检查'
UP_ARGS=()

log() { printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf '\n错误: %s\n' "$*" >&2; exit 1; }
have_command() { command -v "$1" >/dev/null 2>&1; }
is_true() { case "${1,,}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }

usage() {
  cat <<'HELP'
用法: bash install.sh [--config <file>] [--non-interactive] [--dry-run] [--prepare-only]

  --config <file>    指定统一 onboard.yaml（相对路径基于安装目录）
  --non-interactive 禁用交互
  --dry-run         校验并预览，不安装或修改状态
  --prepare-only    只准备 Node.js/CLI 并校验部署计划，不安装 NemoClaw 或创建 sandbox
  --help, -h        显示此帮助，不准备环境

环境变量: NODE_VERSION, NVM_NODEJS_ORG_MIRROR, HTTPS_PROXY, NPM_REGISTRY,
          NPM_PREFIX, NPM_OFFLINE=1, FORCE_CLI_INSTALL=1, PACKAGE_SPEC,
          PACKAGE_SHA256
HELP
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h) usage; exit 0 ;;
      --config)
        [ "$#" -ge 2 ] && [ -n "$2" ] && [[ "$2" != --* ]] || die '--config 需要文件路径。'
        CONFIG="$2"; shift 2 ;;
      --config=*) CONFIG="${1#*=}"; [ -n "$CONFIG" ] || die '--config 需要文件路径。'; shift ;;
      --dry-run) DRY_RUN=1; UP_ARGS+=("$1"); shift ;;
      --prepare-only) PREPARE_ONLY=1; shift ;;
      --non-interactive) UP_ARGS+=("$1"); shift ;;
      *) die "不支持的参数: $1（使用 --help 查看用法）。" ;;
    esac
  done
}

cleanup() {
  local status=$?
  [ -z "$TEMP_INSTALLER" ] || rm -f -- "$TEMP_INSTALLER" || true
  # Once publication starts, this verified release may already be selected.
  if [ -n "$STAGED_PREFIX" ] && [ ! -f "$STAGED_PREFIX/.ready" ]; then
    rm -rf -- "$STAGED_PREFIX" || true
  fi
  if [ "$status" -ne 0 ]; then
    printf '\n安装未完成：阶段=%s，exitCode=%s。修复上方错误后可重新运行相同命令。\n' "$PHASE" "$status" >&2
  fi
}

sha256_file() {
  if have_command sha256sum; then sha256sum -- "$1" | cut -d ' ' -f 1
  elif have_command shasum; then shasum -a 256 -- "$1" | cut -d ' ' -f 1
  else die '校验安装包需要 sha256sum 或 shasum。'; fi
}

preflight() {
  [ "${BASH_VERSINFO[0]}" -ge 4 ] || die '需要 Bash >=4，请使用 bash install.sh。'
  [ -f "$CONFIG" ] && [ -r "$CONFIG" ] && [ -s "$CONFIG" ] || die "配置文件不存在、不可读或为空: $CONFIG"
  [[ "$NODE_VERSION" =~ ^v?[0-9]+(\.[0-9]+){0,2}$ ]] || die 'NODE_VERSION 必须是版本号，例如 24 或 24.22.1。'
  [[ "$REQUIRED_NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'REQUIRED_NODE_VERSION 必须是完整版本号。'
  [[ "$NVM_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'NVM_VERSION 必须是 vX.Y.Z。'
  [[ "$PACKAGE_NAME" =~ ^(@[a-z0-9._-]+/)?[a-z0-9._-]+$ ]] || die 'PACKAGE_NAME 不是有效的 npm 包名称。'
  [[ "$PACKAGE_SPEC" != -* ]] || die 'PACKAGE_SPEC 不能以选项前缀 - 开头。'
  [[ "$NPM_PREFIX" = /* ]] || NPM_PREFIX="$SCRIPT_DIR/$NPM_PREFIX"
  if [ "$BUNDLE_PLATFORM" = linux-x64 ]; then
    [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die 'IEMS 包含 Linux x86-64 业务程序，只支持 Linux x86-64 主机。'
  fi
  if [ -z "$PACKAGE_SPEC" ] && [ "$PACKAGE_NAME" = '@advantech-axa/nemoclaw-deploy' ]; then
    local bundled="$SCRIPT_DIR/packages/advantech-axa-nemoclaw-deploy-$PACKAGE_VERSION.tgz"
    if [ -f "$bundled" ]; then
      local manifest="$SCRIPT_DIR/packages/SHA256SUMS" expected
      [ -r "$manifest" ] || die "随包 CLI 缺少校验清单: $manifest。请重新获取完整安装包。"
      expected="$(awk -v name="$(basename "$bundled")" '$2 == name { print $1 }' "$manifest")"
      [[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || die '随包 CLI 的 SHA256 清单无效。'
      BUNDLED_SHA256="$(sha256_file "$bundled")"
      [ "${BUNDLED_SHA256,,}" = "${expected,,}" ] || die '随包 CLI SHA256 校验失败，请重新获取安装包；不会回退到 npm 或执行损坏内容。'
      PACKAGE_SPEC="$bundled"
    elif [ "$BUNDLE_PLATFORM" = linux-x64 ]; then
      die "IEMS 安装包缺少随包 CLI: $bundled"
    fi
  fi
  if [ -n "$PACKAGE_SHA256" ]; then
    [[ "$PACKAGE_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || die 'PACKAGE_SHA256 必须是 64 位十六进制。'
    [ -f "$PACKAGE_SPEC" ] || die 'PACKAGE_SHA256 仅适用于本地 PACKAGE_SPEC 文件。'
    [ "$(sha256_file "$PACKAGE_SPEC")" = "${PACKAGE_SHA256,,}" ] || die 'PACKAGE_SPEC SHA256 校验失败。'
  fi
  case "$PACKAGE_SPEC" in
    /*|./*|../*|*.tgz) [ -f "$PACKAGE_SPEC" ] && [ -r "$PACKAGE_SPEC" ] && [ -s "$PACKAGE_SPEC" ] || die "本地 PACKAGE_SPEC 不存在、不可读或为空: $PACKAGE_SPEC" ;;
  esac
  if [ -n "$PACKAGE_SPEC" ] && [ -f "$PACKAGE_SPEC" ]; then
    BUNDLED_SHA256="$(sha256_file "$PACKAGE_SPEC")"
  fi
}

acquire_lock() {
  [ "$DRY_RUN" = 0 ] || return 0
  have_command flock || die '需要 flock 防止并发安装；Linux 请安装 util-linux。'
  mkdir -p -- "$NPM_PREFIX"
  exec 9>"$NPM_PREFIX/.install.lock"
  flock -n 9 || die "另一个安装或部署进程正在使用 $NPM_PREFIX，请等待其完成。"
}

node_is_usable() {
  have_command node || return 1
  node -e '
    if (process.versions.node.includes("-")) process.exit(1);
    const actual = process.versions.node.split(".").map(Number);
    const required = process.argv[1].split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (actual[i] !== required[i]) process.exit(actual[i] > required[i] ? 0 : 1);
    }
  ' "$REQUIRED_NODE_VERSION"
}

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh" --no-use || return 1
    return 0
  fi
  return 1
}

install_nvm() {
  have_command curl || die '需要 curl 才能安装 Node.js，请先安装 curl。'
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  log "安装 nvm $NVM_VERSION..."
  TEMP_INSTALLER="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-nvm-install.XXXXXX")"
  if ! curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 --retry-max-time 120 \
    --connect-timeout 15 --max-time 120 \
    "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" -o "$TEMP_INSTALLER"; then
    die 'nvm 安装器下载失败，请检查 raw.githubusercontent.com 的网络连接和 HTTPS_PROXY。'
  fi
  [ -s "$TEMP_INSTALLER" ] || die 'nvm 安装器下载结果为空。'
  bash -n "$TEMP_INSTALLER" || die 'nvm 安装器不是有效 Bash 脚本，可能收到了代理错误页。'
  # nvm also reads NODE_VERSION; install Node explicitly below.
  NODE_VERSION= bash "$TEMP_INSTALLER"
  rm -f -- "$TEMP_INSTALLER"
  TEMP_INSTALLER=''
  load_nvm || die "nvm 安装完成但无法加载 $NVM_DIR/nvm.sh"
}

use_installed_node() {
  local candidate
  for candidate in "$NODE_VERSION" default node; do
    if nvm use --silent "$candidate" >/dev/null 2>&1 && node_is_usable; then return 0; fi
  done
  return 1
}

report_node() {
  have_command npm || die '已找到 Node.js，但 npm 不可用。'
  if [ "$DRY_RUN" = 0 ]; then
    npm --version >/dev/null 2>&1 || die 'npm 无法运行，请修复当前 Node.js/npm 安装。'
  fi
  log "Node.js 已满足要求: $(node -v)"
}

ensure_node() {
  if node_is_usable; then report_node; return; fi
  if load_nvm; then
    if use_installed_node; then report_node; return; fi
  else
    [ "$DRY_RUN" = 0 ] || die "dry-run 需要预先安装 Node.js >= $REQUIRED_NODE_VERSION；不会执行安装。"
    install_nvm
    if use_installed_node; then report_node; return; fi
  fi
  [ "$DRY_RUN" = 0 ] || die "dry-run 需要预先安装 Node.js >= $REQUIRED_NODE_VERSION；不会执行安装。"
  log "安装/切换 Node.js $NODE_VERSION..."
  if ! nvm install "$NODE_VERSION"; then
    die "无法安装 Node.js $NODE_VERSION。Version not found 也可能表示版本索引下载失败；请检查 ${NVM_NODEJS_ORG_MIRROR:-https://nodejs.org/dist}、HTTPS_PROXY，或设置可访问的 NVM_NODEJS_ORG_MIRROR 后重试。可用 NODE_VERSION 指定版本。"
  fi
  nvm use "$NODE_VERSION" || die "Node.js 已下载，但切换到 $NODE_VERSION 失败。"
  hash -r
  node_is_usable || die "Node.js 版本仍不满足要求，需要 >= $REQUIRED_NODE_VERSION。"
  report_node
}

deploy_cli_is_usable() {
  local version
  version="$("$1" --version 2>/dev/null)" || return 1
  node -e '
    const match = process.argv[1].trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    if (!match) process.exit(1);
    const actual = match.slice(1).map(Number);
    const required = process.argv[2].split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (actual[i] !== required[i]) process.exit(actual[i] > required[i] ? 0 : 1);
    }
  ' "$version" "$MIN_DEPLOY_CLI_VERSION"
}

use_existing_deploy_cli() {
  is_true "$FORCE_CLI_INSTALL" && return 1
  if [ -n "$BUNDLED_SHA256" ]; then
    local bundled_cli="$NPM_PREFIX/releases/$BUNDLED_SHA256/bin/nemoclaw-deploy"
    if [ -x "$bundled_cli" ] && deploy_cli_is_usable "$bundled_cli"; then DEPLOY_CLI="$bundled_cli"; return 0; fi
    return 1
  fi
  # An explicit remote package spec must not silently reuse an unrelated CLI.
  [ -z "$PACKAGE_SPEC" ] || return 1
  local prefix_cli="$NPM_PREFIX/bin/nemoclaw-deploy"
  if [ -x "$prefix_cli" ] && deploy_cli_is_usable "$prefix_cli"; then DEPLOY_CLI="$prefix_cli"; return 0; fi
  if have_command nemoclaw-deploy && deploy_cli_is_usable "$(command -v nemoclaw-deploy)"; then
    DEPLOY_CLI="$(command -v nemoclaw-deploy)"; return 0
  fi
  return 1
}

publish_cli() {
  # rename replaces symlinks atomically, including links pointing at directories.
  node -e '
    const fs = require("node:fs"), path = require("node:path");
    const [prefix, release, hash] = process.argv.slice(1);
    fs.writeFileSync(path.join(release, ".ready"), "verified\n");
    const links = [[path.join(prefix, "bin/nemoclaw-deploy"), path.join(release, "bin/nemoclaw-deploy")]];
    if (hash) links.push([path.join(prefix, "releases", hash), release]);
    for (const [dest, target] of links) {
      fs.mkdirSync(path.dirname(dest), {recursive:true});
      const temp = dest + ".new-" + process.pid;
      try { fs.symlinkSync(target, temp); fs.renameSync(temp, dest); }
      finally { fs.rmSync(temp, {force:true}); }
    }
  ' "$NPM_PREFIX" "$STAGED_PREFIX" "$BUNDLED_SHA256"
}

ensure_deploy_cli() {
  if use_existing_deploy_cli; then
    log "复用已验证的 nemoclaw-deploy: $DEPLOY_CLI"
    return
  fi
  [ "$DRY_RUN" = 0 ] || die "dry-run 需要预先安装 nemoclaw-deploy >= $MIN_DEPLOY_CLI_VERSION（IEMS 需要与随包 SHA256 匹配）；不会执行 npm 安装。"
  local package_spec="$PACKAGE_NAME" status=0
  [ -z "$PACKAGE_VERSION" ] || package_spec="$PACKAGE_NAME@$PACKAGE_VERSION"
  [ -z "$PACKAGE_SPEC" ] || package_spec="$PACKAGE_SPEC"
  STAGED_PREFIX="$(mktemp -d "$NPM_PREFIX/.release.XXXXXX")"
  local npm_args=(install -g --prefix "$STAGED_PREFIX" "$package_spec" --registry "$NPM_REGISTRY"
    --fetch-retries=3 --fetch-timeout=120000 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=15000 --no-audit --no-fund)
  if is_true "$NPM_OFFLINE"; then npm_args+=(--offline); fi
  log "准备 CLI 到独立目录；验证成功后才切换..."
  npm "${npm_args[@]}" || status=$?
  [ "$status" = 0 ] || die "npm 安装失败 (exitCode: $status)，现有 CLI 保持可用；检查 registry、代理或 npm 缓存后重试。"
  DEPLOY_CLI="$STAGED_PREFIX/bin/nemoclaw-deploy"
  [ -x "$DEPLOY_CLI" ] && deploy_cli_is_usable "$DEPLOY_CLI" || die '新 CLI 版本检查失败，不会替换现有 CLI。'
  publish_cli
  STAGED_PREFIX=''
  log "nemoclaw-deploy 已验证并切换: $DEPLOY_CLI"
}

main() {
  parse_args "$@"
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  preflight
  acquire_lock
  PHASE='Node.js/npm 准备'; ensure_node
  PHASE='CLI 安装或复用'; ensure_deploy_cli
  export PATH="$(dirname "$DEPLOY_CLI"):$PATH"
  if [ "$PREPARE_ONLY" = 1 ] && [ "$DRY_RUN" = 0 ]; then UP_ARGS+=(--dry-run); fi
  PHASE='配置校验和 NemoClaw 部署'
  log '开始执行 nemoclaw-deploy up...'
  "$DEPLOY_CLI" up --config "$CONFIG" "${UP_ARGS[@]}"
}

main "$@"
