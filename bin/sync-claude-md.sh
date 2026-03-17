#!/bin/bash
# Sync CLAUDE.md from feishu_main to all other feishu groups
SRC="$(dirname "$0")/../groups/feishu_main/CLAUDE.md"
if [ ! -f "$SRC" ]; then
  echo "Source not found: $SRC"
  exit 1
fi

count=0
for dir in "$(dirname "$0")/../groups"/feishu_*/; do
  [ "$(basename "$dir")" = "feishu_main" ] && continue
  cp "$SRC" "$dir/CLAUDE.md"
  echo "Synced → $(basename "$dir")"
  count=$((count + 1))
done
echo "Done. Synced to $count groups."
