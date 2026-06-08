---
id: ADR-015
title: Project Map の分類を多ファセット（Group by 軸 + 名前空間ラベル）で行う
date: 2026-06-08
status: accepted
related_requirements:
  - FR-VIS-025
---

## Context

Project Map (Epic #251) の初期実装は parent/sub_tasks の単一ツリーで構造を表していた。しかしタスクは本来、複数の直交する軸（facet）を持つ：分解構造（階層）、機能領域、システム・パッケージ、ラベル、マイルストーン、担当者、ステータス、優先度。

単一の親子ツリーは「1 タスク = 1 つの親」しか表現できないため、「機能で分類」と「システム・パッケージで分類」を**同時に成立させられない**。これは情報設計でいう enumerative/hierarchical 分類の限界であり、解は faceted classification（多ファセット分類：直交する複数軸に many-to-many でタグ付けし、利用者が軸を選んで組み合わせる）である。

調査した一般的なツールの扱い：

- **GitHub Projects v2**: 「Group by 1 軸」＋「Slice で別軸の絞り込み」。ラベルでは group 不可（多対多のため）。
- **Jira**: 「列（ステータス）× スイムレーン（Epic/Component/担当/JQL）」で 2 軸まで。任意 2 軸の同時分類は JQL を組合せ毎に手書きする必要がある。
- **faceted classification（理論）**: 多軸・多対多で最も柔軟だが、設計・運用コストが高い。

gh-gantt の既存資産：`grouping.label_prefix` 設定と `groupTreeByLabel`（Gantt 用の単一プレフィックスグルーピング）。実データには既に `area:` / `phase:` 名前空間ラベルが存在する。

## Decision

Project Map の分類を **「Group by 軸セレクタ（1 度に 1 軸 + 切替）」** とし、機能 vs システムの両立を **「名前空間ラベルを facet 軸にする」** ことで解決する。

1. **軸セレクタ**: 利用者は 1 度に 1 つの軸を選んで切り替える（GitHub Projects と同じモデル）。組み込み軸＝`hierarchy / type / status / priority / assignee / milestone`。
2. **親子ツリーは「分解構造」という 1 つの軸**として温存（既定 = `hierarchy`）。
3. **名前空間ラベルを facet 軸**にする。1 タスクに `feature:project-map` と `system:ui` の両方を付与し、見る軸を切り替える（同一データ・軸切替）。facet は **ラベルから自動検出**する（`namespace:value` 規約、既定区切り `:`）ため設定は不要。`config.grouping.facets` で `{ key, label, label_prefix }` を任意に定義すると、日本語ラベルや並び順をカスタムでき、同じ key は設定が自動検出より優先される。`label:<key>` 軸の prefix は、設定が無ければ `<key>:` にフォールバックする。
4. **多対多の許容**: ラベル facet / 担当者は重複所属を許す（faceted）。単一値軸（type/milestone/status/priority）は 1 グループ。軸の値を持たないタスクは末尾の「(なし)」グループへ。
5. **Board はスイムレーン**: hierarchy 以外の軸を選ぶと、Project Board は「グループ（行）× 実行状態（列）」のマトリクスで表示する（Jira 型）。
6. **後方互換**: 既存の `grouping.label_prefix`（Gantt のラベルグルーピング）は維持する。`label_prefix` は optional 化し、`facets` を追加した。

分類ロジックは shared の `groupTasks(tasks, dimension, config)` / `getGroupDimensions(config)` に集約し、UI に分散させない。

## ラベル名前空間規約

facet 軸として使うラベルは `namespace:value` 形式とする。推奨 namespace：

| namespace  | 意味                         | 例                                           |
| ---------- | ---------------------------- | -------------------------------------------- |
| `system:`  | システム・パッケージ         | `system:ui` / `system:cli` / `system:shared` |
| `feature:` | 機能領域                     | `feature:project-map`                        |
| `area:`    | 既存の機能領域ラベル（継続） | `area:sync`                                  |
| `phase:`   | 開発フェーズ（既存・継続）   | `phase:1`                                    |

1 タスクに複数 namespace のラベルを付与してよい（各軸で独立に分類される）。同一 namespace 内に複数値を付けると、その軸で複数グループに重複所属する。

## Consequences

- **利点**: 機能軸とシステム軸を同一データで切り替え表示できる。親子ツリーを壊さず温存。既存ラベル（`area:` / `phase:`）と整合。GitHub Projects の実装現実とも faceted 理論とも合致。
- **欠点 / コスト**: ラベル運用の規律（namespace の一貫性）が必要。多対多軸では 1 タスクが複数レーンに出るため件数の二重計上に注意。2 軸同時（列 × スイムレーン以外の任意 2 軸）は対象外（必要なら将来 P2）。
- 表示制御・レスポンシブ（小画面時のパネル折り返し等）は本 ADR の対象外で、別途扱う。
