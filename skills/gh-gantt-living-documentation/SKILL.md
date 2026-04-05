---
name: gh-gantt-living-documentation
description: Living Documentation (Martraire) の体系に従って要件・ADR・テストのトレーサビリティを管理する。「要件を追加」「テストに要件IDを付与」「ADR を書く」「req:trace を実行」「トレーサビリティを確認」で使用。このプロジェクトでは docs/requirements.yaml が要件の正典、テスト名の [ID] プレフィックスが Reconciliation Mechanism として機能する。
---

# gh-gantt Living Documentation

Living Documentation (Cyrille Martraire) の原則に基づく4層ドキュメント体系を運用する。コードとテストが正典で、手書きドキュメントは Evergreen 要件と ADR に限定する。

**前提**: プロジェクトに以下のセットアップがあること。存在しない場合はこのスキルは適用不可。

- `docs/requirements.yaml` (構造化要件ファイル)
- `docs/adr/` (ADR ディレクトリ)
- `scripts/req-trace.ts`, `scripts/req-validate.ts`, `scripts/docs-gen.ts`
- `package.json` に `test:json`, `req:trace`, `req:validate`, `docs:gen` スクリプト
- `.github/workflows/ci.yml` に Living Documentation 検証ステップ

## 4層構造

| Layer                    | 内容              | 場所                          | 維持方法                    |
| ------------------------ | ----------------- | ----------------------------- | --------------------------- |
| 1. Evergreen             | 構造化要件        | `docs/requirements.yaml`      | 手書き (めったに変わらない) |
| 2. ADR                   | 意思決定記録      | `docs/adr/ADR-*.yaml`         | 手書き (作成時以後不変)     |
| 3. Auto-Generated        | OpenAPI + TypeDoc | `docs/generated/` (gitignore) | `pnpm docs:gen`             |
| 4. Tests as Requirements | テスト名に `[ID]` | `packages/*/src/__tests__/`   | `pnpm req:trace`            |

**原則**: Layer 1 と 2 だけが人間が手で書く。Layer 3 と 4 はコードが正典で、ドキュメントは自動的に正確さが保証される。

<HARD-GATE>
新しい要件を追加する前に、既存の `docs/requirements.yaml` を必ず読み、重複・矛盾がないか確認する。

チェック条件: `cat docs/requirements.yaml` または Read ツールで全文を確認。
失敗時: 類似の AC が既にある場合、既存 AC を更新するか、本当に新規追加すべきかをユーザーに確認する。
Evidence: 既存要件の確認結果と、新規追加の判断根拠を提示する。
</HARD-GATE>

## ID 体系

```text
FR-{AREA}-{NNN}              → 機能要件 (Functional Requirement)
NFR-{AREA}-{NNN}             → 非機能要件 (Non-Functional Requirement)
{prefix}-{AREA}-{NNN}-AC{N}  → 受入基準 (Acceptance Criteria)
```

**機能領域コード**: `SYNC`, `HIER`, `VIS`, `CLI`, `API`, `STORE`

新しい領域が必要な場合は `docs/superpowers/specs/2026-04-04-living-documentation-design.md` を更新してからユーザーに確認する。

## ワークフロー

### 新しい要件を追加する

1. **既存確認**: `docs/requirements.yaml` を読み、該当機能領域に重複・類似 AC がないか確認
2. **ID 採番**: 同じ領域の末尾 +1 で連番を振る (例: 既存が `FR-SYNC-006` なら次は `FR-SYNC-007`)
3. **AC を追加**: `status: uncovered`, `tests: []` で初期化
4. **コミット**: `git commit -m "docs: FR-XXX-NNN を追加"`

```yaml
- id: FR-SYNC-007
  summary: 新機能のサマリー
  acceptance_criteria:
    - id: FR-SYNC-007-AC1
      description: 何を満たすべきかを日本語で明確に記述
      status: uncovered
      tests: []
```

**重要**: `description` はそのままテスト名の `describe` になる前提で書く。実装詳細ではなく「何を満たすべきか」を書くこと。

### テストに要件 ID を付与する

テスト名の最上位 `describe` に `[ID]` プレフィックスを付ける。AC の `description` がそのままテスト名になる：

```typescript
describe("[FR-SYNC-007-AC1] 何を満たすべきかを日本語で明確に記述", () => {
  it("具体的な振る舞いケース1", () => {
    /* ... */
  });
  it("具体的な振る舞いケース2", () => {
    /* ... */
  });
});
```

**スコープの原則**: describe 配下のテストが**すべてその AC を検証する**ように書く。無関係なテストが含まれる場合は、別 describe に分けるか、AC を細分化する。

### req:trace を実行する (Reconciliation)

