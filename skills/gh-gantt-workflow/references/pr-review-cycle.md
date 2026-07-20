# PR レビューサイクル

PR 作成後のレビュー対応は gh-gantt の製品 CLI ではなく、GitHub PR に対する
`gh` / `gh api graphql` 操作として扱う。gh-gantt の責務は Issue / Project /
`.gantt-sync` の同期であり、PR review thread は GitHub PR の状態である。

この手順の正本は `skills/gh-gantt-workflow` skill である。Codex から自動実行できない
`.claude/hooks` を完了保証に使ってはならない。

## 入口

以下のタイミングで `skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh` を実行する。

- `gh pr create` 完了後: `skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --current-branch`
- PR branch の `git push` 後: `skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --current-branch`
- セッション再開時: 現在タスクの PR を `--pr <number>`、またはその branch なら `--current-branch`
- 完了報告前: 現在タスクの PR を `--pr <number>` または `--current-branch`
- ユーザーが PR 番号を指定したとき: `skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --pr <number>`
- ユーザーがリポジトリ全体の監査を明示したとき: `skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --all-open`

`--all-open` は現在ユーザーや現在ブランチではなく、`gh api --paginate` で
リポジトリのオープン PR 全件を確認する repository-wide audit の明示的な opt-in である。
暗黙に `--all-open` へ fallback せず、既定の scope は現在タスクの PR とする。

script は PR が open かつ draft でない場合、以下を `gh` で確認する。

- `gh pr checks <number>` の pending / blocking check
- `gh pr checks <number>` が空配列を返す「checks 未観測」状態
- `gh pr view <number> --json reviewDecision`。GitHub が decision を返さない null / 空状態は
  `NONE` と表示し、API 取得失敗を示す `UNKNOWN` と区別する。
- `gh api graphql` の cursor pagination による未 resolve review thread 全件
- PR issue comments / review comments / reviews の最新 activity。待機中の rate limit を避けるため、
  ポーリングごとに全件 pagination せず、GraphQL で各 connection の末尾だけを見る。
- CodeRabbit の rate limit comment が現在も active かどうか。issue comments 取得は activity 取得と
  1 回にまとめる。ただし現在 head の `gh pr checks` で CodeRabbit status context が pass の場合は、
  rate limit comment を古い警告として扱う。CodeRabbit check が pending / missing の場合は従来通り
  active rate limit として追対応条件に残す。

問題があれば PR URL と snapshot を出す。`--no-wait` は 1 回だけ sweep する。通常実行は
quiet window と stable snapshot を満たすまで待つ。

デフォルト値:

- poll interval: 30 秒
- quiet window: 最後の PR activity から 180 秒
- stable samples: 同じ snapshot が 3 回連続
- timeout: 900 秒

## PR 作成直後

PR を作って終わってはならない。PR 作成はレビューサイクルの開始である。

1. `skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --current-branch`
2. 未解決 thread、changes requested、blocking check、active rate limit のいずれかがあれば対応する
3. 対応後に push し、同じ script を再実行する
4. 完了報告前に現在タスクの PR を同じ指定で再確認する

完了報告では確認した現在タスクの PR 番号と未解決 thread 件数を列挙する。
repository-wide audit はユーザーが明示した場合だけ `--all-open` で行う。

完了条件は以下の全てを満たすこと。

- head SHA が待機中に変わっていない
- GitHub checks を 1 件以上観測している
- CI check が pass または skipping
- `reviewDecision` が `CHANGES_REQUESTED` ではない
- 未 resolve review thread がない
- PR issue comments / review comments / reviews の最新 activity から quiet window が経過している
- 同じ snapshot が stable samples だけ連続している
- 完了報告前に現在タスクの PR が安定したことを確認している

## 検出

未解決 review thread は GraphQL で cursor pagination して見る。固定上限だけで完了判定してはならない。

```bash
gh api graphql \
  -F owner="<owner>" \
  -F name="<repo>" \
  -F number="<pr-number>" \
  -F cursor="<cursor-or-empty>" \
  -f query='
    query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            nodes { isResolved }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }'
```

Bot review は鵜呑みにしない。`coderabbit`, `copilot`, `[bot]` を含む author は
Bot として扱い、現行コードを読んで妥当性を判断する。人間の review は原則対応し、
不明点があれば返信で確認する。

## 対応

妥当な指摘は同じ PR branch に追加コミットする。別 Issue 化しない。

1. 指摘箇所の現在のコードを読む
2. 修正方針を決める
3. 変更する
4. 影響範囲に応じて test / build / req:trace / req:validate / docs:gen を実行する
5. PR description が古い実装方針を説明していないか確認し、必要なら更新する
6. commit して push する
7. push 後に再度 `skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --current-branch`

## 投稿

対応結果は pending review にまとめ、通知を 1 回に抑える。

1. PR の `id` と `headRefOid` を取得する。
2. `addPullRequestReview` で pending review を作る。
3. `addPullRequestReviewThreadReply` に `pullRequestReviewId` と `pullRequestReviewThreadId`
   を渡し、各 thread への返信を pending review に積む。
4. `submitPullRequestReview(event: COMMENT)` で 1 回だけ submit する。

例:

```bash
gh api graphql -f query='
  mutation($pullRequestId: ID!, $commitOID: GitObjectID, $body: String) {
    addPullRequestReview(
      input: { pullRequestId: $pullRequestId, commitOID: $commitOID, body: $body }
    ) {
      pullRequestReview { id }
    }
  }'
```

```bash
gh api graphql -f query='
  mutation($reviewId: ID!, $threadId0: ID!, $body0: String!) {
    reply0: addPullRequestReviewThreadReply(
      input: {
        pullRequestReviewId: $reviewId
        pullRequestReviewThreadId: $threadId0
        body: $body0
      }
    ) {
      comment { id }
    }
  }'
```

```bash
gh api graphql -f query='
  mutation($reviewId: ID!, $body: String!) {
    submitPullRequestReview(
      input: { pullRequestReviewId: $reviewId, event: COMMENT, body: $body }
    ) {
      pullRequestReview { id state }
    }
  }'
```

## Resolve

対応済み thread は GraphQL alias mutation でまとめて resolve する。

```bash
gh api graphql -f query='
  mutation($threadId0: ID!, $threadId1: ID!) {
    resolve0: resolveReviewThread(input: { threadId: $threadId0 }) {
      thread { id isResolved }
    }
    resolve1: resolveReviewThread(input: { threadId: $threadId1 }) {
      thread { id isResolved }
    }
  }'
```

resolve 後は `skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --pr <number>` を再実行する。

## Red Flags

| やってはいけないこと                      | 理由                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `gh-gantt` 製品 CLI に PR review を入れる | GitHub PR の責務であり Project/Issue 同期ではない |
| `.claude/hooks` を完了保証にする          | Codex では自動実行されず、見落とし防止にならない  |
| PR を作って完了扱いする                   | 非同期レビューは後から届く                        |
| 明示要求なしに `--all-open` を実行する    | 現在タスクから scope drift する                   |
| Bot review をそのまま全修正する           | 誤検知や文脈違いがある                            |
| 返信を個別投稿する                        | 通知がコメント数分だけ増える                      |
| resolve だけ先に行う                      | 対応根拠が PR に残らない                          |
