---
name: gh-gantt-review-cycle
description: PR のレビューコメントを確認し、精査・対応・一括投稿する。「レビュー対応して」「PR のコメントを確認して」「レビューサイクルを回して」で使用。gh-gantt-workflow の on_review_received フックから自動チェーンされる。
---

# gh-gantt Review Cycle

PR 作成後のレビューサイクル（確認・精査・対応・投稿）を標準化する。
Bot レビュー（CodeRabbit, Copilot 等）と人間レビューの両方をカバーする。

## トリガー条件

- `gh pr create` 完了後（PostToolUse hook による自動検出）
- セッション開始時に open PR が存在する場合（`on_session_start` でチェック）
- ユーザーから「レビュー対応して」等の指示を受けた場合

## プロセス

### Phase 1: レビューコメントの検出

PR 番号を特定し、レビューコメントを取得する。

```bash
# 現在のブランチの PR 番号を取得
PR_NUMBER=$(gh pr view --json number --jq '.number')

# レビュー一覧を取得（reviewer, state, body）
gh api repos/{owner}/{repo}/pulls/${PR_NUMBER}/reviews \
  --jq '.[] | {id, user: .user.login, state, body}'

# インラインコメント（レビューコメント）を取得
gh api repos/{owner}/{repo}/pulls/${PR_NUMBER}/comments \
  --jq '.[] | {id, user: .user.login, path, line, body, in_reply_to_id}'

# PR 全体のコメントを取得
gh api repos/{owner}/{repo}/issues/${PR_NUMBER}/comments \
  --jq '.[] | {id, user: .user.login, body}'
```

### Phase 2: Bot vs 人間の分類

取得したレビューを以下の基準で分類する。

| 分類             | 判定基準                       | 対応方針                                           |
| ---------------- | ------------------------------ | -------------------------------------------------- |
| Bot (CodeRabbit) | `user.login` が `coderabbitai` | 精査してから対応。誤検知や文脈に合わない指摘は却下 |
| Bot (Copilot)    | `user.login` が `copilot`      | 同上                                               |
| Bot (その他)     | `user.type` が `Bot`           | 同上                                               |
| 人間             | 上記以外                       | 原則すべて対応。不明点はコメントで確認             |

**重要**: Bot レビューを鵜呑みにしない。各指摘について以下を確認する:

1. 指摘箇所の現在のコードを読む
2. 指摘の妥当性を判断する（誤検知、既に対応済み、文脈に合わない等）
3. 対応方針をユーザーに提示する

### Phase 3: 指摘への対応

妥当と判断した指摘についてコード修正を行う。

- 修正は既存の PR ブランチに追加コミットする（Issue 化しない）
- コミットメッセージ: `fix(scope): レビュー指摘対応 (#PR番号)`
- 1 つのコミットに複数の指摘修正をまとめてよい

### Phase 4: 一括返信（pending review）

<HARD-GATE>
レビューコメントへの返信は必ず pending review にまとめて 1 回で submit する。
個別に返信を投稿してはならない（通知が複数回発生するため）。

チェック条件: すべての返信が pending review に追加されてから submit されること。
失敗時: 個別投稿してしまった場合、以降の返信を pending review にまとめる。
Evidence: submit 後の review ID を提示する。
</HARD-GATE>

#### 手順

```bash
# 1. pending review を作成
REVIEW_ID=$(gh api repos/{owner}/{repo}/pulls/${PR_NUMBER}/reviews \
  -f body="" -f event="PENDING" --jq '.id')

# 2. 各コメントに返信を追加（pending review に紐付く）
# インラインコメントへの返信
gh api repos/{owner}/{repo}/pulls/${PR_NUMBER}/comments/{comment_id}/replies \
  -f body="対応しました。[コミットハッシュ] で修正しています。"

# 注: reply は自動的に pending review に追加される。
# pending review がない場合は先に作成すること。

# 3. すべての返信を追加した後、一括 submit
gh api repos/{owner}/{repo}/pulls/${PR_NUMBER}/reviews/${REVIEW_ID}/events \
  -f event="COMMENT"
```

### Phase 5: スレッド一括 resolve（GraphQL）

対応済みのレビュースレッドを GraphQL の aliased mutations で一括 resolve する。

```bash
# 1. 未 resolve のスレッド ID を取得
gh api graphql -f query='
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 1) {
              nodes { body }
            }
          }
        }
      }
    }
  }
' -f owner='{owner}' -f repo='{repo}' -F number=${PR_NUMBER}

# 2. aliased mutations で一括 resolve
# スレッド ID のリストから mutation を動的に構築する
gh api graphql -f query='
  mutation {
    t1: resolveReviewThread(input: {threadId: "THREAD_ID_1"}) {
      thread { isResolved }
    }
    t2: resolveReviewThread(input: {threadId: "THREAD_ID_2"}) {
      thread { isResolved }
    }
    # ... 対応済みスレッド分だけ追加
  }
'
```

## セッション跨ぎでの利用

新しいセッションでレビュー対応を再開する場合:

1. `gh pr list --author @me --state open` で open PR を確認
2. `gh pr view <number>` で PR の状態を確認
3. このスキルの Phase 1 から実行

`gh-gantt-workflow` の `on_session_start` フックが、open PR の存在を検出して
このスキルの invoke を促す。

## Red Flags

| やりがちなこと                       | 問題                                         |
| ------------------------------------ | -------------------------------------------- |
| レビューコメントに個別返信する       | 通知が複数回発生し、レビュアーに迷惑         |
| Bot レビューを全て鵜呑みにする       | 誤検知がある。必ずコードと照合して精査する   |
| Bot レビューを全て無視する           | 正当な指摘もある。精査してから判断する       |
| レビュー指摘を Issue 化する          | レビュー修正は同じ PR に追加コミットするだけ |
| resolve せずに放置する               | スレッドが散乱し、対応状況が不明になる       |
| 精査結果をユーザーに見せずに対応する | 対応方針はユーザーの承認を得てから実行する   |
