#!/usr/bin/env bash
# ddns 一键验证：从干净状态（无 node_modules / 无 dist）直接跑，
# 依次完成环境检查 → 依赖安装 → typecheck → 全量测试 → build。
# 全部通过退出 0；任一步失败立即退出非 0。
#
#   bash scripts/test.sh     （或 npm run verify）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/5] 环境检查"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: Node >= 22.18 required（测试直接运行 .ts，依赖 Node 内置类型剥离）" >&2
  exit 1
fi
echo "    node $(node -v) ok"

echo "==> [2/5] 依赖安装（缺 node_modules 才装；typecheck/build 需要 typescript）"
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
else
  echo "    node_modules 已存在，跳过"
fi

echo "==> [3/5] typecheck（tsc --noEmit）"
npm run typecheck

echo "==> [4/5] 全量测试（node --test，$(ls test/*.test.mjs | wc -l | tr -d ' ') 个文件）"
npm test

echo "==> [5/5] build（tsc → dist/）"
npm run build

echo
echo "ALL GREEN ✓  —  typecheck / $(ls test/*.test.mjs | wc -l | tr -d ' ') 个测试文件 / build 全部通过"
