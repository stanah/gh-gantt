# Minimal Issue Flow

Issue #123 を dev-role で進める最小例。

## `.gantt-sync/workflow.md`

````markdown
## Dev-Role Config

```yaml
verifyCommands:
  - "pnpm check"
  - "pnpm test"
reviewerRubricPath: "docs/orchestration/review-rubric.md"
scratchpadDir: ".dev-flow"
maxImprovementIterations: 3
maxExecutorRetries: 2
branchNaming: "codex/issue-{number}-{slug}"
prCreator: "pnpm pr:flow create"
```
````

## 実行順

1. `gh-gantt-dev-role role=orchestrator issue=123`
2. orchestrator が `01-plan.json` を作るために planner を呼ぶ。
3. implementer が `02-impl-result-pass-1.json` を作る。
4. executor が `pnpm check`, `pnpm test` を直列実行し、`03-verify-result-pass-1.json` を作る。
5. reviewer が rubric で `04-review-pass-1.json` を作る。
6. orchestrator が `99-orchestrator-decision.md` に `READY_FOR_PR` / `BLOCKED` / `ESCALATED` を記録する。

runtime artifact は `.dev-flow/123/` に置く。既定では commit しない。
