# Changelog

## [0.2.0-alpha](https://github.com/stanah/gh-gantt/compare/v0.1.0-alpha...v0.2.0-alpha) (2026-05-04)


### Features

* add draft task creation and push-to-issue registration ([ec09cba](https://github.com/stanah/gh-gantt/commit/ec09cbaa9ca83fb282c76ac442b0a40961aa9106))
* add issue comments fetch with pull --with-comments ([#26](https://github.com/stanah/gh-gantt/issues/26)) ([dbb98b6](https://github.com/stanah/gh-gantt/commit/dbb98b68e323910bcef4ac5fceb3150b8153ec6c))
* add shared types, zod schemas, and constants ([06e9e92](https://github.com/stanah/gh-gantt/commit/06e9e926103959a935c58abc60cb8b079d1b85ec))
* CLI task subcommands, dev server auto-start, and UI polish ([#25](https://github.com/stanah/gh-gantt/issues/25)) ([ac9864c](https://github.com/stanah/gh-gantt/commit/ac9864cb4897c9b4bf42e8bfbd7e087b77f78090))
* **cli:** close evidence を記録する ([#145](https://github.com/stanah/gh-gantt/issues/145)) ([#223](https://github.com/stanah/gh-gantt/issues/223)) ([e847d5c](https://github.com/stanah/gh-gantt/commit/e847d5cd6f50e2d1b791b1eb52cf1c444390fba5))
* **cli:** doctor の stale 検出を追加 ([#140](https://github.com/stanah/gh-gantt/issues/140)) ([#215](https://github.com/stanah/gh-gantt/issues/215)) ([a2745ab](https://github.com/stanah/gh-gantt/commit/a2745ab0a2a0e1a795f3806b6ddb953e57456f56))
* **cli:** gh-gantt doctor コマンドを追加 ([#176](https://github.com/stanah/gh-gantt/issues/176)) ([2e9cd13](https://github.com/stanah/gh-gantt/commit/2e9cd13d4b6c4818d609f92dc9f207796c585740))
* **cli:** init 時に Organization Issue Types を自動検出して task_types に反映 ([#132](https://github.com/stanah/gh-gantt/issues/132)) ([8dfa237](https://github.com/stanah/gh-gantt/commit/8dfa23792f6c9200915af59a4fb742725f8ce5e7))
* **cli:** タスクサイズ閾値の警告を追加 ([#144](https://github.com/stanah/gh-gantt/issues/144)) ([#220](https://github.com/stanah/gh-gantt/issues/220)) ([0021cd3](https://github.com/stanah/gh-gantt/commit/0021cd34a1ae93c0979fe2353f37362bac854d51))
* **cli:** タスクテンプレートの受入基準スロットを追加 ([#141](https://github.com/stanah/gh-gantt/issues/141)) ([#217](https://github.com/stanah/gh-gantt/issues/217)) ([0ba32e2](https://github.com/stanah/gh-gantt/commit/0ba32e2b737a2cffdc97368952fb2060a3fefe68))
* **cli:** タスクの実装者とレビュアーを分離 ([#142](https://github.com/stanah/gh-gantt/issues/142)) ([#218](https://github.com/stanah/gh-gantt/issues/218)) ([daa3bb0](https://github.com/stanah/gh-gantt/commit/daa3bb0d0e574af8d0cd75c6624d779000e7cd36))
* **cli:** レビュー必須フラグを追加 ([#143](https://github.com/stanah/gh-gantt/issues/143)) ([#219](https://github.com/stanah/gh-gantt/issues/219)) ([35464e7](https://github.com/stanah/gh-gantt/commit/35464e74a59b473e4adca8d9cc42b2dca11870ad))
* **cli:** 受入基準を first-class 化 ([#138](https://github.com/stanah/gh-gantt/issues/138)) ([#216](https://github.com/stanah/gh-gantt/issues/216)) ([10c59ee](https://github.com/stanah/gh-gantt/commit/10c59ee3bbeb4c5b3558dfc3ec48303fbf596dca))
* **export:** SVG/PNGエクスポートを追加 ([#20](https://github.com/stanah/gh-gantt/issues/20)) ([#231](https://github.com/stanah/gh-gantt/issues/231)) ([ded8bb3](https://github.com/stanah/gh-gantt/commit/ded8bb3929fd54671ead9b389bb66e7c04a9abeb))
* scaffold monorepo with shared, cli, and ui packages ([41f9140](https://github.com/stanah/gh-gantt/commit/41f91400b3f9a74a23c1b957ac73cc2c0589dd2b))
* sync engine improvements, UI enhancements, and push safety ([#32](https://github.com/stanah/gh-gantt/issues/32)) ([4788bfb](https://github.com/stanah/gh-gantt/commit/4788bfb7d3a891992a26be8966bd6e1a1ba902a6))
* sync engine redesign with git-model 3-way merge ([#34](https://github.com/stanah/gh-gantt/issues/34)) ([bf6a4af](https://github.com/stanah/gh-gantt/commit/bf6a4af682a38aaf033886bb7432d2957ae5343a))
* task list フィルタ・ソートオプション追加 ([#61](https://github.com/stanah/gh-gantt/issues/61)) ([2a8447d](https://github.com/stanah/gh-gantt/commit/2a8447d75e789d053c558c65465ab116daf9c4e3))
* **ui:** Linked PR のタイトル表示を追加 ([#101](https://github.com/stanah/gh-gantt/issues/101)) ([2dd6e36](https://github.com/stanah/gh-gantt/commit/2dd6e3680fa63a5eba7889bdf2f5554ec9939571))
* **ui:** クリティカルパス表示を追加 ([#18](https://github.com/stanah/gh-gantt/issues/18)) ([#212](https://github.com/stanah/gh-gantt/issues/212)) ([0465439](https://github.com/stanah/gh-gantt/commit/04654397a1794ef3942ef18f030e939e4584fd38))
* **ui:** ステータスcategoryベースのアイコン解決 + Backlog/Blocked追加 ([#109](https://github.com/stanah/gh-gantt/issues/109)) ([e85f77d](https://github.com/stanah/gh-gantt/commit/e85f77db39f1dc010dbb647f6c2d0d0ba0f68d01))
* **ui:** タイムラインヘッダーをGitHub Projects風の2段構成に改善 ([#117](https://github.com/stanah/gh-gantt/issues/117)) ([3533722](https://github.com/stanah/gh-gantt/commit/35337226520232c0099b8d3fc4ff8cda883ef56a))
* **ui:** ラベルグルーピング表示を追加 ([#45](https://github.com/stanah/gh-gantt/issues/45)) ([#211](https://github.com/stanah/gh-gantt/issues/211)) ([1e5acb4](https://github.com/stanah/gh-gantt/commit/1e5acb49f4d4616e40992daa9948142fc759adcb))
* **ui:** 遅延タスクの自動ハイライトを設定化 ([#19](https://github.com/stanah/gh-gantt/issues/19)) ([#230](https://github.com/stanah/gh-gantt/issues/230)) ([556b97b](https://github.com/stanah/gh-gantt/commit/556b97be5be44a180b30482978d41a14c9cde647))
* **ui:** 非稼働日カレンダー基盤を追加 ([#226](https://github.com/stanah/gh-gantt/issues/226)) ([#227](https://github.com/stanah/gh-gantt/issues/227)) ([97231b4](https://github.com/stanah/gh-gantt/commit/97231b416a35ee0684b527d198f94c5df0c9183a))
* Vite Plus 対応（全パッケージ統合） ([#64](https://github.com/stanah/gh-gantt/issues/64)) ([55df9a6](https://github.com/stanah/gh-gantt/commit/55df9a62c5aa0a41b98e7f981f7f2890169ffadd))
* タスクボディテンプレート定義と設定機構 + decompose テンプレート対応 ([#106](https://github.com/stanah/gh-gantt/issues/106)) ([ce5f6f0](https://github.com/stanah/gh-gantt/commit/ce5f6f0255dfbe9774055d6a3902557f4fa190c7))
