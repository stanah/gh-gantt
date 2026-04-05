---
name: gh-gantt-living-documentation
description: Living Documentation (Martraire) の体系に従って要件・ADR・テストのトレーサビリティを管理する。「要件を追加」「テストに要件 ID を付与」「ADR を書く」「Reconciliation を実行」「テスト結果を要件に反映」で使用。プロジェクト固有のパス・スクリプト名は Discovery フェーズで特定する。
---

# gh-gantt Living Documentation

Living Documentation (Cyrille Martraire, 2019) の原則に基づき、要件・意思決定・テストのトレーサビリティを維持する。**コードとテストが正典**で、手書きドキュメントは「めったに変わらない Evergreen 要件」と「書いたら不変の ADR」に限定する。

このスキルは**汎用的な運用手順**を提供する。実際のファイルパス・スクリプト名・機能領域コードはプロジェクトごとに異なるため、Discovery フェーズで特定する。

## 4層構造（概念）

| Layer                    | 内容                                    | Accuracy Mechanism           | 維持方法           |
| ------------------------ | --------------------------------------- | ---------------------------- | ------------------ |
| 1. Evergreen             | 構造化要件 (YAML)                       | めったに変わらない           | 手書き             |
| 2. ADR                   | 意思決定記録 (YAML)                     | 書いたら不変                 | 手書き             |
| 3. Auto-Generated        | API リファレンス（OpenAPI, TypeDoc 等） | Single Sourcing + Publishing | コマンド実行       |
| 4. Tests as Requirements | テスト名に要件 ID プレフィックス        | Reconciliation Mechanism     | スクリプト自動更新 |

**原則**: Layer 1, 2 は人間が手で書き、Layer 3, 4 はコードが正典で自動維持される。

<HARD-GATE>
このスキルを実行する前に、Discovery フェーズでプロジェクトのセットアップを必ず確認する。

チェック条件: 下記「Discovery フェーズ」の全項目を確認し、パス・スクリプト名・機能領域コードを特定する。
失敗時: セットアップが見つからない場合はユーザーに確認する（スキル適用不可 or 初期セットアップが必要）。
Evidence: 発見した要件ファイルのパス、実行するスクリプト名、使用する機能領域コード一覧を提示する。
</HARD-GATE>

## Discovery フェーズ

このスキルを使い始める前に、プロジェクトのセットアップを必ず確認する：

### 1. プロジェクト設定の確認

`.gantt-sync/workflow.md` にプロジェクト固有の設定がある場合は最優先で参照する。Living Documentation のパス・コマンドが明記されていれば、それに従う。

### 2. 要件ファイルの発見

以下の順で探す：

1. `.gantt-sync/workflow.md` に記載された requirements ファイルのパス
2. `docs/requirements.yaml`（慣習的デフォルト）
3. `requirements.yaml`（プロジェクトルート）
4. その他 — `Glob` や `Grep` で `.yaml` ファイル内の `acceptance_criteria` を検索

見つからない場合: このプロジェクトには Living Documentation がセットアップされていない可能性が高い。ユーザーに確認する。

### 3. ADR ディレクトリの発見

1. `docs/adr/`（慣習的デフォルト、adr-tools の既定）
2. `docs/architecture/decisions/`
3. その他 — `Glob` で `ADR-*.yaml` または `*.md` を検索

### 4. スクリプトの発見

`package.json` の `scripts` を読んで、以下に相当するものを特定する：

| 役割                   | 典型的な名前                                             |
| ---------------------- | -------------------------------------------------------- |
| テスト (JSON reporter) | `test:json`, `test:ci`, `test -- --reporter=json`        |
| Reconciliation         | `req:trace`, `trace-requirements`, `update-requirements` |
| 整合性検証             | `req:validate`, `validate-requirements`                  |
| ドキュメント生成       | `docs:gen`, `docs`, `generate-docs`                      |

**Note**: `docs` という名前は pnpm/npm の組み込みコマンドと衝突するため `docs:gen` を推奨する。

### 5. 機能領域コード一覧の発見

