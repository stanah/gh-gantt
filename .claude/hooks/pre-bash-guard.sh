#!/usr/bin/env bash
# PreToolUse hook: git commit / git push の実行前にブランチ状態を検査してブロックする
# (ADR-010 L2 / #310)。
# Claude Code の matcher はツール名にしか効かないため、対象コマンドの判定は
# 本スクリプトが stdin の tool_input.command で行う。
set -u

input=$(cat 2>/dev/null || true)
command -v python3 >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

kind=$(printf '%s' "$input" | python3 -c '
import json, re, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("")
    sys.exit(0)
cmd = (data.get("tool_input") or {}).get("command", "")
# コマンドの先頭または連結 (; & | 改行) の直後に現れるものだけを対象にする
if re.search(r"(?:^|[;&|\n])\s*(?:command\s+)?git\s+commit\b", cmd):
    print("COMMIT")
elif re.search(r"(?:^|[;&|\n])\s*(?:command\s+)?git\s+push\b", cmd):
    print("PUSH")
else:
    print("")
' 2>/dev/null || true)
[ -z "$kind" ] && exit 0

branch=$(git branch --show-current 2>/dev/null || true)
[ -z "$branch" ] && exit 0

if [ "$kind" = "COMMIT" ] && { [ "$branch" = "main" ] || [ "$branch" = "master" ]; }; then
  echo "⚠ main ブランチへの直接コミットは禁止です。feature ブランチを作成してください。" >&2
  exit 2
fi

# マージ済みブランチへの誤コミット / 誤 push を検出する (gh 不在時は fail-open)。
# fork 由来の同名ブランチ PR を拾わないよう、head リポジトリの owner で絞り込む。
# 絞り込みはテストで実挙動を検証できるよう gh の --jq ではなく python3 で行う
if command -v gh >/dev/null 2>&1; then
  repo_owner=$(gh repo view --json owner --jq '.owner.login' 2>/dev/null || true)
  if [ -n "$repo_owner" ]; then
    merged=$(gh pr list --head "$branch" --state merged --json number,headRepositoryOwner \
      2>/dev/null | python3 -c '
import json, sys
owner = sys.argv[1]
try:
    prs = json.load(sys.stdin)
except Exception:
    prs = []
hits = [p["number"] for p in prs if (p.get("headRepositoryOwner") or {}).get("login") == owner]
print(hits[0] if hits else "")
' "$repo_owner" 2>/dev/null || true)
    if [ -n "$merged" ]; then
      echo "⚠ このブランチの PR #$merged は既にマージ済みです。main に戻って新しいブランチを作成してください。" >&2
      exit 2
    fi
  fi
fi

exit 0
