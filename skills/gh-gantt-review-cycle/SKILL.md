---
name: gh-gantt-review-cycle
description: PR のレビューコメントを自動ポーリングで検出し、精査・対応・一括投稿する。PR 作成後に自動起動し、レビュー到着まで監視を続ける。
---

# gh-gantt Review Cycle

PR 作成後のレビューサイクル（監視・検出・精査・対応・投稿）を自動化する。
Bot レビュー（CodeRabbit, Copilot 等）と人間レビューの両方をカバーする。

## トリガー条件

- `gh pr create` 完了後（PostToolUse hook が **自動的にこのスキルを invoke** する）
- セッション開始時に open PR が存在する場合（`gh-gantt-workflow` の session start で自動検出）
- ユーザーから「レビュー対応して」等の指示を受けた場合

## Phase 0: 自動監視（REQUIRED）

<HARD-GATE>
PR 作成後、レビューが届くまで自動でポーリングする。
手動チェックに頼ってはならない。

手順:

1. PR 番号を特定する
2. `/loop` を使って以下のプロンプトでポーリングを開始する:
   `PR #<number> のレビューコメントをチェックして。コメントがあれば gh-gantt-review-cycle スキルの Phase 1 以降で対応して。`
3. ポーリング間隔は自動調整（CI 完了前は短め、完了後はレビュー待ちで長め）

チェック条件: `/loop` が実際に開始されていること。
失敗時: ポーリングなしでレビューを待つのは受入基準違反。
</HARD-GATE>

### ポーリングで確認する項目

```bash
# PR の CI 状態を確認
gh pr view <number> --json statusCheckRollup --jq '.statusCheckRollup[] | {name, status, conclusion}'

# レビューの有無を確認
gh pr view <number> --json reviews --jq '.reviews[] | {author: .author.login, state, submittedAt}'

# インラインコメントの有無を確認
gh api repos/{owner}/{repo}/pulls/<number>/comments --jq 'length'
```

**判定ロジック:**

- レビューもコメントも 0 件 → 次のポーリングまで待機
- レビューまたはコメントが存在 → Phase 1 に進む

## Phase 1: レビューコメントの検出

PR 番号を特定し、レビューコメントを取得する。

```bash
# レビュー一覧を取得
gh pr view <number> --json reviews --jq '.reviews[] | {author: .author.login, state, body}'

# インラインコメントを取得
gh api repos/{owner}/{repo}/pulls/<number>/comments \
  --jq '.[] | {id, user: .user.login, path, body, in_reply_to_id}'
```

## Phase 2: Bot vs 人間の分類

| 分類             | 判定基準                       | 対応方針                                           |
| ---------------- | ------------------------------ | -------------------------------------------------- |
| Bot (CodeRabbit) | `user.login` が `coderabbitai` | 精査してから対応。誤検知や文脈に合わない指摘は却下 |
| Bot (Copilot)    | `user.login` が `copilot`      | 同上                                               |
| Bot (その他)     | `user.type` が `Bot`           | 同上                                               |
| 人間             | 上記以外                       | 原則すべて対応。不明点はコメントで確認             |

**重要**: Bot レビューを鵜呑みにしない。各指摘について:

1. 指摘箇所の現在のコードを読む
2. 指摘の妥当性を判断する（誤検知、既に対応済み、文脈に合わない等）
3. 対応方針をユーザーに提示する

## Phase 3: 指摘への対応

妥当と判断した指摘についてコード修正を行う。

- 修正は既存の PR ブランチに追加コミットする（Issue 化しない）
- コミットメッセージ: `fix(scope): レビュー指摘対応 (#PR番号)`
- 1 つのコミットに複数の指摘修正をまとめてよい

## Phase 4: 一括返信（pending review）

<HARD-GATE>
レビューコメントへの返信は必ず pending review にまとめて 1 回で submit する。
個別に返信を投稿してはならない（通知が複数回発生するため）。
</HARD-GATE>

```bash
# 1. pending review を作成
REVIEW_ID=$(gh api repos/{owner}/{repo}/pulls/<number>/reviews \
  -f body="" -f event="PENDING" --jq '.id')

# 2. 各コメントに返信を追加
gh api repos/{owner}/{repo}/pulls/<number>/comments/{comment_id}/replies \
  -f body="対応しました。[コミットハッシュ] で修正しています。"

# 3. すべての返信を追加した後、一括 submit
gh api repos/{owner}/{repo}/pulls/<number>/reviews/${REVIEW_ID}/events \
  -f event="COMMENT"
```

## Phase 5: スレッド一括 resolve（GraphQL）

```bash
# 1. 未 resolve のスレッド ID を取得
gh api graphql -f query='
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes { id, isResolved, comments(first: 1) { nodes { body } } }
        }
      }
    }
  }
' -f owner='{owner}' -f repo='{repo}' -F number=<number>

# 2. aliased mutations で一括 resolve
gh api graphql -f query='
  mutation {
    t1: resolveReviewThread(input: {threadId: "THREAD_ID_1"}) { thread { isResolved } }
    t2: resolveReviewThread(input: {threadId: "THREAD_ID_2"}) { thread { isResolved } }
  }
'
```

## セッション跨ぎでの利用

`gh-gantt-workflow` の session start が自動で以下を実行する:

```bash
gh pr list --author @me --state open --json number,title,reviewDecision \
  --jq '.[] | select(.reviewDecision == "CHANGES_REQUESTED" or .reviewDecision == "") | {number, title, reviewDecision}'
```

open PR にレビューが届いていれば、このスキルが自動 invoke される。

## Red Flags

| やりがちなこと                       | 問題                                         |
| ------------------------------------ | -------------------------------------------- |
| レビューを手動でチェックする         | Phase 0 の自動ポーリングを使うこと           |
| レビューコメントに個別返信する       | 通知が複数回発生。pending review を使うこと  |
| Bot レビューを全て鵜呑みにする       | 誤検知がある。必ずコードと照合して精査する   |
| Bot レビューを全て無視する           | 正当な指摘もある。精査してから判断する       |
| レビュー指摘を Issue 化する          | レビュー修正は同じ PR に追加コミットするだけ |
| resolve せずに放置する               | スレッドが散乱し、対応状況が不明になる       |
| 精査結果をユーザーに見せずに対応する | 対応方針はユーザーの承認を得てから実行する   |
