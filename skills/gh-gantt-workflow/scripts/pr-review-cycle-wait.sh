#!/usr/bin/env bash
set -euo pipefail

mode="current-branch"
pr_number=""
wait_enabled=1
poll_seconds=30
quiet_seconds=180
stable_samples=3
timeout_seconds=900

usage() {
  cat <<'USAGE'
Usage:
  pr-review-cycle-wait.sh --pr <number> [options]
  pr-review-cycle-wait.sh --current-branch [options]
  pr-review-cycle-wait.sh --all-open [options]

Options:
  --no-wait                  Run one sweep and exit.
  --poll-seconds <seconds>   Poll interval while waiting. Default: 30.
  --quiet-seconds <seconds>  Required quiet window after last PR activity. Default: 180.
  --stable-samples <count>   Required identical snapshots before completion. Default: 3.
  --timeout-seconds <seconds> Overall wait timeout. Default: 900.
USAGE
}

is_positive_integer() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

parse_number_option() {
  local option="$1"
  local value="${2:-}"
  if ! is_positive_integer "$value"; then
    echo "[gh-gantt workflow] $option requires a positive integer" >&2
    exit 2
  fi
  printf '%s\n' "$value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --current-branch)
      mode="current-branch"
      ;;
    --all-open)
      mode="all-open"
      ;;
    --pr)
      if [ "$#" -lt 2 ] || [[ "${2:-}" == --* ]] || ! is_positive_integer "${2:-}"; then
        echo "[gh-gantt workflow] usage: $0 --pr <number>" >&2
        exit 2
      fi
      mode="pr"
      pr_number="$2"
      shift
      ;;
    --no-wait)
      wait_enabled=0
      ;;
    --poll-seconds)
      poll_seconds=$(parse_number_option "$1" "${2:-}")
      shift
      ;;
    --quiet-seconds)
      quiet_seconds=$(parse_number_option "$1" "${2:-}")
      shift
      ;;
    --stable-samples)
      stable_samples=$(parse_number_option "$1" "${2:-}")
      shift
      ;;
    --timeout-seconds)
      timeout_seconds=$(parse_number_option "$1" "${2:-}")
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      echo "[gh-gantt workflow] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if ! command -v gh >/dev/null 2>&1; then
  echo "[gh-gantt workflow] gh command is not available" >&2
  exit 2
fi

if ! gh auth status -h github.com >/dev/null 2>&1; then
  echo "[gh-gantt workflow] gh is not authenticated for github.com" >&2
  exit 2
fi

repo=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
if [ -z "$repo" ] || [ "$repo" = "null" ]; then
  echo "[gh-gantt workflow] failed to resolve GitHub repository" >&2
  exit 2
fi

owner="${repo%%/*}"
name="${repo#*/}"

review_threads_query='query($owner: String!, $name: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $cursor) { nodes { isResolved } pageInfo { hasNextPage endCursor } } } } }'
activity_tail_query='query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { updatedAt comments(last: 20) { nodes { updatedAt body author { login } } } reviews(last: 20) { nodes { submittedAt } } reviewThreads(last: 50) { nodes { comments(last: 1) { nodes { updatedAt } } } } } } }'

now_epoch() {
  date -u '+%s'
}

iso_to_epoch() {
  local value="${1:-}"
  if [ -z "$value" ] || [ "$value" = "null" ]; then
    printf '0\n'
    return
  fi
  if date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$value" '+%s' >/dev/null 2>&1; then
    date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$value" '+%s'
    return
  fi
  date -u -d "$value" '+%s' 2>/dev/null || printf '0\n'
}

count_unresolved_threads() {
  local number="$1"
  local cursor=""
  local total=0

  while :; do
    local page args page_count has_next next_cursor
    args=(
      -F owner="$owner"
      -F name="$name"
      -F number="$number"
      -f query="$review_threads_query"
      --jq '[([.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length), .data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage, (.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // "")] | @tsv'
    )
    if [ -n "$cursor" ]; then
      args+=(-F cursor="$cursor")
    fi

    page=$(gh api graphql "${args[@]}" 2>/dev/null) || return 1
    IFS=$'\t' read -r page_count has_next next_cursor <<<"$page"

    if ! [[ "${page_count:-}" =~ ^[0-9]+$ ]]; then
      return 1
    fi

    total=$((total + page_count))
    if [ "$has_next" != "true" ]; then
      printf '%s\n' "$total"
      return 0
    fi
    if [ -z "$next_cursor" ]; then
      return 1
    fi
    cursor="$next_cursor"
  done
}

