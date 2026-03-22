---
name: gh-gantt-workflow
description: gh-gantt の開発サイクル全体を回すオーケストレーター。「作業を始めたい」「次に何をすべき？」「開発サイクルを回して」で使用。特定の要望のタスク化は gh-gantt-decompose、進捗確認のみは gh-gantt-progress、同期のみは gh-gantt-sync を使うこと。
---

# gh-gantt 開発ワークフロー

開発サイクル全体をオーケストレーションする。`.gantt-sync/workflow.md` が存在すればプロジェクト固有のコンテキストとして参照する。

<HARD-GATE>
ステップ 1（sync pull）の完了を evidence で確認するまで、ステップ 3 以降に進んではならない。

チェック条件: `gh-gantt status` を実行し出力を確認する。
失敗時: `gh-gantt-sync` スキルを invoke して pull を実行する。
Evidence: コマンド出力をそのまま提示する。
</HARD-GATE>

## デフォルトフロー

1. **REQUIRED:** `gh-gantt-sync`（pull）を invoke
2. **OPTIONAL:** `gh-gantt-triage` でタスクの衛生状態を確認
3. タスク確認 — `gh-gantt task list --state open --unblocked` で着手可能タスクを表示。
   ソートが必要なら `--sort priority,end_date` を追加。
   出力をそのまま提示し、ユーザーに選択を促す。
   エージェントが出力からタスクを取捨選択してはならない。
   件数が多い場合は `--type`, `--assignee` 等のフィルタとの併用をユーザーに提案する。
4. タスクのステータスを作業中に更新 — config に `statuses` が定義されていれば `gh-gantt task update <number> --status <作業中ステータス>`（`done: false` のステータスを使用）。未定義ならスキップ
5. ブランチ作成 — `git checkout -b feat/issue-<number>-<description> main`
6. 開発 & 検証（workflow.md に指定があればそのスキルを使用）
7. コミット & PR
8. **REQUIRED:** `gh-gantt-sync`（タスクを `--state closed` に更新。config に `statuses` があれば `done: true` のステータスも設定。+ push）を invoke

## Red Flags

| やりがちなこと | 問題 |
|--------------|------|
| pull せずに作業開始 | 古いデータで作業、コンフリクトリスク |
| タスク選択をスキップ | Issue と紐づかない |
| コミット後にタスク更新を忘れる | GitHub と乖離 |
| エージェントがタスクを勝手に絞り込む | ユーザーが見るべきタスクが隠される |

| 言い訳 | 現実 |
|--------|------|
| 「さっき pull したばかり」 | status の出力を確認すること。記憶は evidence ではない |
| 「小さい変更だからタスク不要」 | 追跡されない変更はプロジェクトの盲点になる |
| 「後で push する」 | 後では来ない。コミットと push はセットで行う |

## リファレンス

- コマンド詳細: [references/commands.md](references/commands.md)
