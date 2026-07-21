#!/usr/bin/env bash
# Stop hook: 現在ブランチにオープン PR があり、レビューサイクルの未対応項目
# (CHANGES_REQUESTED / 未解決 review thread) が残っている場合に停止をブロックする。
# 「PR 作成 = 完了」と誤認したままセッションを終えることを防ぐ (ADR-010 L2 / #307)。
# hooks が使えない環境の防衛線は ADR-019 の loop complete ゲートが担う。
set -u

# gh / git / python3 がない環境や git リポジトリ外では何もしない (fail-open。
# 強制の本線は環境非依存な CLI 側ゲートに置く)
command -v gh >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# 直前の Stop hook ブロックからの継続中に再ブロックすると無限ループになる。
# 空白や整形の差分に影響されないよう JSON として解釈する
input=$(cat 2>/dev/null || true)
reentry=$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("")
    sys.exit(0)
print("REENTRY" if data.get("stop_hook_active") is True else "")
' 2>/dev/null || true)
[ "$reentry" = "REENTRY" ] && exit 0

branch=$(git branch --show-current 2>/dev/null || true)
[ -z "$branch" ] && exit 0
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  exit 0
fi

repo_owner=$(gh repo view --json owner --jq '.owner.login' 2>/dev/null || true)
repo_name=$(gh repo view --json name --jq '.name' 2>/dev/null || true)
[ -z "$repo_owner" ] || [ -z "$repo_name" ] && exit 0

# fork 由来の同名ブランチ PR を拾わないよう、head リポジトリの owner で絞り込む
pr=$(gh pr list --head "$branch" --state open --json number,headRepositoryOwner \
  --jq "[.[] | select(.headRepositoryOwner.login == \"$repo_owner\")][0].number // empty" \
  2>/dev/null || true)
[ -z "$pr" ] && exit 0

decision=$(gh pr view "$pr" --json reviewDecision --jq '.reviewDecision // ""' 2>/dev/null || true)

# 未解決スレッドは全ページを走査して数える (--paginate。正本 script と同じ方針)
unresolved=$(gh api graphql --paginate \
  -f query='query($o: String!, $n: String!, $pr: Int!, $endCursor: String) { repository(owner: $o, name: $n) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $endCursor) { nodes { isResolved } pageInfo { hasNextPage endCursor } } } } }' \
  -F o="$repo_owner" -F n="$repo_name" -F pr="$pr" \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length' \
  2>/dev/null | awk '{ s += $1 } END { print s + 0 }' || true)

if [ "$decision" = "CHANGES_REQUESTED" ] || { [ -n "$unresolved" ] && [ "$unresolved" -gt 0 ] 2>/dev/null; }; then
  {
    echo "⚠ PR #$pr のレビューサイクルに未対応項目が残っています (reviewDecision: ${decision:-なし}, 未解決スレッド: ${unresolved:-不明})。"
    echo "PR 作成は完了ではありません。以下を実施してから終了してください:"
    echo "  1. skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --current-branch で状態を確認する"
    echo "  2. 指摘を精査し、妥当なものは同じ PR に追加コミットで対応する"
    echo "  3. 対応結果を pending review で返信し、対応済み thread を resolve する"
    echo "  4. 完了報告の前に同じ現在タスクの PR を --current-branch で再確認する"
    echo "ユーザーが明示的に中断を指示している場合はその旨を伝えて終了してよい。"
  } >&2
  exit 2
fi

exit 0
