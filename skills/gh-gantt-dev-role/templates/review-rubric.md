# Dev-Role Review Rubric

`reviewerRubricPath` が未指定の project で使う default rubric。

## 採点

| 観点     | 点  | 基準                                                     |
| -------- | --- | -------------------------------------------------------- |
| 要件整合 | 0-3 | acceptance criteria と plan を満たしているか             |
| 検証証跡 | 0-3 | executor の verify-result が十分で、失敗を隠していないか |
| 保守性   | 0-2 | 変更範囲が小さく、既存設計に沿っているか                 |
| 安全性   | 0-2 | 秘密情報、破壊的操作、権限逸脱、データ損失リスクがないか |

合計 8 点以上かつ major 以上の finding がなければ `approve` を検討できる。critical finding が 1 件でもあれば `block` とする。

## Finding severity

| severity | 意味                              |
| -------- | --------------------------------- |
| critical | PR 化や merge を止めるべき欠陥    |
| major    | 修正してから再レビューすべき欠陥  |
| minor    | PR 化は可能だが修正が望ましい問題 |
| nit      | 表記、軽微な整理、将来改善        |

## Reviewer の姿勢

- まず欠陥を探す。
- Yes-Man reviewer にならない。
- executor の成功だけで approve しない。
- plan にない挙動変更を見つけたら不整合として扱う。
- project 固有 rubric がある場合はそちらを優先する。
