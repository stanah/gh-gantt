---
name: gh-gantt-workflow
description: gh-gantt の開発サイクル全体を回すオーケストレーター。「作業を始めたい」「次に何をすべき？」「開発サイクルを回して」で使用。特定の要望のタスク化は gh-gantt-decompose、進捗確認のみは gh-gantt-progress、同期のみは gh-gantt-sync、要件/ADR/テストタグの管理は gh-gantt-living-documentation を使うこと。
---

# gh-gantt 開発ワークフロー

開発サイクル全体をオーケストレーションする。`.gantt-sync/workflow.md` が存在すればプロジェクト固有のコンテキストとして参照する。

## セットアップ

`.gantt-sync/workflow.md` が存在しない場合、`templates/` 配下のいずれかをコピーしてカスタマイズする：

- [templates/workflow.basic.md](templates/workflow.basic.md) — 外部スキル不使用、組み込みの lint/test のみ
- [templates/workflow.superpowers.md](templates/workflow.superpowers.md) — superpowers ツールキット（brainstorming, writing-plans, code-reviewer 等）を使用

注: `gh-gantt init` がワークフローファイルの自動生成に対応している場合はそちらを使用する。

## ライフサイクルフック

このスキルは以下のフックポイントを定義する。各フックで `.gantt-sync/workflow.md` に対応するセクションが存在すれば、そのアクションを実行する。定義がなければスキップする。

| フック                  | タイミング                | 典型的な用途                                                 |
| ----------------------- | ------------------------- | ------------------------------------------------------------ |
| `on_session_start`      | スキル起動直後（pull 前） | 環境確認、通知                                               |
| `on_task_selected`      | 作業対象タスク決定後      | タスク詳細の深掘り、関連調査                                 |
| `before_design`         | 設計フェーズ開始前        | ブレインストーミング、要件整理                               |
| `before_implementation` | 実装フェーズ開始前        | 計画作成、TDD 準備                                           |
| `before_commit`         | `git commit` 実行前       | 外部レビュー（サブエージェント）、lint、テスト、ユーザー承認 |
| `before_push`           | `git push` 実行前         | 最終検証、diff 確認                                          |
| `before_pr`             | `gh pr create` 実行前     | PR description チェック                                      |
| `on_review_received`    | レビュー指摘受領時        | 指摘精査、対応方針決定                                       |
| `on_session_end`        | スキル終了時              | sync push、クリーンアップ                                    |

フックの実装例は `templates/workflow.*.md` を参照。

### 設計原則（[Anthropic: Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) 由来）

このスキルおよびテンプレートは以下の原則に基づく：

- **自己評価の禁止**: エージェントは自分の出力を過大評価する傾向がある。レビューは独立したコンテキストを持つサブエージェントまたはユーザーが行う
- **構造化ハンドオフ**: セッション間の状態は `.gantt-sync/workflow.md`, 要件ファイル（Living Documentation 採用時）, ADR, Issue 等の artifact を通じて受け渡す。記憶や推測に頼らない
- **契約ベースの実装**: 実装前に受入基準をユーザーと合意してからコードを書く
- **ハード閾値**: `before_commit` の合格基準は列挙型で、1 つでも落ちたら失敗

<HARD-GATE>
ステップ 1（sync pull）の完了を evidence で確認するまで、ステップ 3 以降に進んではならない。

チェック条件: `gh-gantt status` を実行し出力を確認する。
失敗時: `gh-gantt-sync` スキルを invoke して pull を実行する。
Evidence: コマンド出力をそのまま提示する。
</HARD-GATE>

## デフォルトフロー

各ステップの **★フック** は `.gantt-sync/workflow.md` の対応セクションを実行するタイミング。

