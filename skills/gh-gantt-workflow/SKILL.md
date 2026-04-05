---
name: gh-gantt-workflow
description: gh-gantt の開発サイクル全体を回すオーケストレーター。「作業を始めたい」「次に何をすべき？」「開発サイクルを回して」で使用。特定の要望のタスク化は gh-gantt-decompose、進捗確認のみは gh-gantt-progress、同期のみは gh-gantt-sync、要件/ADR/テストタグの管理は gh-gantt-living-documentation を使うこと。
---

# gh-gantt 開発ワークフロー

開発サイクル全体をオーケストレーションする。`.gantt-sync/workflow.md` が存在すればプロジェクト固有のコンテキストとして参照する。

## セットアップ

`.gantt-sync/workflow.md` が存在しない場合、[templates/workflow.md](templates/workflow.md) をコピーして `.gantt-sync/workflow.md` を作成し、プロジェクトに合わせてカスタマイズする。
注: `gh-gantt init` がワークフローファイルの自動生成に対応している場合はそちらを使用する。

<HARD-GATE>
ステップ 1（sync pull）の完了を evidence で確認するまで、ステップ 3 以降に進んではならない。

チェック条件: `gh-gantt status` を実行し出力を確認する。
失敗時: `gh-gantt-sync` スキルを invoke して pull を実行する。
Evidence: コマンド出力をそのまま提示する。
</HARD-GATE>

## デフォルトフロー

1. **REQUIRED:** `gh-gantt-sync`（pull）を invoke
2. **OPTIONAL:** `gh-gantt-progress` でタスクの状態を確認
3. タスク確認 — `gh-gantt list --state open` を実行する。
   件数が多い場合は CLI でサポートされているフィルタ（例: `--backlog`, `--scheduled`, `--type`, `--sort`）の併用を提案する。
   注: `--unblocked` および `--sort` オプションが利用中の `gh-gantt` のバージョンで利用可能な場合はそれらを使用し、利用できない場合（コマンドがエラーになる場合）はこれらのオプションを外した `gh-gantt list --state open` にフォールバックする。
   **CLI の出力をそのまま表示すること。要約・再フォーマット・独自テーブルへの変換・一部タスクの省略は一切禁止。**
   ユーザーに選択を促す。
4. タスクのステータスを作業中に更新 — config に `statuses` が定義されていれば `gh-gantt update <number> --status <作業中ステータス>`（`done: false` のステータスを使用）。未定義ならスキップ
5. ブランチ作成 — `git checkout -b feat/issue-<number>-<description> main`
6. 開発 & 検証（workflow.md に指定があればそのスキルを使用）
   - 振る舞い変更を伴う場合は `gh-gantt-living-documentation` を invoke して `docs/requirements.yaml` に AC を追加し、テストに `[ID]` を付与する
   - テスト追加・変更後は `pnpm test:json && pnpm req:trace && pnpm req:validate` を実行し、更新された `docs/requirements.yaml` をコミットする
7. コミット & PR — PR の description に `Closes #<number>` または `Fixes #<number>` を記載する
8. レビュー指摘対応 — 指摘内容を精査し妥当性を判断してから対応する。Bot のレビューを鵜呑みにしない。妥当な指摘は同じ PR に追加コミットする（Issue 化は不要）
9. **REQUIRED:** `gh-gantt-sync`（push）を invoke。タスクの close は PR マージ時に GitHub が自動で行う

## Red Flags

| やりがちなこと                                         | 問題                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| pull せずに作業開始                                    | 古いデータで作業、コンフリクトリスク                             |
| タスク選択をスキップ                                   | Issue と紐づかない                                               |
| コミット後にタスク更新を忘れる                         | GitHub と乖離                                                    |
| エージェントがタスクを勝手に絞り込む                   | ユーザーが見るべきタスクが隠される                               |
| レビュー指摘を Issue 化する                            | レビュー修正は同じ PR に追加コミットするだけ                     |
| Bot レビューを全て鵜呑みにする                         | 誤検知や文脈に合わない指摘がある。精査してから対応する           |
| PR マージ前に手動で Issue を close する                | `Closes #N` で自動クローズに任せる                               |
| 振る舞い変更なのに docs/requirements.yaml を更新しない | トレーサビリティが欠ける。`gh-gantt-living-documentation` を使う |
| テスト追加後に req:trace を忘れる                      | CI で docs/requirements.yaml の diff エラーになる                |

| 言い訳                                | 現実                                                  |
| ------------------------------------- | ----------------------------------------------------- |
| 「さっき pull したばかり」            | status の出力を確認すること。記憶は evidence ではない |
| 「小さい変更だからタスク不要」        | 追跡されない変更はプロジェクトの盲点になる            |
| 「後で push する」                    | 後では来ない。コミットと push はセットで行う          |
| 「見やすくまとめた」                  | CLI 出力の加工は情報の欠落。そのまま出すこと          |
| 「レビュー指摘だから Issue にしよう」 | Issue は新しい作業単位。レビュー修正は既存 PR の一部  |

## リファレンス

- コマンド詳細: [references/commands.md](references/commands.md)
