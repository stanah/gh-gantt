---
id: ADR-011
title: betterleaks による秘密情報スキャン (pre-commit 差分 + CI 全履歴)
date: 2026-04-17
status: accepted
---

## Context

ADR-010 の三層ワークフローガードは品質 (テスト・ビルド・要件トレーサビリティ) の
自動強制を担うが、秘密情報 (API キー / OAuth トークン等) の誤コミットを検出する
仕組みは含まれていなかった。

AI エージェントによるコード生成が増えるにつれ、次のリスクが顕在化している:

- ダミー値のつもりで本物のトークンを埋め込む
- 環境変数から読み取るべき値をハードコードする
- .env ファイルを誤って追跡対象に含める

個人プランのため GitHub Advanced Security (Secret Scanning) は利用できない。
機械的な検出レイヤをリポジトリ自身に持つ必要がある。

betterleaks は Gitleaks の作者 Zach Rice 氏による後継プロジェクトで、
BPE トークン化による高精度検出 (CredData で recall 98.6% / Gitleaks 70.4%)
と Docker 配布による統一環境を提供する。

## Decision

betterleaks を Docker 統一で導入し、二段ガード構成で秘密情報をスキャンする。

- L1 (pre-commit): lefthook の pre-commit に betterleaks job を追加する。
  `git diff --cached -U0` を `docker run ghcr.io/betterleaks/betterleaks:v1.1.2 stdin`
  に渡し、staged 差分のみスキャンする。docker 未導入時は skip + 警告で L2 に委ねる。

- L2 (CI): 既存 `ci.yml` ではなく専用 `.github/workflows/secret-scan.yml` を作成する。
  理由: 既存 CI は `push: main` と `pull_request: main` のみで発火するため、
  feature branch 直 push を検出できない。秘密情報スキャンは全 branch push + PR で
  走らせる必要があり、かつ既存の expensive CI を全 branch 化するのは過剰。

  専用 workflow では `actions/checkout` に `fetch-depth: 0` を指定し、
  `betterleaks git --log-opts="--all"` で全 ref 全 commit をスキャンする。
  両フラグを省略すると直近 commit しか検査されず、「全履歴スキャン」の
  約束を満たせない (Codex レビュー指摘)。

- 検出時は fail-fast (exit 1)。baseline は使用しない。誤検知は
  `.betterleaks.toml` の `[[allowlists]]` に regex パターンで個別登録する。
  path 単位の包括 allowlist は本物の漏洩を永続的に見逃すため避ける。

- CI ログでの secret 再漏洩を防ぐため `--redact=75` を付与する。

- Docker イメージは `v1.1.2` に手動 pin する。Renovate / dependabot の対象外とし、
  更新は ADR 追記を伴う手動判断とする。

## Alternatives

### gitleaks (同作者の旧版)

同じ作者 Zach Rice 氏が Gitleaks の保守権を失い、後継として betterleaks
を立ち上げた経緯がある。公式に後継への移行が推奨されており、新規導入で
旧版を選ぶ理由がない。

### trufflehog

高機能だが導入コストが高い (複数の verification provider 設定等)。
本プロジェクト規模では過剰で、betterleaks のデフォルトルールで十分カバーできる。

### GitHub Advanced Security (Secret Scanning)

GitHub Team / Enterprise プラン限定機能。本リポジトリは個人プランのため
そもそも利用できない。

### 既存 ci.yml に step を追加する案

既存 ci.yml は push:[main] + pull_request:[main] のみでトリガーされるため、
feature branch 直 push の段階で秘密情報を検出できない。全 branch 対象に
する必要がある一方、既存の expensive な test / build / docs:gen 等を全
branch で走らせるのは過剰。専用 workflow に分離することで両立する。

## Consequences

- 誤コミット / 誤 push の機械的検出が有効になり、人的注意力依存が減る
- ADR-010 の三層ガードと合わせ、品質 + セキュリティの両面を自動化で担保できる
- Docker 統一により環境差異を排除でき、ローカルと CI で同じバージョンを使える
- `git commit --no-verify` や GitHub Web UI での直編集は pre-commit を経由しない。L2 (CI) が最終ゲートとして機能する
- fork からの PR の secret は PR open 時点で既に GitHub に露出しており、検出は revoke 契機にしかならない
- Docker イメージ供給 (ghcr.io) が障害時は CI が fail する。頻発時は binary install への切替を検討する
- Docker 未導入のローカル環境では pre-commit スキャンが skip される。CI で検出されるため致命的ではないが「push してから初めて気付く」体験が発生しうる
- 誤検知が発生した場合は `.betterleaks.toml` の allowlist 追記で対応する
- 実装時に Dogfood で全履歴を一度スキャンし、既存の漏洩・誤検知を分類する。本物の漏洩が見つかった場合は別 Issue で履歴書き換えを行う
