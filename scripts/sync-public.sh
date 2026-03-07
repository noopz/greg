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
#   3. Without -m: prints source commits + diff for message generation
#   4. With -m "msg": commits and pushes to greg's main branch
#
# USAGE (two-step, designed for Claude Code as executor):
#   bash scripts/sync-public.sh          # sync files, print context
#   bash scripts/sync-public.sh -m "msg" # commit + push with message
#
# WHAT GETS SYNCED (allowlist):
#   - src/           — all framework source code
#   - .claude/       — framework skills and agents
#   - scripts/       — utility scripts (including this one)
#   - Config files   — package.json, bun.lock, tsconfig, knip, etc.
#   - Docs           — DEVELOPMENT.md, README.md, .env.example
#   NOT synced: CLAUDE.md (contains private workflow instructions)
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

# --- Flags ---
# -m "message"   Commit with this message and push. Without -m, just syncs
#                files, stages, and prints context for message generation.
COMMIT_MSG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m) COMMIT_MSG="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

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

# --- Build commit message from disclaude commits since last sync ---
cd "$GREG_DIR"
git add -A

if git diff --cached --quiet; then
  echo "Nothing to sync — greg is already up to date."
  exit 0
fi

# Find the disclaude commit hash stored in the last greg sync commit
LAST_SYNC_HASH=$(git log -1 --format=%b 2>/dev/null | grep '^Source-Commit:' | head -1 | awk '{print $2}')
DISCLAUDE_DIR="$(cd "$OLDPWD" && pwd)"
CURRENT_HASH=$(git -C "$DISCLAUDE_DIR" rev-parse --short HEAD)

# Collect disclaude commit messages since last sync (skip merge commits)
if [ -n "$LAST_SYNC_HASH" ] && git -C "$DISCLAUDE_DIR" cat-file -t "$LAST_SYNC_HASH" >/dev/null 2>&1; then
  COMMITS=$(git -C "$DISCLAUDE_DIR" log --no-merges --format="- %s" "$LAST_SYNC_HASH"..HEAD -- "${SYNC_DIRS[@]}" "${SYNC_FILES[@]}")
else
  # First sync or hash not found — use last 10 commits
  COMMITS=$(git -C "$DISCLAUDE_DIR" log --no-merges --format="- %s" -10 -- "${SYNC_DIRS[@]}" "${SYNC_FILES[@]}")
fi

DIFF_STAT=$(git diff --cached --stat)

# --- Without -m: print context and exit for message generation ---
if [ -z "$COMMIT_MSG" ]; then
  echo "=== Staged Changes ==="
  echo "$DIFF_STAT"
  echo ""
  echo "=== Source Commits ==="
  echo "${COMMITS:-No commit messages available.}"
  echo ""
  echo "=== Source Hash ==="
  echo "$CURRENT_HASH"
  echo ""
  echo "Files synced and staged. Run again with -m to commit and push."
  exit 0
fi

# --- With -m: commit and push ---
echo "=== Changes ==="
echo "$DIFF_STAT"
echo ""
git commit -m "$COMMIT_MSG"
git push
echo "Synced to greg."
