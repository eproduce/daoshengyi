#!/usr/bin/env bash
# 本地复现 CI 的**全部**门禁。CI 才是权威清单 —— 曾经因为本地只跑其中 5 项、
# 漏了 ESLint / Prettier / rustfmt，导致 CI 连续红了 40 次都没人发现
# （本地 node_modules 还缺 eslint/prettier 二进制，连跑都跑不起来）。
#
# 用法：bash scripts/ci-local.sh        （或 npm run ci:local）
# 前置：npm ci（保证 eslint/prettier 就位）；Rust 版本由 rust-toolchain.toml 固定

set -uo pipefail
cd "$(dirname "$0")/.."

FAILED=()
step() {
  local name="$1"
  shift
  printf '\n\033[1m=== %s ===\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m✔ %s\033[0m\n' "$name"
  else
    printf '\033[31m✘ %s 失败\033[0m\n' "$name"
    FAILED+=("$name")
  fi
}

step "1/7 vitest" npm test
step "2/7 eslint" npm run lint
step "3/7 prettier" npm run format:check
step "4/7 vue-tsc + vite build" npm run build
step "5/7 rustfmt" bash -c 'cd src-tauri && cargo fmt --check'
step "6/7 clippy (-D warnings)" bash -c 'cd src-tauri && cargo clippy --all-targets -- -D warnings'
step "7/7 cargo test" bash -c 'cd src-tauri && cargo test --lib'

printf '\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '\033[32m全部 7 项门禁通过 ✔\033[0m\n'
  exit 0
fi
printf '\033[31m有 %d 项失败：%s\033[0m\n' "${#FAILED[@]}" "${FAILED[*]}"
exit 1
