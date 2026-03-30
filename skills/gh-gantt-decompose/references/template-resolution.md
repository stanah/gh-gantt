# テンプレート解決手順

## 1. テンプレート解決

`gantt.config.json` の `task_templates` を確認する。

- `mapping[タスクタイプ]` があれば `path/ファイル名` を読み込む
- 見つからなければ `skills/gh-gantt-decompose/templates/` 内のフォールバックテンプレートを使用（`task.md`, `epic.md`, `feature.md`, `bug.md`）
- `task_templates` 未設定でもフォールバックを使用

## 2. テンプレート解析

拡張子で形式を判別する。

### `.md` 形式

- YAML frontmatter（`---` で囲まれた部分）を除去
- `##` 見出しをセクションとして抽出
- `<!-- ... -->` をガイドテキストとして認識

### `.yml` / `.yaml` 形式

- `body` 内の `textarea`/`input` フィールドの `attributes.label` をセクション見出しとして抽出
- `attributes.description` をガイドテキストとして抽出

## 3. body 生成

- 各セクションの見出しを `##` で配置し、ガイドテキストに従って内容を記述する
- ガイドコメント自体は最終 body に含めない
- 「影響範囲」セクションがある場合はコードベース調査結果（関連ファイルの検出）を反映する

## 4. フォールバック

テンプレートが一切見つからない場合は自由形式で body を記述する。
