# Task List Density Improvement Design

**Issue:** #103
**Date:** 2026-03-29
**Status:** Approved

## Background

TaskRow の表示がビジーで、タスクタイトルが他の要素に圧迫されて隠れてしまう。ProgressBar（60px）、PriorityBadge（~30px）、StatusBadge（~70px）が横幅を占有し、タイトル領域が不足している。

## Design Decisions

### 1. ProgressBar → 行背景フラット塗り

- ProgressBar コンポーネントを独立要素から TaskRow の背景レイヤーに変更
- 行全体の左端から `progress%` 分をタスクタイプの色（8% opacity）でフラット塗り
- `position: absolute` の div を行の背景に配置、他要素は `position: relative` で重ねる
- 完了タスク（100%）は `var(--color-complete)` の 8% opacity で全体を塗る
- 進行中タスクはタスクタイプの色を使用
- 削減幅: −60px

### 2. PriorityBadge → アンテナアイコン

- テキストバッジ（CRI/HI/MED/LO）からアンテナバーアイコンに変更
- 4本の縦バー（2px幅、gap:1px）で構成、優先度に応じた本数が色付き
  - Critical: 4本（赤 `#e74c3c`）
  - High: 3本（オレンジ `#f39c12`）
  - Medium: 2本（青 `#3498db`）
  - Low: 1本（グレー `#888`）
- 未使用バーはグレーアウト（`rgba(200,200,200,0.4)`）
- バーの高さ: 4px / 7px / 10px / 13px（下から昇順）
- hover で `title` 属性によるネイティブツールチップ表示
- 全体幅: ~14px、削減幅: −16px

### 3. StatusBadge → 形状変化アイコン

- テキストバッジからステータスごとに異なる形状の SVG アイコンに変更
- アイコンマッピング:
  - **Todo** (`done: false`): 空円○（`stroke: #aaa`、10px、border 1.5px）
  - **In Progress** (`done: false`): 再生▶（`fill: #3fb950`、12px SVG）
  - **In Review** (`done: false`): 目👁（`stroke/fill: #f97316`、14x12px SVG）
  - **Done** (`done: true`): チェック●✓（`fill: #8957e5` 円 + 白チェック、12px SVG）
- マッピングはステータス名ベース。config の `statuses.values` のキー名で判定
- 未知のステータスはフォールバックとして空円○を表示
- hover で `title` 属性によるネイティブツールチップ表示
- 削減幅: −56px

### 4. Assignee 表示

- 変更なし。現状の `@username` 表示を維持

### 5. ダークモード対応

- 背景フラット塗りの opacity はライト/ダークで共通（8%）。CSS 変数のベース色が切り替わるため追加調整は最小限
- アンテナバーのグレーアウト色をダークモード用に調整（`rgba(100,100,100,0.4)` 程度）
- SVG アイコンの色は CSS 変数化を検討するが、現状のハードコード色がダークモードでも視認性良好であればそのまま

## Architecture

### 変更対象コンポーネント

| コンポーネント | ファイル | 変更内容 |
|---|---|---|
| `TaskRow` | `packages/ui/src/components/TaskRow.tsx` | 背景レイヤー追加、ProgressBar 削除、新アイコン配置 |
| `ProgressBar` | `packages/ui/src/components/ProgressBar.tsx` | 廃止（TaskRow 内にインライン化） |
| `PriorityBadge` | `packages/ui/src/components/PriorityBadge.tsx` | アンテナアイコンに書き換え |
| `StatusBadge` | `packages/ui/src/components/StatusBadge.tsx` | 形状変化アイコンに書き換え |

### Props 変更

- `ProgressBar`: コンポーネント廃止。`progress` と `color` は TaskRow が直接使用
- `PriorityBadge`: props 変更なし（`priority: string | undefined`）
- `StatusBadge`: props 変更なし（`status: string | undefined`, `statusValues: Record<string, StatusValue>`）

### ProgressBar 背景統合の実装方針

TaskRow のルート div 内に、最初の子要素として absolute 配置の背景 div を追加:

```tsx
{/* Progress background layer */}
{progress > 0 && (
  <div style={{
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: `${progress}%`,
    background: `${progressColor}14`, // 8% opacity hex
  }} />
)}
```

他の既存要素には `position: "relative"` を追加して背景の上に重ねる。TaskRow のルート div には `position: "relative"` と `overflow: "hidden"` を追加。

## Implementation Order

段階的に適用する（各ステップでビルド・テスト通過を確認）:

1. **ProgressBar の背景統合** — TaskRow に背景レイヤー追加、ProgressBar コンポーネントの呼び出し削除
2. **PriorityBadge のアンテナ化** — コンポーネント内部を書き換え
3. **StatusBadge の形状変化アイコン化** — コンポーネント内部を書き換え
4. **ダークモード確認・調整** — 各アイコンの視認性確認
5. **E2E テスト更新** — スナップショット・セレクタの更新

## Total Space Savings

| 要素 | Before | After | 削減 |
|---|---|---|---|
| ProgressBar | 60px | 0px（背景） | −60px |
| PriorityBadge | ~30px | ~14px | −16px |
| StatusBadge | ~70px | ~14px | −56px |
| **合計** | | | **~132px** |
