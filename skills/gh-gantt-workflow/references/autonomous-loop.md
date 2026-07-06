# 自律ループ（gh-gantt loop × Claude Code /loop）

外側ループ（タスクを選ぶ → 完了させる → 次を選ぶ）をコード駆動で回す手順。
決定論的な部分（選定・停止判定・実績記録）は gh-gantt CLI が行い、
エージェントは設計・実装だけを担う（ADR-016 / ADR-017）。

## 1 イテレーションの手順

1. **observe** — `gh-gantt pull` で最新化する。コンフリクト検出時は
   `gh-gantt-conflict-resolution` を invoke して解決するまで先に進まない
2. **decide** — `gh-gantt loop next --json` を実行する
   - `selected`: iteration plan（選定タスク・選定理由・代替候補）が返り、ジャーナルに記録済み
   - `stopped`: stopReason に従う（下表）
   - `sync_required` / `open_iteration`: 出力の案内に従って前提を整え、再実行する
3. **act** — 選定タスクを実装する。`.gantt-sync/workflow.md` に `## Dev-Role Config` があれば
   `gh-gantt-dev-role role=orchestrator` に引き継ぐ（設計 → 実装 → executor 検証 → レビュー）
4. **record** — 実績を記録する

   ```bash
   gh-gantt loop complete --outcome completed \
     --verify "pnpm test=pass" --verify "pnpm lint=pass" \
     --task-status <done 系ステータス名>
   ```

   検証失敗のまま断念する場合は `--outcome verify_failed`
   （リトライ予算は dev-role の `maxExecutorRetries` に従う）

5. **sync** — `gh-gantt push` で GitHub に反映し、PR を作成する
   （`gh-gantt-pr` と [PR レビューサイクル](pr-review-cycle.md) に従う）
6. 手順 1 に戻る

## 停止条件（stopReason）と対応

| stopReason                    | 意味                              | 次の一手                                |
| ----------------------------- | --------------------------------- | --------------------------------------- |
| `all_done`                    | open タスクなし                   | ループ終了（正常）                      |
| `all_blocked`                 | 全て依存・レビュー等の待ち        | ブロッカー一覧を人間に報告して終了      |
| `backlog_needs_decomposition` | 分解可能な type の open のみ残存  | `gh-gantt-decompose` で分解してから再開 |
| `conflicts_present`           | 未解決コンフリクト                | `gh-gantt-conflict-resolution` で解決   |
| `budget_exhausted`            | `loop.maxIterations` 到達         | 人間に報告して終了                      |
| `human_gate_required`         | config 宣言用（自動検出は未実装） | 人間に委譲                              |

## Claude Code の /loop での駆動

/loop（自律モード）で回す場合、1 反復 = 上記手順 1〜5 とする。
`gh-gantt loop next` が `stopped` を返したら stopReason と詳細を報告してループを終了する。
イテレーション上限や停止条件は `gantt.config.json` の `loop` セクション
（`maxIterations` / `stopWhen` / `onVerifyFailure`）で調整できる。

## Red Flags

| やりがちなこと                       | 問題                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| loop next を使わずタスクを自分で選ぶ | 選定根拠がジャーナルに残らず、スコアリングもバイパスされる |
| complete せずに次の next を叩く      | open_iteration で拒否される。実績（予実）が記録されない    |
| stopped を無視して作業を続ける       | 停止条件はハーネスの判断。無視はループの暴走               |
| pull せずに next を叩く              | 古い状態で選定する。sync_required / stale 警告に従うこと   |