要件ファイルを読み、`areas` セクションから現在使われている領域コード（例: `SYNC`, `HIER` など）を列挙する。新しい要件を追加する際は既存の領域コードに合わせる。

### 6. テスト配置の発見

`Glob` で `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts` などを検索し、テストファイルの配置規約を把握する。

## ID 体系（汎用）

```text
FR-{AREA}-{NNN}              → 機能要件 (Functional Requirement)
NFR-{AREA}-{NNN}             → 非機能要件 (Non-Functional Requirement)
{prefix}-{AREA}-{NNN}-AC{N}  → 受入基準 (Acceptance Criteria)
```

- `{AREA}`: プロジェクトが定義する機能領域コード（Discovery フェーズで特定）
- `{NNN}`: 3桁ゼロパディングまたは連番（プロジェクト規約に従う）
- `{N}`: AC の連番（1から）

## ワークフロー

Discovery フェーズで特定したパス・スクリプト名を `<REQUIREMENTS_FILE>`, `<ADR_DIR>`, `<TEST_JSON_SCRIPT>`, `<TRACE_SCRIPT>`, `<VALIDATE_SCRIPT>`, `<DOCS_GEN_SCRIPT>` として以下の手順に当てはめる。

### 新しい要件を追加する

1. **既存確認**: `<REQUIREMENTS_FILE>` を Read ツールで全文確認し、該当機能領域に重複・類似 AC がないか確認
2. **ID 採番**: 同じ領域の末尾 +1 で連番を振る
3. **AC を追加**: `status: uncovered`, `tests: []` で初期化
4. **コミット**: 要件追加のコミットを作成

```yaml
- id: FR-<AREA>-<NNN>
  summary: 新機能のサマリー（1行）
  acceptance_criteria:
    - id: FR-<AREA>-<NNN>-AC1
      description: 何を満たすべきかを明確に記述
      status: uncovered
      tests: []
```

**重要**: `description` はそのままテスト名の `describe` になる前提で書く。実装詳細ではなく「何を満たすべきか」を書くこと。プロジェクトの言語規約（英語 or 日本語）に従う。

### テストに要件 ID を付与する

テストの `describe` に `[ID]` プレフィックスを付ける。AC の `description` がそのままテスト名になる：

```typescript
describe("[FR-<AREA>-<NNN>-AC1] 何を満たすべきかを明確に記述", () => {
  it("具体的な振る舞いケース1", () => {
    /* ... */
  });
  it("具体的な振る舞いケース2", () => {
    /* ... */
  });
});
```

**スコープの原則**: describe 配下のテストが**すべてその AC を検証する**ように書く。無関係なテストが含まれる場合は、別 describe に分けるか、AC を細分化する。

### Reconciliation を実行する

テストを追加・変更した後は、以下を実行して `<REQUIREMENTS_FILE>` を自動更新する：

```bash
# 古いキャッシュを削除
rm -f test-results*.json

# JSON reporter でテスト実行 (Discovery で特定したスクリプト)
pnpm run <TEST_JSON_SCRIPT>

# requirements の status/tests を自動更新
pnpm run <TRACE_SCRIPT>

# 整合性検証
pnpm run <VALIDATE_SCRIPT>
```

更新された要件ファイルは必ずコミットすること。多くのプロジェクトでは CI が `git diff --exit-code <REQUIREMENTS_FILE>` で陳腐化を検出する。

### ADR を追加する（意思決定の記録）

**ADR を書くべきとき**:

- 複数の選択肢があり1つを採用した（代替案と却下理由が重要）
- 外部制約から採用した技術選定
- プロジェクトの方向性を決める設計判断

**ADR を書くべきでないとき**:

- 実装詳細（コードで読める）
- 作業手順（skills に書く）
- 一時的な決定（PR description で十分）

1. `<ADR_DIR>` の末尾 +1 で連番を振る（ファイル名規約は既存の ADR に合わせる）
2. YAML または Markdown でテンプレートに従って作成
3. **代替案と却下理由を必ず書く**: 「rationale は却下された選択肢にこそある」(Martraire)
4. `related_requirements` で関連する要件 ID を参照
5. コミット

