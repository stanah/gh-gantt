#!/usr/bin/env bash
# Stop hook: 現在ブランチにオープン PR があり、レビューサイクルの未対応項目
# (CHANGES_REQUESTED / 未解決 review thread) が残っている場合に停止をブロックする。
# 「PR 作成 = 完了」と誤認したままセッションを終えることを防ぐ (ADR-010 L2 / #307)。
# hooks が使えない環境の防衛線は ADR-019 の loop complete ゲートが担う。
set -u

# 直前の Stop hook ブロックからの継続中に再ブロックすると無限ループになる
input=$(cat 2>/dev/null || true)
case "$input" in
  *'"stop_hook_active":true'* | *'"stop_hook_active": true'*) exit 0 ;;
esac

# gh / git がない環境や git リポジトリ外では何もしない (fail-open。
# 強制の本線は環境非依存な CLI 側ゲートに置く)
command -v gh >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0
branch=$(git branch --show-current 2>/dev/null || true)
[ -z "$branch" ] && exit 0
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  exit 0
fi

pr=$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty' 2>/dev/null || true)
[ -z "$pr" ] && exit 0

decision=$(gh pr view "$pr" --json reviewDecision --jq '.reviewDecision // ""' 2>/dev/null || true)

repo_owner=$(gh repo view --json owner --jq '.owner.login' 2>/dev/null || true)
repo_name=$(gh repo view --json name --jq '.name' 2>/dev/null || true)
unresolved=""
if [ -n "$repo_owner" ] && [ -n "$repo_name" ]; then
  unresolved=$(gh api graphql \
    -f query='query($o: String!, $n: String!, $pr: Int!) { repository(owner: $o, name: $n) { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes { isResolved } } } } }' \
    -F o="$repo_owner" -F n="$repo_name" -F pr="$pr" \
    --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length' \
    2>/dev/null || true)
fi

if [ "$decision" = "CHANGES_REQUESTED" ] || { [ -n "$unresolved" ] && [ "$unresolved" -gt 0 ] 2>/dev/null; }; then
  {
    echo "⚠ PR #$pr のレビューサイクルに未対応項目が残っています (reviewDecision: ${decision:-なし}, 未解決スレッド: ${unresolved:-不明})。"
    echo "PR 作成は完了ではありません。以下を実施してから終了してください:"
    echo "  1. skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --current-branch で状態を確認する"
    echo "  2. 指摘を精査し、妥当なものは同じ PR に追加コミットで対応する"
    echo "  3. 対応結果を pending review で返信し、対応済み thread を resolve する"
    echo "  4. 完了報告の前に同スクリプトを --all-open で実行する"
    echo "ユーザーが明示的に中断を指示している場合はその旨を伝えて終了してよい。"
  } >&2
  exit 2
fi

exit 0
