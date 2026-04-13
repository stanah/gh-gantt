---
name: gh-gantt-review-cycle
description: PR レビューサイクルを CronCreate (durable) で自動化する。PR 作成後に cron を登録し、15分おきにレビューコメントを検出・精査・対応・resolve する。close/merge 検知、ループ防止、孤児検出を含む。
---

# gh-gantt Review Cycle

PR 作成後のレビューサイクル（監視・検出・精査・対応・投稿・resolve）を `CronCreate` (durable) で自動化する。
Bot レビュー（CodeRabbit, Copilot 等）と人間レビューの両方をカバーする。

## アーキテクチャ

```
gh pr create 完了
  ↓
PostToolUse hook が review-cycle スキルを invoke
  ↓
Phase 0: CronCreate (durable=true) で 15分おきの cron を登録
  ↓ (cron fire 時、REPL idle で)
Phase 0.5: 自己防衛チェック (閉じた PR なら CronDelete)
  ↓
Phase 1-5: 検出 → 分類 → 対応 → 返信 → resolve
```

**制約**: `CronCreate` は Claude Code セッションが起動中かつ REPL idle の時に発火する。セッション未起動中のレビューは次回セッション開始時にまとめて処理される（durable 永続化により cron 定義は保持）。

## トリガー条件

- `gh pr create` 完了後（PostToolUse hook から自動 invoke）
- セッション開始時に active な review-cycle cron があれば、`gh-gantt-workflow` の `on_session_start` で存在確認される
- ユーザーから「レビュー対応して」等の明示指示

## Phase 0: cron 登録（PR 作成直後のみ実行）

<HARD-GATE>
`gh pr create` 直後にこのフェーズを実行する。手動チェックに頼ってはならない。

手順:

1. PR 番号を特定する (`gh pr view --json number --jq '.number'`)
2. `CronList` で既存 cron を確認し、`[REVIEW-CYCLE PR#<number>]` を prompt に含む cron が既にあれば登録スキップ（冪等性）
3. `CronCreate` を以下のパラメータで呼ぶ:
   - `cron`: `"7,22,37,52 * * * *"` （毎時 7/22/37/52 分に発火。:00/:30 を避ける）
   - `durable`: `true`
   - `recurring`: `true`
   - `prompt`: 下記 prompt テンプレートを使用

チェック条件: `CronCreate` が成功し job ID が返ってきた
失敗時: fallback として `/loop` を提案するが、セッション跨ぎができないため減点
</HARD-GATE>

### cron prompt テンプレート

```
[REVIEW-CYCLE PR#<number>]

gh-gantt-review-cycle スキルの Phase 0.5 以降を実行してください。

対象 PR: #<number>
登録時刻: <ISO8601>

手順:
1. Phase 0.5 の自己防衛チェックを実施
2. Phase 1: 未対応コメントを検出
3. Phase 2-5: 精査・対応・返信・resolve
4. 全て完了したら CronDelete で自身を削除
```

## Phase 0.5: 自己防衛チェック（毎回の cron 実行時）

<HARD-GATE>
以下の条件に該当する場合、即座に `CronDelete` で cron を削除し処理を終了する。
無限実行を防ぐための最重要ガード。

条件チェック:

1. **PR が閉じている**:

   ```bash
   STATE=$(gh pr view <number> --json state --jq '.state')
   # state が "MERGED" / "CLOSED" なら即終了
   ```

2. **draft PR**: skip (cron は残す、次回 ready for review 時に処理)

   ```bash
   IS_DRAFT=$(gh pr view <number> --json isDraft --jq '.isDraft')
   ```

3. **レビューループ検知**: 自分の返信が同じコメントに 3 回以上ぶら下がっていれば停止

   ```bash
   gh api repos/{owner}/{repo}/pulls/<number>/comments \
     --jq '[.[] | select(.user.login == "<self>" and .in_reply_to_id == <comment_id>)] | length'
   ```

   3 以上なら `CronDelete` + ユーザーに通知

4. **GitHub API rate limit**:
   ```bash
   REMAINING=$(gh api rate_limit --jq '.rate.remaining')
   # 100 未満ならスキップ（次回の cron 実行に委ねる）
   ```
   </HARD-GATE>

## Phase 1: レビューコメントの検出