```yaml
id: ADR-<NNN>
title: 意思決定の簡潔なタイトル
date: "YYYY-MM-DD"
status: accepted # accepted / superseded / deprecated
context: |
  なぜこの意思決定が必要になったか。背景と制約。
decision: |
  採用した方針。
alternatives:
  - name: 代替案A
    reason_rejected: なぜ採用しなかったか（具体的に）
  - name: 代替案B
    reason_rejected: なぜ採用しなかったか
consequences:
  - この決定がもたらす影響1
  - この決定がもたらす影響2
related_requirements:
  - FR-<AREA>-<NNN>
```

### 自動生成ドキュメントを更新する

スキーマ・型を変更したら `<DOCS_GEN_SCRIPT>` を実行してローカル確認する。生成物は通常 gitignore されており、CI で毎回再生成される。

## Issue トラッカーとの関係

Issue トラッカー（gh-gantt, GitHub Issues 等）の Issue と要件ファイルの関係：

|          | Issue                      | 要件 (FR/NFR)                |
| -------- | -------------------------- | ---------------------------- |
| **性質** | 作業単位（やること）       | 達成すべき振る舞い・制約     |
| **寿命** | close したら完了           | プロダクトが存在する限り有効 |
| **粒度** | 混在（bug, task, epic...） | 一貫した抽象度               |

**Issue と要件は別物**。新機能の Issue を作ったら、対応する FR/NFR も要件ファイルに追加すべきか検討する（追加しないケースもある。例: バグ修正は通常既存 AC のカバー改善）。

## Red Flags

| やりがちなこと                             | 問題                                         |
| ------------------------------------------ | -------------------------------------------- |
| Discovery フェーズを省略してパスを仮定する | プロジェクト固有のセットアップと不一致になる |
| テストに `[ID]` を付け忘れる               | Reconciliation で uncovered になる           |
| `describe` 配下に無関係なテストを混ぜる    | トレーサビリティの粒度が崩れる               |
| ADR に代替案を書かない                     | 後から「なぜ」を復元できない                 |
| 実装詳細を要件ファイルに書く               | 陳腐化する                                   |
| Reconciliation を実行せずコミット          | CI で要件ファイルの diff エラーになる        |
| 既存要件を確認せず新規追加                 | 重複要件ができる                             |
| Issue と要件を混同する                     | Issue close 時に要件まで失われたように見える |

| 言い訳                                          | 現実                                                |
| ----------------------------------------------- | --------------------------------------------------- |
| 「パスは `docs/requirements.yaml` だろう」      | プロジェクトにより違う。Discovery して確認する      |
| 「小さい変更だから要件不要」                    | 振る舞い変更なら AC を書くか、既存 AC に統合する    |
| 「テスト名を変えるとリネームが面倒」            | AC description とテスト名を一致させる価値の方が高い |
| 「ADR は大袈裟」                                | 6ヶ月後に「なぜこうなった」を調べる工数の方が大きい |
| 「Reconciliation は CI でやるから手元では不要」 | CI で初めて失敗を知ると手戻りする                   |

## プロジェクト固有の設定を `.gantt-sync/workflow.md` に書く

プロジェクト固有のパス・スクリプト名は `.gantt-sync/workflow.md` に以下のように記載することを推奨する：

```markdown
## Living Documentation

- 要件ファイル: `docs/requirements.yaml`
- ADR ディレクトリ: `docs/adr/`
- 機能領域コード: `SYNC`, `HIER`, `VIS`, `CLI`, `API`, `STORE`
- Reconciliation: `pnpm run req:trace`
- 検証: `pnpm run req:validate`
- 自動生成: `pnpm run docs:gen`
- テスト (JSON): `pnpm run test:json`
- 言語: 日本語 (description / テスト名)
```

これがあれば Discovery フェーズをスキップできる。

## リファレンス

- 原著: Cyrille Martraire, _Living Documentation: Continuous Knowledge Sharing by Design_ (Addison-Wesley, 2019)
- ソース: <https://github.com/cyriux/livingdocumentation-thebook>
