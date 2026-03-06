#!/bin/bash
set -e

git checkout public
git checkout main -- \
  src/ .claude/ scripts/ \
  package.json bun.lock tsconfig.json knip.json \
  .env.example .gitignore CLAUDE.md DEVELOPMENT.md
git add -A
git diff --cached --stat
echo ""
echo "Review staged changes, then: git commit -m 'Sync framework from main'"
