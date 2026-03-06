#!/bin/bash
set -e

git checkout public
git checkout main -- \
  src/ .claude/ scripts/ \
  package.json bun.lock tsconfig.json knip.json \
  .env.example .gitignore CLAUDE.md DEVELOPMENT.md
git add -A
# Never stage personal runtime data
git reset HEAD agent-data/ 2>/dev/null || true
git diff --cached --stat
echo ""
echo "Review staged changes, then: git commit -m 'Sync framework from main'"
