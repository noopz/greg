#!/bin/bash
#
# sync-public.sh — Sync framework code to the public greg repo.
#
# ARCHITECTURE:
#   disclaude (private, github.com/noopz/durandal)
#     Contains everything: framework source, personal skills, agent-data,
#     persona, learned-patterns, local/ plugins, etc.
#
#   greg (public, github.com/noopz/greg)
#     Contains ONLY the reusable framework — no personal content.
#     Lives at ~/projects/greg/ as a separate checkout.
#
# HOW IT WORKS:
#   1. Deletes allowlisted directories in greg/ to handle file removals
#   2. Copies fresh versions from disclaude/ → greg/
#   3. Commits and pushes to greg's main branch
#
# WHAT GETS SYNCED (allowlist):
#   - src/           — all framework source code
#   - .claude/       — framework skills and agents
#   - scripts/       — utility scripts (including this one)
#   - Config files   — package.json, bun.lock, tsconfig, knip, etc.
#   - Docs           — CLAUDE.md, DEVELOPMENT.md, README.md, .env.example
#
# WHAT NEVER SYNCS:
#   - local/         — personal skills, plugins, config, docs
#   - agent-data/    — persona, learned-patterns, memories, transcripts
#   - .env           — secrets and tokens
#
# SAFE TO RUN AT ANY TIME:
#   No branch switching. No stashing. Just a file copy into a separate repo.
#   Greg can be running, agent-data can be mid-write — doesn't matter.
#
set -e

GREG_DIR="$HOME/projects/greg"

# --- Allowlist: only these paths are copied to greg ---
SYNC_DIRS=(src/ .claude/ scripts/)
SYNC_FILES=(
  package.json
  bun.lock
  tsconfig.json
  knip.json
  .env.example
  .gitignore
  CLAUDE.md
  DEVELOPMENT.md
  README.md
)

# --- Validate ---
if [ ! -d "$GREG_DIR/.git" ]; then
  echo "Error: greg repo not found at $GREG_DIR"
  echo "Clone it: git clone git@github.com:noopz/greg.git $GREG_DIR"
  exit 1
fi

# --- Sync directories (delete + copy for clean removal tracking) ---
for dir in "${SYNC_DIRS[@]}"; do
  rm -rf "$GREG_DIR/$dir"
  cp -r "$dir" "$GREG_DIR/$dir"
done

# --- Sync individual files ---
for file in "${SYNC_FILES[@]}"; do
  cp "$file" "$GREG_DIR/$file"
done

# --- Commit and push ---
cd "$GREG_DIR"
git add -A

if git diff --cached --quiet; then
  echo "Nothing to sync — greg is already up to date."
  exit 0
fi

echo "=== Changes ==="
git diff --cached --stat
echo ""
git commit -m "Sync framework from main"
git push
echo "Synced to greg."
