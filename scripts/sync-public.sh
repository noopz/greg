#!/bin/bash
# Sync framework code from main → public branch for the greg repo.
# Uses an explicit allowlist — ONLY these paths are staged on public.
# Handles additions, modifications, AND deletions within allowlisted paths.
set -e

# --- Allowlist: only these paths get synced to public ---
# Directories (trailing /) are fully synced — files removed from main
# will also be removed from public.
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

# --- Safety: must be on main ---
CURRENT=$(git branch --show-current)
if [ "$CURRENT" != "main" ]; then
  echo "Error: must be on main branch (currently on $CURRENT)"
  exit 1
fi

# --- Safety: no uncommitted changes in tracked files ---
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: you have uncommitted changes. Commit or stash first."
  echo ""
  git status --short
  exit 1
fi

# --- Switch to public and sync ---
# Stash untracked files that might conflict with the public branch
# (e.g., agent-data/persona.md is tracked on public but gitignored on main)
git stash push --include-untracked -m "sync-public: temp stash" -q
STASHED=true
trap 'if [ "$STASHED" = true ]; then git checkout main -q 2>/dev/null; git stash pop -q 2>/dev/null; fi' EXIT

git checkout public

# For directories: remove the old version entirely, then bring in fresh from main.
# This ensures files deleted on main are also deleted on public.
for dir in "${SYNC_DIRS[@]}"; do
  rm -rf "$dir"
done
git checkout main -- "${SYNC_DIRS[@]}" "${SYNC_FILES[@]}"

# Stage ONLY the allowlisted paths (not git add -A which could leak files)
git add -- "${SYNC_DIRS[@]}" "${SYNC_FILES[@]}"

# Show what will be committed
echo ""
echo "=== Changes staged for public ==="
git diff --cached --stat

CHANGED=$(git diff --cached --quiet && echo "no" || echo "yes")
if [ "$CHANGED" = "no" ]; then
  echo ""
  echo "Nothing to sync — public is already up to date."
  git checkout main -q
  STASHED=false
  git stash pop -q 2>/dev/null || true
  echo "Back on main."
  exit 0
fi

echo ""
read -p "Commit and push to public? [y/N] " CONFIRM
if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
  git commit -m "Sync framework from main"
  git push public public
  echo "Pushed to public."
else
  echo "Aborted. You're on the public branch — run 'git checkout main' to go back."
  STASHED=false
  exit 0
fi

git checkout main -q
STASHED=false
git stash pop -q 2>/dev/null || true
echo "Back on main."
