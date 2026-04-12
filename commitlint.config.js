// @ts-check

// Conventional Commits 規約を commitlint で強制する (ADR-009)
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // リリースノートや長い説明を許容するため、body/footer の行長制限を無効化
    "body-max-line-length": [0, "always"],
    "footer-max-line-length": [0, "always"],
  },
};
