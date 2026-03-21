# gh-gantt 同期エンジン: git モデル対応チェックリスト

git 操作との対応を明確にし、実装状況と動作確認を分けて管理する。

## 基本操作

| # | git 操作 | 説明 | gh-gantt 対応 | 実装 | 動作確認 |
|---|---------|------|--------------|:----:|:-------:|
| 1 | `git pull` | いつでも実行可能。fetch + merge | `gh-gantt pull` | ✅ | ✅ E2E |
| 2 | `git pull`（ローカル変更あり） | ローカル変更があっても merge 可能 | `gh-gantt pull`（ガードなし） | ✅ | ✅ E2E |
| 3 | `git push` | リモートが進んでいたら拒否 | `gh-gantt push` | ✅ | ❌ |
| 4 | `git push --force` | リモートの状態を無視して強制 push | `gh-gantt push --force` | ✅ | ❌ |
| 5 | `git status` | ローカル変更の確認 | `gh-gantt status` | ✅ | ✅ E2E |

## マージ・コンフリクト

| # | git 操作 | 説明 | gh-gantt 対応 | 実装 | 動作確認 |
|---|---------|------|--------------|:----:|:-------:|
| 6 | 3-way merge | base/local/remote で比較、非衝突は自動マージ | `threeWayMerge()` | ✅ | ✅ E2E |
| 7 | コンフリクトマーカー (`<<<<`) | 衝突箇所をファイルに記録 | `{field}_current` / `{field}_incoming` キー | ✅ | ✅ E2E |
| 8 | `git status`（コンフリクト中） | 未解決ファイルの一覧表示 | `gh-gantt conflicts` | ✅ | ✅ E2E |
| 9 | エディタで解決 + `git add` | 衝突を手動解決 | `gh-gantt resolve --ours/--theirs` | ✅ | ✅ E2E |
| 10 | コンフリクト未解決で merge 不可 | 解決するまで次の merge をブロック | `has_conflicts` ガードで pull ブロック | ✅ | ✅ E2E |
| 11 | コンフリクト未解決で push 不可 | 解決するまで push をブロック | `has_conflicts` ガードで push ブロック | ✅ | ✅ E2E |

## ローカル変更の保持

| # | git の動作 | gh-gantt の対応 | 実装 | 動作確認 |
|---|-----------|---------------|:----:|:-------:|
| 12 | pull 後もローカル変更は push 対象として残る | snapshot.hash を保持し push 差分が検出される | ✅ | ✅ E2E |
| 13 | pull でコンフリクトしなかったローカル変更は push 可能 | 非衝突フィールドは自動マージされ push 対象として残る | ✅ | ✅ E2E |
| 14 | pull でコンフリクトしたフィールドは resolve 後に push 可能 | resolve → snapshot 更新 → push で反映 | ✅ | ❌ |

## delete/modify コンフリクト

| # | git の動作 | gh-gantt の対応 | 実装 | 動作確認 |
|---|-----------|---------------|:----:|:-------:|
| 15 | リモートで削除 + ローカル未変更 → ローカルも削除 | タスクを削除 | ✅ | ✅ E2E |
| 16 | リモートで削除 + ローカル変更あり → 警告して保持 | 警告表示しタスクを保持 | ✅ | ✅ 手動確認 (E2E は GraphQL 伝播ラグで skip) |

## 動作確認手順

### 前提
- `.gantt-sync/` に既存のタスクデータがある状態で確認
- ビルド済み: `pnpm build`

### #1, #2: pull の基本動作
```bash
# ローカル変更がある状態で pull が実行できることを確認
gh-gantt status                    # ローカル変更を確認
gh-gantt pull --dry-run            # ブロックされずにプレビューが表示される
```

### #3: push のリモート変更チェック
```bash
gh-gantt push --dry-run            # プレビュー表示
```

### #5: status
```bash
gh-gantt status                    # ローカル/リモート変更が表示される
```

### #6, #7: 3-way merge とコンフリクトマーカー
```bash
# ローカルとリモートが同じフィールドを変更している状態で pull
gh-gantt pull                      # コンフリクト数が表示される
gh-gantt conflicts                 # マーカー付きのフィールドが表示される
```

### #8: conflicts コマンド
```bash
gh-gantt conflicts                 # 一覧表示
gh-gantt conflicts <issue-number>  # 特定タスクのみ
```

### #9: resolve コマンド
```bash
gh-gantt resolve <issue> --field <field> --ours     # ローカル側を採用
gh-gantt resolve <issue> --field <field> --theirs   # リモート側を採用
gh-gantt conflicts                                   # "No conflicts." を確認
```

### #10, #11: コンフリクト中のガード
```bash
# コンフリクトが残っている状態で
gh-gantt pull                      # "未解決のコンフリクトがあります" でブロック
gh-gantt push                      # "未解決のコンフリクトがあります" でブロック
```

### #12, #13: ローカル変更の保持
```bash
# 1. ローカル変更を確認
gh-gantt status                    # ~ で変更タスクが表示される

# 2. pull を実行
gh-gantt pull                      # マージ完了

# 3. ローカル変更が push 対象として残っていることを確認
gh-gantt status                    # まだ ~ で変更タスクが表示される

# 4. push で反映
gh-gantt push                      # ローカル変更が GitHub に反映される
```

### #14: コンフリクト解決後の push
```bash
# コンフリクト発生 → 解決 → push の一連フロー
gh-gantt pull                      # コンフリクト発生
gh-gantt conflicts                 # 確認
gh-gantt resolve --theirs          # 解決
gh-gantt push                      # GitHub に反映
```

### #15, #16: delete/modify コンフリクト
```bash
# GitHub 側で Issue を削除した状態で pull
gh-gantt pull
# ローカル未変更 → タスク削除
# ローカル変更あり → 警告表示しタスク保持
```