```bash
# 未 resolve のレビュースレッドを取得
gh api graphql -f query='
  query {
    repository(owner: "{owner}", name: "{repo}") {
      pullRequest(number: <number>) {
        reviewThreads(first: 30) {
          nodes {
            id
            isResolved
            comments(first: 1) {
              nodes { databaseId path author { login } body }
            }
          }
        }
      }
    }
  }
' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)'
```

未 resolve スレッドがなければ Phase 0.5 に戻り cron 継続。

## Phase 2: Bot vs 人間の分類

| 分類             | 判定基準                           | 対応方針                                           |
| ---------------- | ---------------------------------- | -------------------------------------------------- |
| Bot (CodeRabbit) | `author.login` が `coderabbitai`   | 精査してから対応。誤検知や文脈に合わない指摘は却下 |
| Bot (Copilot)    | `author.login` に `copilot` を含む | 同上                                               |
| 人間             | 上記以外                           | 原則すべて対応。不明点はコメントで確認             |

**重要**: Bot レビューを鵜呑みにしない。各指摘について:

1. 指摘箇所の現在のコードを読む
2. 指摘の妥当性を判断する（誤検知、既に対応済み、文脈に合わない等）
3. 対応方針をユーザーに提示する

自動化コンテキスト（cron 実行時）では、以下の安全基準を満たす指摘のみ自動対応する:

- ドキュメント/コメントの typo 修正
- 明確な API 誤用 (既存実装との不整合)
- 型定義の軽微な修正

それ以外（ロジック変更、設計判断を含む修正）はユーザーに提示して承認を求める形でコメント投稿し、コード修正は行わない。

## Phase 3: 指摘への対応

妥当と判断した指摘についてコード修正を行う。

- 修正は既存の PR ブランチに追加コミットする（Issue 化しない）
- コミットメッセージ: `fix(scope): レビュー指摘対応 (#PR番号)`
- 1 つのコミットに複数の指摘修正をまとめてよい

## Phase 4: レビューコメントへの返信

**GitHub API の制約**: `/pulls/{num}/comments/{id}/replies` は個別にしか投稿できず、pending review に attach することはできない。REST API の pending review は「新規インラインコメント」用であって、既存スレッドへの「返信」用ではない。

```bash
# 各コメントに個別に返信を投稿
gh api repos/{owner}/{repo}/pulls/<number>/comments/{comment_id}/replies \
  -f body="対応しました。[コミットハッシュ] で修正しています。"
```

**通知削減の工夫**:

- 返信本文に `[コミットハッシュ]` を必ず含め、レビュアーが一目で対応状況を把握できるようにする
- 対応済み・却下の別を明示する（「対応済み:」「却下:」等のプレフィックス）
- 複数コメントへの返信は短時間にまとめて投稿する

## Phase 5: スレッド一括 resolve（GraphQL）

```bash
# aliased mutations で一括 resolve
gh api graphql -f query='
  mutation {
    t1: resolveReviewThread(input: {threadId: "THREAD_ID_1"}) { thread { isResolved } }
    t2: resolveReviewThread(input: {threadId: "THREAD_ID_2"}) { thread { isResolved } }
  }
'
```

## セッション跨ぎと孤児 cron

`durable: true` の cron は `.claude/scheduled_tasks.json` に永続化され、セッション再開時に復元される。
**ただし**、以下のケースで孤児 cron が発生しうる:

1. PR が GitHub Web UI で close された (hook 非発火)
2. セッションクラッシュで Phase 0.5 のクリーンアップが走らなかった

これらは Phase 0.5 の PR state チェックで自動回収されるが、追加保険として `gh-gantt doctor` に orphan cron 検出機能を組み込む（#140 と連動）:

```
gh-gantt doctor
  → CronList で [REVIEW-CYCLE PR#N] を含む cron をリストアップ
  → 各 PR#N の state をチェック
  → closed/merged なら WARN、--fix で CronDelete
```

## Red Flags

| やりがちなこと                        | 問題                                          |
| ------------------------------------- | --------------------------------------------- |
| レビューを手動でチェックする          | Phase 0 の CronCreate を使うこと              |
| 同じ PR に複数 cron を登録する        | CronList で重複チェックすること               |
| 閉じた PR の cron を放置する          | Phase 0.5 で必ず自己削除                      |
| レビューループを放置する              | Phase 0.5 の返信回数チェックを入れる          |
| Bot レビューを自動対応で全修正する    | ロジック変更は承認必須、typo/API 誤用のみ自動 |
| pending review で一括返信しようとする | GitHub API の制約で成立しない                 |
