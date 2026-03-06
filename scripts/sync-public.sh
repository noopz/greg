#!/bin/bash
# Sync framework code from disclaude → greg (separate repo).
# Uses an explicit allowlist — ONLY listed paths are copied.
# Handles additions, modifications, AND deletions.
set -e

GREG_DIR="$HOME/projects/greg"

# --- Allowlist ---
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

# --- Sync directories (delete + copy for clean state) ---
for dir in "${SYNC_DIRS[@]}"; do
  rm -rf "$GREG_DIR/$dir"
  cp -r "$dir" "$GREG_DIR/$dir"
done

# --- Sync individual files ---
for file in "${SYNC_FILES[@]}"; do
  cp "$file" "$GREG_DIR/$file"
done

# --- Show results ---
cd "$GREG_DIR"
echo "=== Changes in greg repo ==="
git add -A
git diff --cached --stat

CHANGED=$(git diff --cached --quiet && echo "no" || echo "yes")
if [ "$CHANGED" = "no" ]; then
  echo ""
  echo "Nothing to sync — greg is already up to date."
  exit 0
fi

echo ""
read -p "Commit and push? [y/N] " CONFIRM
if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
  git commit -m "Sync framework from main"
  git push
  echo "Done."
else
  git reset HEAD . -q
  echo "Aborted. Changes left unstaged in $GREG_DIR."
fi