0. **★`on_session_start`** — workflow.md の該当セクションを実行
1. **REQUIRED:** `gh-gantt-sync`（pull）を invoke
2. **OPTIONAL:** `gh-gantt-progress` でタスクの状態を確認
3. タスク確認 — `gh-gantt list --state open` を実行する。
   件数が多い場合は CLI でサポートされているフィルタ（例: `--backlog`, `--scheduled`, `--type`, `--sort`）の併用を提案する。
   注: `--unblocked` および `--sort` オプションが利用中の `gh-gantt` のバージョンで利用可能な場合はそれらを使用し、利用できない場合（コマンドがエラーになる場合）はこれらのオプションを外した `gh-gantt list --state open` にフォールバックする。
   **CLI の出力をそのまま表示すること。要約・再フォーマット・独自テーブルへの変換・一部タスクの省略は一切禁止。**
   ユーザーに選択を促す。
4. タスクのステータスを作業中に更新 — config に `statuses` が定義されていれば `gh-gantt update <number> --status <作業中ステータス>`（`done: false` のステータスを使用）。未定義ならスキップ
5. **★`on_task_selected`** — workflow.md の該当セクションを実行
6. ブランチ作成 — `git checkout -b feat/issue-<number>-<description> main`
7. **★`before_design`** → 設計 → **★`before_implementation`** → 実装 & 検証
   - プロジェクトが Living Documentation 体系を採用している場合（`.gantt-sync/workflow.md` に Living Documentation セクションがある）、振る舞い変更を伴う作業では `gh-gantt-living-documentation` を invoke して要件 AC の追加とテストへの `[ID]` 付与を行う
8. **★`before_commit`** — workflow.md の該当セクションを実行（自己レビュー・lint・テスト等）
9. `git commit`
10. **★`before_push`** — workflow.md の該当セクションを実行
11. `git push`
12. **★`before_pr`** — workflow.md の該当セクションを実行
13. `gh pr create` — PR の description に `Closes #<number>` または `Fixes #<number>` を記載する
14. **★`on_review_received`**（レビュー指摘を受けた場合）— **REQUIRED:** `gh-gantt-review-cycle` スキルを invoke してレビューサイクルを実行。指摘を精査し、妥当な指摘は同じ PR に追加コミットする（Issue 化は不要）。返信は pending review にまとめて 1 回で submit する
15. **★`on_session_end`** — workflow.md の該当セクションを実行
16. **REQUIRED:** `gh-gantt-sync`（push）を invoke。タスクの close は PR マージ時に GitHub が自動で行う

## Red Flags

| やりがちなこと                                                 | 問題                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| pull せずに作業開始                                            | 古いデータで作業、コンフリクトリスク                             |
| タスク選択をスキップ                                           | Issue と紐づかない                                               |
| コミット後にタスク更新を忘れる                                 | GitHub と乖離                                                    |
| エージェントがタスクを勝手に絞り込む                           | ユーザーが見るべきタスクが隠される                               |
| レビュー指摘を Issue 化する                                    | レビュー修正は同じ PR に追加コミットするだけ                     |
| Bot レビューを全て鵜呑みにする                                 | 誤検知や文脈に合わない指摘がある。精査してから対応する           |
| PR マージ前に手動で Issue を close する                        | `Closes #N` で自動クローズに任せる                               |
| 振る舞い変更なのに要件ファイルを更新しない (Living Doc 採用時) | トレーサビリティが欠ける。`gh-gantt-living-documentation` を使う |
| テスト追加後に Reconciliation を忘れる (Living Doc 採用時)     | CI で要件ファイルの diff エラーになる                            |

| 言い訳                                | 現実                                                  |
| ------------------------------------- | ----------------------------------------------------- |
| 「さっき pull したばかり」            | status の出力を確認すること。記憶は evidence ではない |
| 「小さい変更だからタスク不要」        | 追跡されない変更はプロジェクトの盲点になる            |
| 「後で push する」                    | 後では来ない。コミットと push はセットで行う          |
| 「見やすくまとめた」                  | CLI 出力の加工は情報の欠落。そのまま出すこと          |
| 「レビュー指摘だから Issue にしよう」 | Issue は新しい作業単位。レビュー修正は既存 PR の一部  |

## リファレンス

- コマンド詳細: [references/commands.md](references/commands.md)
