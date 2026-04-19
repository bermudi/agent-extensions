#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME=$(node -p "require('./package.json').name")
PACKAGE_VERSION=$(node -p "require('./package.json').version")

echo "📦 Preparing publish for ${PACKAGE_NAME}@${PACKAGE_VERSION}"

if ! npm whoami >/dev/null 2>&1; then
  echo "❌ Not logged in to npm. Run: npm login"
  exit 1
fi

# Ensure no uncommitted changes so the published state is reproducible
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ Working tree is dirty. Commit or stash changes first."
  git status --short
  exit 1
fi

echo "🔍 Checking npm tarball contents..."
npm pack --dry-run >/dev/null

echo "🚀 Publishing to npm..."
npm publish

echo "✅ Published ${PACKAGE_NAME}@${PACKAGE_VERSION}"
echo "Install with: pi install npm:${PACKAGE_NAME}"
