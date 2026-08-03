# Graph Engineering pre-adoption benchmark — 2026-08-03

Issue #332 の導入前 pilot。公開 repository を変更しない一時 workspace と、
base revision `09ba15a046f721b98b728ea39a8b81d9053e6f70` から build した CLI を使った。
raw log、認証情報、絶対 path、内部 Run / claim / session ID は保存していない。
各観測の詳細な入力条件、command、期待・観測 postcondition は非公開の一時実行記録にのみ保持し、
versioned な [recovery evidence pack](graph-engineering-recovery-evidence.json) は、この公開要約への
kind / URI / SHA-256 / byte length と outcome / recovery time だけを固定する。

## 結論

この task shape は `single_loop` のままとする。5つの recovery class は別々に確認できたが、
同一 acceptance criteria / revision / verifier / environment の paired trial と token / cost が未取得であり、
sync conflict の operator recovery time も計測していない。欠測を0へ変換せず、Graph arm の改善とは判定しない。

採用前の安全な初期値は concurrency 1、automatic retry 0、remote side effect の human gate 必須、
`outputReferenceLimit: 20`、inline evidence 0 byte とする。

## Recovery smoke

| failure class          | 注入と postcondition                                                                                                                                            | 結果   | recovery time                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------- |
| `runner_failure`       | planner attempt を terminal failure にし、`attempt_failed` の human gate を観測。override 後は失敗 attempt を保持した新 planner node へ進んだ                   | passed | known 726 ms                                 |
| `process_restart`      | event を適用した process を終了し、別 CLI process の `run show --json` で state、wait reason、terminal attempt を再観測した                                     | passed | known 197 ms                                 |
| `stale_lease`          | 5秒 lease の期限後に `run reclaim --reason expired`。旧 owner の heartbeat は `stale_claim` で拒否され、registry version は変化しなかった                       | passed | known 13,060 ms（期限から reclaim 受理まで） |
| `github_api_transient` | pre-check transport seam を1回失敗させ、full fetch fallback を同じ verifier で確認。その後の認証済み real `pull` は exit 0、remote change 0で完了した           | passed | known 3 ms（controlled fallback test）       |
| `sync_conflict`        | #331 の status が local `In Progress` / remote `Done` で競合。`--theirs` の明示 resolve と idempotent push 後、`gh-gantt conflicts` が `No conflicts.` を返した | passed | unknown (`not_collected`)                    |

GitHub API smoke は実 rate-limit、GitHub 障害、大量 requestを発生させていない。controlled seam の failureと、
回復後の実 read postconditionを分離した。sync conflict では公開 Issue の最終値を変更せず、merge済みの`Done`へ
収束させた。

## 比較 coverage

| gate                 | 観測                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 5 scenario registry  | known: `fixed_run_graph`, `ready_frontier`, `verify_failure_recovery`, `human_gate`, `approved_work_graph_mutation` |
| same-condition pair  | unknown: 未実行                                                                                                     |
| verified success     | recovery smoke は known passed。比較 trial は unknown                                                               |
| token / cost         | unknown (`provider_not_exposed`)                                                                                    |
| coordination failure | recovery smoke 中は known 0。比較 trial は unknown                                                                  |
| recovery time        | 4件 known、1件 unknown                                                                                              |

したがって qualification reason は少なくとも `paired_trial_count_insufficient`、
`resource_metrics_unknown`、`operational_metrics_unknown`、`recovery_time_unknown` を含む。
これは benchmark harness の失敗ではなく、Graph を自動昇格させないための fail-closed な結果である。

## 公開 runbook

```bash
pnpm build
pnpm --filter @gh-gantt/cli exec vp test run src/__tests__/pull-precheck.test.ts \
  -t 'pre-check が例外を投げたらフル fetch にフォールバック'
node packages/cli/dist/index.js pull
node packages/cli/dist/index.js run show <run-id> --json
node packages/cli/dist/index.js run reclaim --help
node packages/cli/dist/index.js run heartbeat --help
gh-gantt conflicts
```

この節は再実行用の一般化した操作例であり、実行 evidence そのものではない。
Run Graph / claim の具体的な command file と opaque ID は非公開の一時 workspace にのみ置く。
再実行時も [Graph Engineering 運用 reference](../../skills/gh-gantt-workflow/references/graph-engineering.md) の
public-safe evidence 規律に従い、結果は bounded summaryへ変換する。
