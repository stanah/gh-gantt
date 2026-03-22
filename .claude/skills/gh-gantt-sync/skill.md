---
name: gh-gantt-sync
description: gh-gantt の pull/push 同期を実行する。「同期して」「pull して」「push して」で使用。コンフリクト発生時は conflict-resolution にチェーンする。他スキルからの REQUIRED チェーンでも発動。
---

# gh-gantt Sync

pull/push の実行と結果の検証。push 前にタスク状態の更新漏れと Issue 内容の整合性を確認する。

<HARD-GATE>
コンフリクトがある状態で作業を開始してはならない。

チェック条件: `gh-gantt conflicts` を実行し、コンフリクトが 0 件であること。
失敗時: **REQUIRED:** `conflict-resolution` スキルを invoke する。解決完了まで他の作業に進まない。
Evidence: `gh-gantt conflicts` の出力が "No conflicts." であること。
</HARD-GATE>

## プロセス（pull）

1. `gh-gantt pull` 実行
2. `gh-gantt status` で状態確認 — evidence として出力を提示
3. コンフリクトがあれば **REQUIRED:** `conflict-resolution` を invoke
4. `gh-gantt conflicts` で "No conflicts." を確認 — evidence として出力を提示

## プロセス（push）

1. タスク状態の更新漏れがないか確認（作業対象タスクが open のままではないか）
2. Issue body/title が実装内容と乖離していないか確認（大きな仕様変更があれば更新を促す）
3. `gh-gantt push` 実行
4. `gh-gantt status` で未 push 変更がないことを検証 — evidence として出力を提示

## Red Flags

| やりがちなこと | 問題 |
|--------------|------|
| pull せずに作業開始 | 古いデータで作業、コンフリクトリスク |
| タスク更新せずに push | GitHub 上で進捗が見えない |
| コンフリクトを放置 | push も pull もできなくなる |
| Issue body を放置 | 実装と要件の乖離が蓄積する |

## リファレンス

- コマンド詳細: [commands.md](../gh-gantt-workflow/references/commands.md)
