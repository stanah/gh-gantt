# Changelog

## [0.2.0-alpha](https://github.com/stanah/gh-gantt/compare/v0.1.0-alpha...v0.2.0-alpha) (2026-05-04)


### Features

* add config, tasks, and sync-state store layer ([f07d57b](https://github.com/stanah/gh-gantt/commit/f07d57ba19a6a4b343b0da33a11347cf6291f220))
* add draft task creation and push-to-issue registration ([ec09cba](https://github.com/stanah/gh-gantt/commit/ec09cbaa9ca83fb282c76ac442b0a40961aa9106))
* add GitHub auth and GraphQL client ([211e2a3](https://github.com/stanah/gh-gantt/commit/211e2a3fa37700520dfaa5d820c9a617b3ff6950))
* add init command with ProjectV2 data fetching ([aa403fb](https://github.com/stanah/gh-gantt/commit/aa403fb5919bbaed6a3a50acbb3d749d03a90370))
* add issue comments fetch with pull --with-comments ([#26](https://github.com/stanah/gh-gantt/issues/26)) ([dbb98b6](https://github.com/stanah/gh-gantt/commit/dbb98b68e323910bcef4ac5fceb3150b8153ec6c))
* add ProjectV2 GraphQL queries and data fetching ([777fae6](https://github.com/stanah/gh-gantt/commit/777fae6fa9d7159fc1d37f4f8875daed3d25bafd))
* add pull command with snapshot-based diff detection ([a7d60a9](https://github.com/stanah/gh-gantt/commit/a7d60a93e8c9dbbdfa702349d7e9670d001100e0))
* add push and status commands with conflict detection ([f114a37](https://github.com/stanah/gh-gantt/commit/f114a37a58515a2180a3ab4c7e57648d547f2963))
* add serve command with REST API for UI ([2bc84e2](https://github.com/stanah/gh-gantt/commit/2bc84e27280b1017b0516574bb61e5a32e7bd03e))
* CLI task subcommands, dev server auto-start, and UI polish ([#25](https://github.com/stanah/gh-gantt/issues/25)) ([ac9864c](https://github.com/stanah/gh-gantt/commit/ac9864cb4897c9b4bf42e8bfbd7e087b77f78090))
* CLI コマンド体系をフラット化 ([#56](https://github.com/stanah/gh-gantt/issues/56)) ([#72](https://github.com/stanah/gh-gantt/issues/72)) ([2762fe6](https://github.com/stanah/gh-gantt/commit/2762fe6e8b08dd57189d2af58835a5c92c730726))
* **cli:** close evidence を記録する ([#145](https://github.com/stanah/gh-gantt/issues/145)) ([#223](https://github.com/stanah/gh-gantt/issues/223)) ([e847d5c](https://github.com/stanah/gh-gantt/commit/e847d5cd6f50e2d1b791b1eb52cf1c444390fba5))
* **cli:** context コマンドを追加 ([#139](https://github.com/stanah/gh-gantt/issues/139)) ([4ad60e3](https://github.com/stanah/gh-gantt/commit/4ad60e3ad27abb69f0f728fdcb54e26c6fc0bca1))
* **cli:** doctor の stale 検出を追加 ([#140](https://github.com/stanah/gh-gantt/issues/140)) ([#215](https://github.com/stanah/gh-gantt/issues/215)) ([a2745ab](https://github.com/stanah/gh-gantt/commit/a2745ab0a2a0e1a795f3806b6ddb953e57456f56))
* **cli:** gh-gantt doctor コマンドを追加 ([#176](https://github.com/stanah/gh-gantt/issues/176)) ([2e9cd13](https://github.com/stanah/gh-gantt/commit/2e9cd13d4b6c4818d609f92dc9f207796c585740))
* **cli:** init 時に Organization Issue Types を自動検出して task_types に反映 ([#132](https://github.com/stanah/gh-gantt/issues/132)) ([8dfa237](https://github.com/stanah/gh-gantt/commit/8dfa23792f6c9200915af59a4fb742725f8ce5e7))
* **cli:** sprint CLI CRUD を追加 ([#199](https://github.com/stanah/gh-gantt/issues/199)) ([a432cc6](https://github.com/stanah/gh-gantt/commit/a432cc68bfa84948520591a82ed504bf3b247eeb))
* **cli:** sprint task 移動コマンドを追加 ([#205](https://github.com/stanah/gh-gantt/issues/205)) ([0a2de91](https://github.com/stanah/gh-gantt/commit/0a2de91603aa7a3abd1e15c6abf16aec49ce71c5))
* **cli:** タスクサイズ閾値の警告を追加 ([#144](https://github.com/stanah/gh-gantt/issues/144)) ([#220](https://github.com/stanah/gh-gantt/issues/220)) ([0021cd3](https://github.com/stanah/gh-gantt/commit/0021cd34a1ae93c0979fe2353f37362bac854d51))
* **cli:** タスクテンプレートの受入基準スロットを追加 ([#141](https://github.com/stanah/gh-gantt/issues/141)) ([#217](https://github.com/stanah/gh-gantt/issues/217)) ([0ba32e2](https://github.com/stanah/gh-gantt/commit/0ba32e2b737a2cffdc97368952fb2060a3fefe68))
* **cli:** タスクの実装者とレビュアーを分離 ([#142](https://github.com/stanah/gh-gantt/issues/142)) ([#218](https://github.com/stanah/gh-gantt/issues/218)) ([daa3bb0](https://github.com/stanah/gh-gantt/commit/daa3bb0d0e574af8d0cd75c6624d779000e7cd36))
* **cli:** レビュー必須フラグを追加 ([#143](https://github.com/stanah/gh-gantt/issues/143)) ([#219](https://github.com/stanah/gh-gantt/issues/219)) ([35464e7](https://github.com/stanah/gh-gantt/commit/35464e74a59b473e4adca8d9cc42b2dca11870ad))
* **cli:** 受入基準を first-class 化 ([#138](https://github.com/stanah/gh-gantt/issues/138)) ([#216](https://github.com/stanah/gh-gantt/issues/216)) ([10c59ee](https://github.com/stanah/gh-gantt/commit/10c59ee3bbeb4c5b3558dfc3ec48303fbf596dca))
* **export:** SVG/PNGエクスポートを追加 ([#20](https://github.com/stanah/gh-gantt/issues/20)) ([#231](https://github.com/stanah/gh-gantt/issues/231)) ([ded8bb3](https://github.com/stanah/gh-gantt/commit/ded8bb3929fd54671ead9b389bb66e7c04a9abeb))
* priority 表示・フィルタ & ドラッグ undo バグ修正 ([#62](https://github.com/stanah/gh-gantt/issues/62)) ([6e54598](https://github.com/stanah/gh-gantt/commit/6e54598c533529be5ba1fe8ea740bf7efaec65fd))
* scaffold monorepo with shared, cli, and ui packages ([41f9140](https://github.com/stanah/gh-gantt/commit/41f91400b3f9a74a23c1b957ac73cc2c0589dd2b))
* sync engine fixes, drag-drop dependencies, markdown rendering ([#35](https://github.com/stanah/gh-gantt/issues/35)) ([9b75c54](https://github.com/stanah/gh-gantt/commit/9b75c54b7b8520d03ea05733d118e7b890fd3e57))
* sync engine improvements, UI enhancements, and push safety ([#32](https://github.com/stanah/gh-gantt/issues/32)) ([4788bfb](https://github.com/stanah/gh-gantt/commit/4788bfb7d3a891992a26be8966bd6e1a1ba902a6))
* sync engine redesign with git-model 3-way merge ([#34](https://github.com/stanah/gh-gantt/issues/34)) ([bf6a4af](https://github.com/stanah/gh-gantt/commit/bf6a4af682a38aaf033886bb7432d2957ae5343a))
* **sync:** pull の GraphQL pre-check モードを追加 ([#157](https://github.com/stanah/gh-gantt/issues/157)) ([#158](https://github.com/stanah/gh-gantt/issues/158)) ([ad84be4](https://github.com/stanah/gh-gantt/commit/ad84be4452b21f38ca30173be329c98dc81420c0))
* task list フィルタ・ソートオプション追加 ([#61](https://github.com/stanah/gh-gantt/issues/61)) ([2a8447d](https://github.com/stanah/gh-gantt/commit/2a8447d75e789d053c558c65465ab116daf9c4e3))
* task update に --body オプションを追加 ([#40](https://github.com/stanah/gh-gantt/issues/40)) ([#41](https://github.com/stanah/gh-gantt/issues/41)) ([a82fccd](https://github.com/stanah/gh-gantt/commit/a82fccd704b54099b67f78926232da666ea3e9e9))
* **ui:** Linked PR のタイトル表示を追加 ([#101](https://github.com/stanah/gh-gantt/issues/101)) ([2dd6e36](https://github.com/stanah/gh-gantt/commit/2dd6e3680fa63a5eba7889bdf2f5554ec9939571))
* **ui:** sprint 移動 UI を追加 ([#207](https://github.com/stanah/gh-gantt/issues/207)) ([739b58a](https://github.com/stanah/gh-gantt/commit/739b58a7a23dacd111faf3f375015095f98bfa1e))
* **ui:** 遅延タスクの自動ハイライトを設定化 ([#19](https://github.com/stanah/gh-gantt/issues/19)) ([#230](https://github.com/stanah/gh-gantt/issues/230)) ([556b97b](https://github.com/stanah/gh-gantt/commit/556b97be5be44a180b30482978d41a14c9cde647))
* Vite Plus 対応（全パッケージ統合） ([#64](https://github.com/stanah/gh-gantt/issues/64)) ([55df9a6](https://github.com/stanah/gh-gantt/commit/55df9a62c5aa0a41b98e7f981f7f2890169ffadd))
* **workflow:** PRレビューサイクルを標準化 ([#174](https://github.com/stanah/gh-gantt/issues/174)) ([#192](https://github.com/stanah/gh-gantt/issues/192)) ([3e539d7](https://github.com/stanah/gh-gantt/commit/3e539d727f3868164ca316eb4cc775ffbc5d3349))
* フィルタツールバー UX 改善 ([#65](https://github.com/stanah/gh-gantt/issues/65)) ([410d3f7](https://github.com/stanah/gh-gantt/commit/410d3f7bd379de128441b1789a392cd682efe387))


### Bug Fixes

* **ci:** lint 対象を tracked file に限定 ([#200](https://github.com/stanah/gh-gantt/issues/200)) ([da2b609](https://github.com/stanah/gh-gantt/commit/da2b6095117de2e3374800408264f9f4369df0d4))
* **cli:** Organization Issue Type の同期を修正 ([#186](https://github.com/stanah/gh-gantt/issues/186)) ([f682bdd](https://github.com/stanah/gh-gantt/commit/f682bdd5002e5fad637149751b8af045b525d5ae))
* **cli:** push 時の partial failure で snapshot が不整合になる問題を修正 ([#129](https://github.com/stanah/gh-gantt/issues/129)) ([#131](https://github.com/stanah/gh-gantt/issues/131)) ([73ae20c](https://github.com/stanah/gh-gantt/commit/73ae20c63a7ff05eae71ddc6480ffb2701291b7a))
* **cli:** push/pull 同期バグ修正 & テスト拡充 ([#126](https://github.com/stanah/gh-gantt/issues/126)) ([76dc5be](https://github.com/stanah/gh-gantt/commit/76dc5be55bf65ee5bca36e31afe41d9f5becd619))
* **cli:** status の remote_changed 誤検出を修正 ([#197](https://github.com/stanah/gh-gantt/issues/197)) ([a924412](https://github.com/stanah/gh-gantt/commit/a924412fa88baeab34cb93b2e433eef2caec64a3))
* conflicts/resolve の [object Object] 表示を修正 ([#113](https://github.com/stanah/gh-gantt/issues/113)) ([2ddbd1e](https://github.com/stanah/gh-gantt/commit/2ddbd1e8fc5d3abb962dc5999e1c0a98b4eb0091))
* **lint:** init.ts の no-useless-fallback-in-spread 警告を修正 ([#150](https://github.com/stanah/gh-gantt/issues/150)) ([c0a8737](https://github.com/stanah/gh-gantt/commit/c0a87377836d914c1855922ce32b99dd306bbcc7))
* list --type milestone が config 未定義時にエラーになる問題を修正 ([#77](https://github.com/stanah/gh-gantt/issues/77)) ([970a524](https://github.com/stanah/gh-gantt/commit/970a524eac55e3595b08daf1c21b4bc6da6e547b))
* resolve multiple UI and sync issues found during integration testing ([eb25a87](https://github.com/stanah/gh-gantt/commit/eb25a8722545df8003088b0cf215396185642724))
* **resolve:** update snapshot.hash when all conflicts resolved with --theirs ([#154](https://github.com/stanah/gh-gantt/issues/154)) ([1449fc5](https://github.com/stanah/gh-gantt/commit/1449fc52239b304343974686f07f5f09a6772a89))
* show コマンドに try/catch エラーハンドリングを追加 ([#76](https://github.com/stanah/gh-gantt/issues/76)) ([6a63ec1](https://github.com/stanah/gh-gantt/commit/6a63ec10fa531778a53e6e5a2b52aaf5b8106628))
* **sync:** close 後のメタデータを再取得する ([#213](https://github.com/stanah/gh-gantt/issues/213)) ([#214](https://github.com/stanah/gh-gantt/issues/214)) ([ff02c29](https://github.com/stanah/gh-gantt/commit/ff02c298476f4334e7b5426b6a23a343ad909183))
* **sync:** issue_node_id 欠損時の sub-issue/blocked-by サイレントスキップを修正 ([#153](https://github.com/stanah/gh-gantt/issues/153)) ([de41832](https://github.com/stanah/gh-gantt/commit/de41832cf8714f6cf82636c2648f1aba793a0942))
* **sync:** pull で id_map を authoritative に rebuild する ([#168](https://github.com/stanah/gh-gantt/issues/168)) ([c1535a9](https://github.com/stanah/gh-gantt/commit/c1535a94970928f5e3ec9fae0f7fdc1b86ae2458))
* **sync:** pull のハッシュ一致パスで snapshot.updated_at を refresh する ([#170](https://github.com/stanah/gh-gantt/issues/170)) ([759f6c7](https://github.com/stanah/gh-gantt/commit/759f6c7263bdc3e996550f2a21e4b261a8621e89))
* **sync:** skip non-Issue project items (PullRequest, DraftIssue) ([#159](https://github.com/stanah/gh-gantt/issues/159)) ([e9ce612](https://github.com/stanah/gh-gantt/commit/e9ce6120b2bb28262dab3a2c917c43161ae8dc50))
* **sync:** sub-issue 設定時の Priority 衝突エラーを解消 ([#146](https://github.com/stanah/gh-gantt/issues/146)) ([#148](https://github.com/stanah/gh-gantt/issues/148)) ([ea87af3](https://github.com/stanah/gh-gantt/commit/ea87af3dea052d5eb05c71efc0c2754771b60c98))
* **sync:** sync-state の整合性検証と pull --force を追加 ([#123](https://github.com/stanah/gh-gantt/issues/123)) ([#149](https://github.com/stanah/gh-gantt/issues/149)) ([f9f0f4b](https://github.com/stanah/gh-gantt/commit/f9f0f4badc56abb77b559a007c22ce3e6651fb2a))
* **sync:** 設定変更後の pull でローカル変更が消失する問題を修正 ([#96](https://github.com/stanah/gh-gantt/issues/96)) ([1991124](https://github.com/stanah/gh-gantt/commit/19911240d3c620d41865fa0e3a20b29a729f0c47))
* task update --type のラベル同期と status の誤検出を修正 ([#39](https://github.com/stanah/gh-gantt/issues/39)) ([877b2f9](https://github.com/stanah/gh-gantt/commit/877b2f91930c731849b2b7862ad1d660d0d94f48))


### Performance Improvements

* **cli:** 同期エンジンの API アクセス最適化 ([#128](https://github.com/stanah/gh-gantt/issues/128)) ([#130](https://github.com/stanah/gh-gantt/issues/130)) ([c741c2f](https://github.com/stanah/gh-gantt/commit/c741c2fbb254ebe4ae8612582949230ad037951f))
