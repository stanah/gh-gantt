# 開発ワークフロー（superpowers ツールキット使用版）

`gh-gantt-workflow` スキルのライフサイクルフックに対応するアクションを定義する。superpowers ツールキット（`superpowers:brainstorming`, `superpowers:writing-plans`, `superpowers:test-driven-development`, `superpowers:code-reviewer`, `superpowers:verification-before-completion` 等）が利用可能なプロジェクト向け。

## 設計原則

- **自己評価の禁止**: 実装したエージェントが自分で「レビュー済み」と判定してはならない。`superpowers:code-reviewer` は独立したコンテキストのサブエージェントとして動作するため、この原則を満たす（[Anthropic: Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)）
- **契約の明示化**: 実装前に受入基準を明示し、ユーザーと合意する
- **ハード閾値**: コミットの合格基準は列挙型で、1 つでも落ちたら失敗

## on_session_start

**目的**: 新セッション開始時の環境確認。

1. `gh-gantt status` で同期状態を確認する
2. 作業中のタスク（in-progress 状態）がないか確認する
3. 直近の PR 状態を確認する（`gh pr list --author @me`）

## on_task_selected

1. タスクの要件を確認し、作業範囲を明確にする
2. 既存タスクとの重複・矛盾がないか確認する
3. 粒度が大きすぎる場合は子タスクに分解する

## before_design

**ゲート:** 以下に該当する場合はスキップ可

- バグ修正で原因が明確
- 既存パターンの踏襲で設計判断が不要
- 文言修正・設定変更など、影響範囲が自明

1. `superpowers:brainstorming` で要件を明確化し、設計をまとめる
2. `superpowers:writing-plans` で実装計画を作成する

## before_implementation

**契約交渉フェーズ**: 実装前に受入基準をユーザーと合意する。

**スキップゲート:** 以下に該当する場合は契約交渉を省略し、**変更要約の一文提示** のみで可：

- バグ修正で原因が明確（例: 既知の未処理エラー、型不一致）
- 文言修正・typo 修正・フォーマット整形
- 設定ファイルの値変更で影響範囲が自明
- `before_design` がスキップされた場合（連動してスキップ）

上記に該当しない場合は以下を実施する：

1. `superpowers:writing-plans` の出力または設計メモから受入基準を抽出し、箇条書きでユーザーに提示する
2. ユーザーの合意を得る（修正があれば反映）
3. 合意後、`superpowers:test-driven-development` に従って実装する

契約交渉が必要なケースでは、合意前に実装を開始してはならない。

## before_commit

**HARD-GATE: 以下の全基準を満たすまで `git commit` してはならない**

各基準は pass/fail の二値。1 つでも落ちたら commit は失敗。

| #   | 基準                     | 検証方法                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | lint pass                | プロジェクトの lint コマンド（例: `pnpm lint`）が exit 0                                                                                                                                                                                                                                                  |
| 2   | typecheck pass           | プロジェクトの typecheck コマンド（例: `pnpm typecheck`）が exit 0                                                                                                                                                                                                                                        |
| 3   | 全テスト pass            | プロジェクトの test コマンド（例: `pnpm test`）が exit 0。UI 変更時は Playwright MCP 等でブラウザ動作も確認する                                                                                                                                                                                           |
| 4   | 外部レビュー完了         | `Agent` tool で `subagent_type: "superpowers:code-reviewer"`（または `"pr-review-toolkit:code-reviewer"`, `"code-review"`）を起動してレビューを実施し、**報告された全ての Critical / Important 指摘が修正済み**、**または各項目についてユーザーから明示的に「見送り」の承認を得ている**。Minor は対応任意 |
| 5   | ユーザー承認             | 変更要約・検証結果・レビュー結果を提示し、ユーザーから **肯定表現による明示的承認** を得た（下記参照）                                                                                                                                                                                                    |
| 6   | Living Doc 同期 (採用時) | Living Documentation を採用しているプロジェクトでは、下記「Living Documentation」セクションに記載の `TEST_JSON` → `TRACE` → `VALIDATE` スクリプトを順に実行し、要件ファイルの差分がコミットに含まれている。いずれかが失敗したら commit しない。未採用プロジェクトではこの基準は適用外                     |

**自己評価の禁止**: `superpowers:code-reviewer` サブエージェントは独立したコンテキストで動作するため基準 4 を満たす。実装したエージェントが自分の出力を「問題なし」と判断しても基準 4 は満たされない。

