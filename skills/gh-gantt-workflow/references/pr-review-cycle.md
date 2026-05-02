# PR レビューサイクル

PR 作成後のレビュー対応は gh-gantt の製品 CLI ではなく、GitHub PR に対する
`gh` / `gh api graphql` 操作として扱う。gh-gantt の責務は Issue / Project /
`.gantt-sync` の同期であり、PR review thread は GitHub PR の状態である。

## 入口

以下のタイミングで `.claude/hooks/pr-review-cycle-check.sh` を実行する。

- `gh pr create` 完了後: `bash .claude/hooks/pr-review-cycle-check.sh --current-branch`
- PR branch の `git push` 後: `bash .claude/hooks/pr-review-cycle-check.sh --current-branch`
- セッション開始時: `bash .claude/hooks/pr-review-cycle-check.sh --all-open`
- ユーザーが PR 番号を指定したとき: `bash .claude/hooks/pr-review-cycle-check.sh --pr <number>`

hook script は PR が open かつ draft でない場合だけ、以下を `gh` で確認する。

- `gh pr checks <number>` の非 pass check
- `gh pr view <number> --json reviewDecision`
- `gh api graphql` の `reviewThreads(first: 100)` に含まれる未 resolve thread

何も問題がなければ出力しない。問題があれば PR URL と次に見るべきコマンドを出す。

## PR 作成直後

PR を作って終わってはならない。PR 作成はレビューサイクルの開始である。

1. `gh pr view --json number,url,isDraft,state,reviewDecision`
2. `gh pr checks <number> --watch`
3. `bash .claude/hooks/pr-review-cycle-check.sh --pr <number>`
4. CodeRabbit / Copilot / Codex review が非同期処理中なら、数分待って再確認する
5. 未解決 thread、changes requested、failed check のいずれかがあれば対応する

完了条件は以下の全てを満たすこと。

- CI check が pass
- `reviewDecision` が `CHANGES_REQUESTED` ではない
- 未 resolve review thread がない
- レビュー bot が処理中でない、または後続セッションで拾う監視が残っている

## 検出

未解決 review thread は GraphQL で見る。

```bash
gh api graphql \
  -F owner="<owner>" \
  -F name="<repo>" \
  -F number="<pr-number>" \
  -f query='
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          id
          headRefOid
          reviewDecision
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              startLine
              comments(first: 5) {
                nodes {
                  id
                  body
                  author { login }
                }
              }
            }
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
5. commit して push する
6. push 後に再度 `bash .claude/hooks/pr-review-cycle-check.sh --current-branch`

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

resolve 後は `bash .claude/hooks/pr-review-cycle-check.sh --pr <number>` を再実行する。

## Red Flags

| やってはいけないこと                      | 理由                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `gh-gantt` 製品 CLI に PR review を入れる | GitHub PR の責務であり Project/Issue 同期ではない |
| PR を作って完了扱いする                   | 非同期レビューは後から届く                        |
| Bot review をそのまま全修正する           | 誤検知や文脈違いがある                            |
| 返信を個別投稿する                        | 通知がコメント数分だけ増える                      |
| resolve だけ先に行う                      | 対応根拠が PR に残らない                          |
