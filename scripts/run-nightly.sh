#!/bin/bash
# 每晚回归：CLI + 全部 suite + JUnit + 日志。
export PATH="$(dirname "$(command -v cua-driver)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs/dsh-record-replay"
mkdir -p "$LOG_DIR"
cd "$REPO" || exit 2
NODE="$(command -v node)"
"$NODE" dist/cli.mjs test tests/suites/all.json --launch isolated \
  --junit "$LOG_DIR/latest.xml" >> "$LOG_DIR/nightly.log" 2>&1
status=$?
echo "EXIT:$status $(date '+%F %T')" >> "$LOG_DIR/nightly.log"
if [ "$status" -ne 0 ]; then
  osascript -e 'display notification "Nightly replay failed; see ~/Library/Logs/dsh-record-replay" with title "dsh-record-replay"'
fi
exit "$status"
