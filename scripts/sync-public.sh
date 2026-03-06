#!/bin/bash
set -e

git checkout public
git checkout main -- \
  src/ .claude/ scripts/ \
  package.json bun.lock tsconfig.json knip.json \
  .env.example .gitignore CLAUDE.md DEVELOPMENT.md README.md \
  agent-data/persona.md
git add -A
# Never stage personal runtime data (except persona.md which we explicitly checked out)
git reset HEAD agent-data/ 2>/dev/null || true
git add agent-data/persona.md
git diff --cached --stat
echo ""
echo "Review staged changes, then: git commit -m 'Sync framework from main'"
