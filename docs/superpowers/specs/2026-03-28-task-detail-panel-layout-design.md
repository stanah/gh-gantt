# #69 タスク詳細パネルのレイアウト改善 — デザインスペック

## Context

TaskDetailPanel は 400px 固定の右サイドパネルで、メタ情報（Status, Priority, State, Type, Dates, Assignees, Labels）が全て縦1列で並び、Description にたどり着くまでスクロールが必要。パネル幅も固定で調整できない。GitHub Issue / Projects の2カラムレイアウトに寄せて改善する。

## デザイン

### タイトル領域

パンくず形式の上下2段表示。

- **上段**: Parent タスクのタイトル + Issue 番号（小さめ 12px・薄い色）。クリックでそのタスクの詳細に移動。Parent がない場合は非表示
- **下段**: 現在のタスクのタイトル + Issue 番号（大きめ 17px・太字・リンク色）。クリックで GitHub Issue に遷移（↗ アイコン付き）
- タイトル下に State バッジ（Open/Closed）

### 2カラムレイアウト（幅 ≥560px）

GitHub Issue / Projects と同じ構成。

**左カラム（メイン）:**

1. タイトル領域（上下2段パンくず）
2. Progress バー
3. Description（マークダウンエディタ）
4. Sub-tasks（ツリー表示、▼/▶ で折りたたみ可能、タイトル + State バッジ付き）
5. Blocked by（タイトル付き）
6. Linked PRs（タイトル + Merged/Open バッジ付き）
7. Comments

**右サイドバー（約 200px）:**

- Status（ドロップダウン）
- Priority（ドロップダウン）
- Type（ドロップダウン）
- Start Date / End Date（日付入力）
- Assignees（バッジ）
- Labels（バッジ）
- Milestone（名前 + Due 日付）

各フィールドはクリックで編集可能（既存の select/input をそのまま使用）。

### 1カラムフォールバック（幅 ＜560px）

パネル幅が狭い場合はインラインバッジでメタ情報を1〜2行にまとめる。

1. タイトル領域（上下2段パンくず）
2. メタ情報バッジ行（State, Status, Priority, Type, 日付範囲, Assignees を横並びバッジで）
3. Progress バー
4. Description
5. Sub-tasks / Blocked by / Linked PRs / Comments

メタ情報の編集はバッジクリックでポップオーバー。

### パネル幅リサイズ

- 左端にドラッグハンドル（Layout.tsx の既存実装と同じパターン）
- 最小幅: 320px、最大幅: 800px
- 初期幅: 400px
- 幅の state は App.tsx で管理

### Sub-tasks ツリー表示

- 直下の子タスクを表示。子タスクが更に子を持つ場合は ▼/▶ で折りたたみ可能
- 各行: `▼/▶ ● #番号 タイトル [State バッジ]`
- 子タスクはインデント（padding-left）で階層を表現
- タスク番号クリックでそのタスクの詳細に移動
- ツリーの深さは再帰的に表示（tasks データの parent/sub_tasks 関係を辿る）

### Blocked by / Linked PRs

- Issue 番号 + タイトルを表示
- Linked PRs は Merged/Open バッジ付き

## 対象ファイル

- `packages/ui/src/components/TaskDetailPanel.tsx` — メイン修正対象
- `packages/ui/src/App.tsx` — パネル幅 state、props 追加

## 検証

```bash
pnpm build && pnpm --filter @gh-gantt/ui test && pnpm lint
```

- ビルド・テスト・lint 通過
- パネル幅をドラッグで 320-800px に変更可能
- 560px 以上で2カラム、未満で1カラムに切り替わる
- Description がスクロールなしで表示される
- 既存の編集機能（インライン編集、ドロップダウン、日付入力）が壊れない
- Sub-tasks がツリー表示される
- タイトルクリックで GitHub Issue に遷移