collect_activity_state() {
  local number="$1"
  local initial_iso="$2"
  local max_epoch latest_rate_epoch=0 latest_is_rate_limited=0
  max_epoch=$(iso_to_epoch "$initial_iso")

  local rows timestamp is_rate_limited epoch
  rows=$(
    gh api graphql \
      -F owner="$owner" \
      -F name="$name" \
      -F number="$number" \
      -f query="$activity_tail_query" \
      --jq '
        .data.repository.pullRequest as $pr |
        [
          [$pr.updatedAt, false],
          ($pr.comments.nodes[]? | [
            .updatedAt,
            ((.author.login | ascii_downcase | contains("coderabbit")) and ((.body | contains("Rate limit exceeded")) or (.body | contains("review_rate_limit_status_start")) or (.body | contains("rate limited by coderabbit.ai"))))
          ]),
          ($pr.reviews.nodes[]? | [.submittedAt, false]),
          ($pr.reviewThreads.nodes[]?.comments.nodes[]? | [.updatedAt, false])
        ][] | @tsv
      ' \
      2>/dev/null
  ) || {
    printf '%s|UNKNOWN\n' "$max_epoch"
    return
  }

  while IFS=$'\t' read -r timestamp is_rate_limited; do
      [ -n "$timestamp" ] || continue
      epoch=$(iso_to_epoch "$timestamp")
      if [ "$epoch" -gt "$max_epoch" ]; then
        max_epoch="$epoch"
      fi
      if [ "$is_rate_limited" = "true" ] && [ "$epoch" -ge "$latest_rate_epoch" ]; then
        latest_rate_epoch="$epoch"
        latest_is_rate_limited=1
      elif [ "$epoch" -ge "$latest_rate_epoch" ]; then
        latest_rate_epoch="$epoch"
        latest_is_rate_limited=0
      fi
  done <<<"$rows"

  printf '%s|%s\n' "$max_epoch" "$latest_is_rate_limited"
}

check_counts() {
  local number="$1"
  gh pr checks "$number" \
    --json name,bucket \
    --jq '[length, ([.[] | select(.bucket == "pending")] | length), ([.[] | select(.bucket != "pass" and .bucket != "skipping" and .bucket != "pending")] | length)] | @tsv' \
    2>/dev/null
}

collect_snapshot() {
  local number="$1"
  local metadata number_value url state is_draft head_sha review_decision updated_at
  metadata=$(
    gh pr view "$number" \
      --json number,url,state,isDraft,headRefOid,reviewDecision,updatedAt \
      --jq '[.number, .url, .state, (.isDraft | tostring), .headRefOid, (if .reviewDecision == null or .reviewDecision == "" then "NONE" else .reviewDecision end), .updatedAt] | @tsv' \
      2>/dev/null || true
  )
  if [ -z "$metadata" ]; then
    # metadata 取得失敗時も PR 単位の UNKNOWN snapshot を出し、完了扱いにしない。
    local fallback_url fallback_epoch
    fallback_url="https://github.com/$repo/pull/$number"
    fallback_epoch=$(now_epoch)
    review_decision="UNKNOWN"
    printf '%s\t%s\tOPEN\tfalse\tUNKNOWN\t%s\tUNKNOWN\tUNKNOWN\tUNKNOWN\tUNKNOWN\t%s|UNKNOWN\n' \
      "$number" "$fallback_url" "$review_decision" "$fallback_epoch"
    return 0
  fi

  IFS=$'\t' read -r number_value url state is_draft head_sha review_decision updated_at <<<"$metadata"

  local unresolved_count checks_seen pending_checks blocking_checks counts check_total activity_state latest_activity rate_limit
  unresolved_count=$(count_unresolved_threads "$number" || printf 'UNKNOWN\n')
  counts=$(check_counts "$number" || printf 'UNKNOWN\tUNKNOWN\tUNKNOWN\n')
  IFS=$'\t' read -r check_total pending_checks blocking_checks <<<"$counts"
  if ! [[ "${check_total:-}" =~ ^[0-9]+$ ]]; then
    checks_seen="UNKNOWN"
  elif [ "$check_total" -eq 0 ]; then
    checks_seen="0"
  else
    checks_seen="1"
  fi
  if ! [[ "${pending_checks:-}" =~ ^[0-9]+$ ]]; then
    pending_checks="UNKNOWN"
  fi
  if ! [[ "${blocking_checks:-}" =~ ^[0-9]+$ ]]; then
    blocking_checks="UNKNOWN"
  fi
  activity_state=$(collect_activity_state "$number" "$updated_at")
  latest_activity="${activity_state%%|*}"
  rate_limit="${activity_state#*|}"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$number_value" "$url" "$state" "$is_draft" "$head_sha" "$review_decision" \
    "$unresolved_count" "$checks_seen" "$pending_checks" "$blocking_checks" "$latest_activity|$rate_limit"
}

snapshot_needs_followup() {
  local review_decision="$1"
  local unresolved_count="$2"
  local checks_seen="$3"
  local pending_checks="$4"
  local blocking_checks="$5"
  local rate_limit="$6"

  [ "$review_decision" = "CHANGES_REQUESTED" ] && return 0
  [ "$review_decision" = "UNKNOWN" ] && return 0
  [ "$unresolved_count" = "UNKNOWN" ] && return 0
  [ "$checks_seen" = "UNKNOWN" ] && return 0
  [ "$checks_seen" = "0" ] && return 0
  [ "$pending_checks" = "UNKNOWN" ] && return 0
  [ "$blocking_checks" = "UNKNOWN" ] && return 0
  [ "$rate_limit" = "UNKNOWN" ] && return 0
  [ "$unresolved_count" -gt 0 ] && return 0
  [ "$pending_checks" -gt 0 ] && return 0
  [ "$blocking_checks" -gt 0 ] && return 0
  [ "$rate_limit" = "1" ] && return 0
  return 1
}

