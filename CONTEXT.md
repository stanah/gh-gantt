# gh-gantt

GitHub Projects の仕事構造と、AI エージェント／人間による実行履歴を、異なる正本として安全に結ぶコンテキスト。

## Language

**Graph Contract**:
Plan Graph の topology と Org Graph の authority を versioned contract として定義する正本。
_Avoid_: Workflow definition, role config

**Plan Graph**:
実行可能な node と edge、および遷移条件を表す計画の graph。
_Avoid_: Run plan, workflow state

**Work Graph**:
GitHub Issues / Projects が正本となる、人間の仕事とその親子・依存関係の graph。
_Avoid_: Run state, execution queue

**Org Graph**:
role と、遷移・承認・override を行える authority の graph。
_Avoid_: Assignee list, agent roster

**Run Graph**:
受理された event から導出される、特定の Work Graph 対象に対する実行履歴の graph。
_Avoid_: Task status, loop iteration

**Run Node**:
Graph Contract の node を、一つの Run Graph 内で実体化した不変 ID 付きの実行単位。
_Avoid_: Contract node, task

**Attempt**:
一つの Run Node に対する実行の試行。terminal Attempt は再開せず、再試行時は新しい ID を持つ。
_Avoid_: Retry counter, pass

**Artifact**:
role 間で受け渡す schema-bound な出力参照。本文ではなく producer Attempt と hash を含む bounded reference を正準記録とする。
_Avoid_: Evidence, log

**Evidence**:
transition guard や人間判断の根拠となる provenance 付きの bounded reference。
_Avoid_: Artifact, assertion

**Human Gate**:
human authority の decision evidence、または契約で許可された理由付き override まで Run Graph を停止する checkpoint。
_Avoid_: Warning, optional approval