**基準 5: 肯定表現の具体例**

| 肯定表現 (pass)                | NG 表現 (fail)                   |
| ------------------------------ | -------------------------------- |
| 「OK」「ok」「OK で」          | 「了解」「りょ」                 |
| 「進めて」「進めてください」   | 「いいかも」「よさそう」         |
| 「commit して」「push して」   | 「確認します」「見ておきます」   |
| 「マージして」「そのまま」     | 「少し待って」「後で返答します」 |
| 「問題ないです」「承認します」 | 質問・留保・沈黙                 |

**質問・留保・中立的な返答は承認ではない**。明示的な肯定表現を得るまで commit してはならない。

## before_push

1. `git log --oneline origin/<branch>..HEAD` でこれから push されるコミットを確認
2. 追加の変更があればユーザーに要約を提示
3. ユーザー承認後に `git push`

## before_pr

1. `superpowers:verification-before-completion` で最終検証
2. PR description に `Closes #<number>` または `Fixes #<number>` を記載する
3. PR 本文をユーザーに提示し、承認後に `gh pr create`

## on_review_received

1. 指摘を精査し、妥当性を判断する（Bot のレビューを鵜呑みにしない）
2. 妥当な指摘は同じ PR に追加コミットする（Issue 化は不要）
3. **対応後の再検証**（修正規模により段階的）:
   - **軽微な修正**（typo、コメント、フォーマット、変数名変更、lint 対応のみ）: 基準 1〜3（lint / typecheck / test）の再実行 + 基準 5（ユーザー承認）のみでよい。基準 4（外部レビュー）は省略可。**Living Doc 採用時**: 要件ファイル / テスト名に触れた場合は基準 6 も再実行
   - **実質的な変更**（ロジック修正、設計変更、新規コード追加）: `before_commit` の全基準を再度通す

## on_session_end

**目的**: セッション終了時のクリーンアップと同期。

1. 未コミットの変更があれば確認してユーザーに提示する
2. `gh-gantt-sync`（push）を invoke してリモートと同期する
3. 次セッションへのハンドオフ情報を Issue コメントや `.gantt-sync/` 配下に残すことを検討する

## Red Flags

| やってはいけないこと                   | 理由                                         |
| -------------------------------------- | -------------------------------------------- |
| 設計せずに実装を始める                 | 手戻りが発生する                             |
| 受入基準の合意前に実装を始める         | 「何が完成か」が曖昧なまま進む               |
| テストを後回しにする                   | TDD の意味がなくなる                         |
| 実装したエージェント自身がレビューする | 自己評価は過大になる。code-reviewer 必須     |
| 一部の基準だけ満たして commit する     | ハード閾値は全基準必須。1 つでも落ちたら失敗 |
| レビュー指摘を別 Issue にする          | レビュー修正は既存 PR の一部                 |
| before_commit のレビューを省略する     | 手戻りが発生する                             |
| ユーザー承認前にコミット・プッシュする | レビュー指摘を取りこぼす                     |

## Living Documentation（オプション）

このプロジェクトで Living Documentation 体系（要件 YAML + ADR + テストタグ + Reconciliation）を採用している場合、以下を記載して `gh-gantt-living-documentation` スキルに参照させる。採用していない場合はこのセクションを削除すること。

- **要件ファイル**: `<path to requirements.yaml>`（例: `docs/requirements.yaml`）
- **ADR ディレクトリ**: `<path to adr/>`（例: `docs/adr/`）
- **機能領域コード**: `<LIST OF AREA CODES>`（例: `SYNC`, `HIER`, `CLI`, `API`）
- **言語**: `<English or 日本語>`（`description` フィールドとテスト名）
- **スクリプト**（`package.json` の scripts 名）:
  - `TEST_JSON`: テスト (JSON reporter) — 例: `pnpm run test:json`
  - `TRACE`: Reconciliation — 例: `pnpm run req:trace`
  - `VALIDATE`: 整合性検証 — 例: `pnpm run req:validate`
  - `DOCS_GEN`: 自動生成ドキュメント — 例: `pnpm run docs:gen`（任意。生成物は通常 gitignore されており commit 必須ではない）

振る舞い変更を伴う開発では、`gh-gantt-living-documentation` スキルを invoke して要件 AC の追加とテスト名への `[ID]` 付与を行うこと。`before_commit` の基準 6 では、上記 `TEST_JSON` → `TRACE` → `VALIDATE` を順に実行し、要件ファイルの差分をコミットに含める。
