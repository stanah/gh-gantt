# @gh-gantt/smoke

実環境スモークテスト (ADR-008)。個人リポジトリと Org リポジトリの 2 系統で、
gh-gantt CLI の基本フローを検証する。

## 実行方法

```bash
# ビルドが必要 (CLI バイナリを参照するため)
pnpm build

# 個人リポジトリに対するスモーク
pnpm smoke:personal

# Org リポジトリに対するスモーク
pnpm smoke:org
```

## Tier 1 シナリオ

以下のコマンドを順番に実行し、すべて成功することを確認する:

1. `gh-gantt init` -- プロジェクトの初期化
2. `gh-gantt pull` -- GitHub からのデータ取得
3. `gh-gantt status` -- 同期状態の確認
4. `gh-gantt push --dry-run` -- プッシュの検証 (実際の書き込みなし)

## 環境設定

環境変数で対象リポジトリとプロジェクト URL を上書きできる:

| 変数名                       | デフォルト値                                      | 説明                 |
| ---------------------------- | ------------------------------------------------- | -------------------- |
| `SMOKE_PERSONAL_REPO`        | `stanah/gh-gantt-e2e-test`                        | 個人リポジトリ       |
| `SMOKE_PERSONAL_PROJECT_URL` | `https://github.com/users/stanah/projects/4`      | 個人プロジェクト URL |
| `SMOKE_ORG_REPO`             | `gh-gantt-e2e/test-repo`                          | Org リポジトリ       |
| `SMOKE_ORG_PROJECT_URL`      | `https://github.com/orgs/gh-gantt-e2e/projects/1` | Org プロジェクト URL |
| `GITHUB_TOKEN`               | (なし)                                            | GitHub 認証トークン  |

## 認証

### ローカル実行

以下のいずれかを満たしていれば自動的にトークンが取得される (優先順):

1. 環境変数 `GITHUB_TOKEN` が設定されている
2. 環境変数 `GH_TOKEN` が設定されている
3. `gh auth login` 済み (gh CLI の `gh auth token` からフォールバック取得)

推奨は `gh auth login`。追加の環境変数設定は不要。

### CI (GitHub Actions)

#### 個人環境

リポジトリの Secrets に以下を設定する:

- `SMOKE_GITHUB_TOKEN`: 個人アクセストークン (classic) または Fine-grained PAT
  - 必要なスコープ: `repo`, `read:org`, `project`

#### Org 環境 (GitHub App 認証)

Org 環境では GitHub App を使用し、PAT よりも安全にスコープを絞る。

##### 1. GitHub App の作成

1. https://github.com/settings/apps/new にアクセス
2. 以下の設定で App を作成:
   - **App name**: `gh-gantt-smoke-test` (任意)
   - **Homepage URL**: `https://github.com/stanah/gh-gantt`
   - **Webhook**: 無効化 (Active のチェックを外す)
3. **Permissions** で以下を設定:
   - **Repository permissions**:
     - Contents: Read-only
     - Issues: Read & write
     - Metadata: Read-only
   - **Organization permissions**:
     - Projects: Read & write (Org Project V2 のアクセスに必要)

##### 2. App のインストール

1. 作成した App の設定ページで "Install App" をクリック
2. `gh-gantt-e2e` Organization にインストール
3. リポジトリアクセスは "Only select repositories" で `test-repo` を選択

##### 3. Secrets の設定

リポジトリの Secrets に以下を設定:

- `SMOKE_APP_ID`: GitHub App の App ID
- `SMOKE_APP_PRIVATE_KEY`: GitHub App の Private Key (PEM 形式)

##### 4. Variables の設定 (任意)

デフォルト値を上書きする場合のみ、リポジトリの Variables に設定:

- `SMOKE_PERSONAL_REPO`
- `SMOKE_PERSONAL_PROJECT_URL`
- `SMOKE_ORG_REPO`
- `SMOKE_ORG_PROJECT_URL`

## CI 実行タイミング

**現状: 手動実行 (`workflow_dispatch`) のみ**

個人 PAT (`SMOKE_GITHUB_TOKEN`) を CI に配置することの security review が未完了のため、
PR / push / cron の自動トリガーは無効化している。当面は必要に応じて
Actions タブから手動で起動する。

| トリガー                 | 個人環境 | Org 環境 |
| ------------------------ | -------- | -------- |
| 手動 (workflow_dispatch) | 選択可   | 選択可   |
| PR / push / cron         | -        | -        |

### 自動トリガー再開の手順 (security review 完了後)

1. Fine-grained PAT (個人環境用) を repo/project に限定した最小スコープで発行
2. `SMOKE_GITHUB_TOKEN` secret に登録
3. `.github/workflows/smoke.yml` の `on:` に `pull_request` / `push` / `schedule` を追加
4. `smoke-personal` / `smoke-org` の `if:` 条件を自動トリガー対応に戻す

## Graph Engineering benchmark

Graph Engineering は既定ではない。同一受入基準の`single_loop`と`graph_orchestration`を比較し、
5 scenario / 5 recovery smoke、verified success、resource metricが揃ったtask shapeだけを候補にする。
詳細な導入・停止・復旧手順は
[graph-engineering.md](../../skills/gh-gantt-workflow/references/graph-engineering.md)を参照する。

```bash
# reportを標準出力へ表示
pnpm benchmark:graph -- --input benchmark-record.json

# sanitized reportを保存
pnpm benchmark:graph -- --input benchmark-record.json --output benchmark-report.json

# graph_candidate以外をexit 1にする明示gate
pnpm benchmark:graph -- --input benchmark-record.json --require-qualified
```

通常の分析は`single_loop`でも成功する。`--require-qualified`は、全gateを満たす
`graph_candidate`をCIや外部runnerが明示的に要求するときだけ使う。

入力JSONは公開artifactではない。strict schemaは未定義のraw fieldと危険なevidence URIを拒否するが、
suite / task shape / pair IDは非公開入力として扱う。reportはこれらを再出力せずpair ordinalだけを返す。
公開evidenceはrepository相対pathまたはHTTPS URL、SHA-256、byte length、種別だけを記録する。
いずれかのmetricを取得できない場合は0ではなく`unknown(reason)`を使い、Graph候補へ昇格しない。

benchmarkはagent、provider SDK、任意shell command、GitHub mutationを実行しない。実環境faultは専用smoke環境で
安全に注入し、外部runnerがbounded observationを作る。自動GitHub Actions triggerはPAT security reviewが
完了するまで従来どおり無効である。

## 関連

- [ADR-008: 実環境スモークテストによる Org/個人環境差異の検証](../../docs/adr/ADR-008-real-environment-smoke-testing.md)
- NFR-STABILITY-003: Org 環境と個人環境の両方で主要 CLI コマンドが動作する
- NFR-STABILITY-004: スモークテストの継続実行による回帰検知
- [ADR-026: Graph Engineering の採用を実測と recovery evidence で gate する](../../docs/adr/ADR-026-measured-graph-engineering-adoption.md)
- [Issue #332 pre-adoption benchmark](../../docs/benchmarks/graph-engineering-2026-08-03.md)