テストを追加・変更した後は、以下を実行して `requirements.yaml` を自動更新する：

```bash
rm -f test-results*.json      # 古いキャッシュを削除
pnpm test:json                # JSON reporter でテスト実行
pnpm req:trace                # requirements.yaml の status/tests を自動更新
pnpm req:validate             # 整合性検証
```

更新された `requirements.yaml` は必ずコミットすること。CI で `git diff --exit-code docs/requirements.yaml` が実行され、陳腐化していると fail する。

### ADR を追加する (意思決定の記録)

**ADR を書くべきとき**: コードだけでは「なぜ」が分からない意思決定を行ったとき。特に以下：

- 複数の選択肢があり1つを採用した (代替案と却下理由が重要)
- 外部制約から採用した技術選定
- プロジェクトの方向性を決める設計判断

**ADR を書くべきでないとき**:

- 実装詳細 (コードで読める)
- 作業手順 (skills で書く)
- 一時的な決定 (PR description で十分)

1. `docs/adr/` の末尾 +1 で連番を振る
2. テンプレートに従って YAML を作成 (下記参照)
3. **代替案と却下理由を必ず書く**: 「rationale は却下された選択肢にこそある」(Martraire)
4. `related_requirements` で関連する要件 ID を参照
5. コミット: `git commit -m "docs: ADR-NNN 追加 — 意思決定の要約"`

```yaml
id: ADR-007
title: 意思決定の簡潔なタイトル
date: "2026-04-05"
status: accepted # accepted / superseded / deprecated
context: |
  なぜこの意思決定が必要になったか。背景と制約。
decision: |
  採用した方針。
alternatives:
  - name: 代替案A
    reason_rejected: なぜ採用しなかったか (具体的に)
  - name: 代替案B
    reason_rejected: なぜ採用しなかったか
consequences:
  - この決定がもたらす影響1
  - この決定がもたらす影響2
related_requirements:
  - FR-SYNC-007
```

### 自動生成ドキュメントを更新する

OpenAPI (Zod から) と TypeDoc は `pnpm docs:gen` で一括生成される。`docs/generated/` は gitignore されているので手動コミット不要。CI で毎回再生成される。

スキーマを変更したら `pnpm docs:gen` で再生成してローカル確認すること。

## gh-gantt Issue との連携

gh-gantt の Issue (GitHub Issue) と `requirements.yaml` の関係：

|          | gh-gantt Issue            | requirements.yaml            |
| -------- | ------------------------- | ---------------------------- |
| **性質** | 作業単位 (やること)       | 達成すべき振る舞い・制約     |
| **寿命** | close したら完了          | プロダクトが存在する限り有効 |
| **粒度** | 混在 (bug, task, epic...) | 一貫した抽象度               |

**Issue と要件は別物**。新機能の Issue を作ったら、対応する FR/NFR も `requirements.yaml` に追加すべきか検討する (追加しないケースもある。例: バグ修正は通常既存 AC のカバー改善)。

## Red Flags

| やりがちなこと                            | 問題                                         |
| ----------------------------------------- | -------------------------------------------- |
| テストに `[ID]` を付け忘れる              | req:trace で uncovered になる                |
| `describe` の配下に無関係なテストを混ぜる | トレーサビリティの粒度が崩れる               |
| ADR に代替案を書かない                    | 後から「なぜ」を復元できない                 |
| 実装詳細を requirements.yaml に書く       | 陳腐化する                                   |
| req:trace を実行せずコミット              | CI で diff エラーになる                      |
| 既存要件を確認せず新規追加                | 重複要件ができる                             |
| Issue と要件を混同する                    | Issue close 時に要件まで失われたように見える |

| 言い訳                                     | 現実                                                |
| ------------------------------------------ | --------------------------------------------------- |
| 「小さい変更だから要件不要」               | 振る舞い変更なら AC を書くか、既存 AC に統合する    |
| 「テスト名を変えるとリネームが面倒」       | AC description とテスト名を一致させる価値の方が高い |
| 「ADR は大袈裟」                           | 6ヶ月後に「なぜこうなった」を調べる工数の方が大きい |
| 「req:trace は CI でやるから手元では不要」 | CI で初めて失敗を知ると手戻りする                   |

## リファレンス

- 設計仕様: [docs/superpowers/specs/2026-04-04-living-documentation-design.md](../../docs/superpowers/specs/2026-04-04-living-documentation-design.md)
- 既存 ADR: [docs/adr/](../../docs/adr/)
- 既存要件: [docs/requirements.yaml](../../docs/requirements.yaml)
- 原著: Cyrille Martraire, _Living Documentation: Continuous Knowledge Sharing by Design_ (2019)