print_snapshot() {
  local snapshot="$1"
  local number_value url state is_draft head_sha review_decision unresolved_count checks_seen pending_checks blocking_checks tail latest_activity rate_limit
  IFS=$'\t' read -r number_value url state is_draft head_sha review_decision unresolved_count checks_seen pending_checks blocking_checks tail <<<"$snapshot"
  latest_activity="${tail%%|*}"
  rate_limit="${tail#*|}"

  local quiet_age
  quiet_age=$(( $(now_epoch) - latest_activity ))

  echo "[gh-gantt workflow] PR #$number_value review-cycle snapshot"
  echo "$url"
  echo "- state: $state"
  echo "- draft: $is_draft"
  echo "- head: $head_sha"
  echo "- reviewDecision: $review_decision"
  echo "- unresolved review threads: $unresolved_count"
  echo "- checks seen: $checks_seen"
  echo "- pending checks: $pending_checks"
  echo "- blocking checks: $blocking_checks"
  echo "- active CodeRabbit rate limit: $rate_limit"
  echo "- quiet age seconds: $quiet_age"
}

wait_for_pr() {
  local number="$1"
  local started previous_fingerprint="" stable_count=0
  started=$(now_epoch)

  while :; do
    local snapshot number_value url state is_draft head_sha review_decision unresolved_count checks_seen pending_checks blocking_checks tail latest_activity rate_limit
    if ! snapshot=$(collect_snapshot "$number"); then
      echo "[gh-gantt workflow] failed to collect PR #$number snapshot" >&2
      return 1
    fi

    IFS=$'\t' read -r number_value url state is_draft head_sha review_decision unresolved_count checks_seen pending_checks blocking_checks tail <<<"$snapshot"
    latest_activity="${tail%%|*}"
    rate_limit="${tail#*|}"

    if [ "$state" != "OPEN" ] || [ "$is_draft" = "true" ]; then
      print_snapshot "$snapshot"
      return 0
    fi

    local fingerprint quiet_age elapsed
    fingerprint="$head_sha|$review_decision|$unresolved_count|$checks_seen|$pending_checks|$blocking_checks|$latest_activity|$rate_limit"
    if [ "$fingerprint" = "$previous_fingerprint" ]; then
      stable_count=$((stable_count + 1))
    else
      stable_count=1
      previous_fingerprint="$fingerprint"
    fi

    quiet_age=$(( $(now_epoch) - latest_activity ))
    elapsed=$(( $(now_epoch) - started ))

    if [ "$wait_enabled" -eq 0 ]; then
      print_snapshot "$snapshot"
      if snapshot_needs_followup "$review_decision" "$unresolved_count" "$checks_seen" "$pending_checks" "$blocking_checks" "$rate_limit"; then
        return 1
      fi
      return 0
    fi

    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      echo "[gh-gantt workflow] PR #$number review-cycle wait timed out"
      print_snapshot "$snapshot"
      return 1
    fi

    if ! snapshot_needs_followup "$review_decision" "$unresolved_count" "$checks_seen" "$pending_checks" "$blocking_checks" "$rate_limit" &&
      [ "$quiet_age" -ge "$quiet_seconds" ] &&
      [ "$stable_count" -ge "$stable_samples" ]; then
      print_snapshot "$snapshot"
      return 0
    fi

    if snapshot_needs_followup "$review_decision" "$unresolved_count" "$checks_seen" "$pending_checks" "$blocking_checks" "$rate_limit" &&
      [ "$pending_checks" != "UNKNOWN" ] &&
      [ "$pending_checks" -eq 0 ] &&
      [ "$quiet_age" -ge "$quiet_seconds" ] &&
      [ "$stable_count" -ge "$stable_samples" ]; then
      print_snapshot "$snapshot"
      return 1
    fi

    sleep "$poll_seconds"
  done
}

status=0

case "$mode" in
  current-branch)
    number=$(gh pr view --json number --jq '.number' 2>/dev/null || true)
    if [ -z "$number" ]; then
      echo "[gh-gantt workflow] current branch has no PR" >&2
      exit 1
    fi
    wait_for_pr "$number" || status=$?
    ;;
  all-open)
    found=0
    pr_numbers=$(gh api --paginate "repos/$repo/pulls?state=open&per_page=100" --jq '.[].number') || {
      echo "[gh-gantt workflow] failed to list open PRs for repository" >&2
      exit 1
    }
    while IFS= read -r number; do
      [ -n "$number" ] || continue
      found=1
      wait_for_pr "$number" || status=$?
    done <<<"$pr_numbers"
    if [ "$found" -eq 0 ]; then
      echo "[gh-gantt workflow] no open PRs in repository"
    fi
    ;;
  pr)
    wait_for_pr "$pr_number" || status=$?
    ;;
esac

exit "$status"
