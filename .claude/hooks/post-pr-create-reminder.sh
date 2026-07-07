#!/usr/bin/env bash
# PostToolUse hook: gh pr create の実行後に「PR 作成は完了ではない」リマインダーを
# エージェントに注入する (ADR-010 L2 / #307)。
# Claude Code の matcher はツール名にしか効かないため、対象コマンドの判定は
# 本スクリプトが stdin の tool_input.command で行う。
set -u

input=$(cat 2>/dev/null || true)
command -v python3 >/dev/null 2>&1 || exit 0

matched=$(printf '%s' "$input" | python3 -c '
import json, re, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("")
    sys.exit(0)
cmd = (data.get("tool_input") or {}).get("command", "")
# コマンドの先頭または連結 (; & |) の直後に現れる gh pr create のみを対象にする。
# echo 等の引数に文字列として現れるだけのコマンドで誤発火させない
print("MATCH" if re.search(r"(?:^|[;&|\n])\s*(?:command\s+)?gh\s+pr\s+create\b", cmd) else "")
' 2>/dev/null || true)

case "$matched" in
  MATCH)
    {
      echo "⚠ PR 作成は完了ではなく、レビュー監視の開始です (gh-gantt-workflow 手順14-16)。次を必ず実施すること:"
      echo "  1. skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --current-branch で CI と非同期レビューの安定を待つ"
      echo "  2. 指摘は精査して同じ PR に追加コミットで対応し、pending review で返信・対応済み thread を resolve する"
      echo "  3. 完了報告の前に同スクリプトを --all-open で実行する"
    } >&2
    exit 2
    ;;
esac

exit 0
