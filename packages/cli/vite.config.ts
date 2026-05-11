import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: false,
    fixedExtension: false,
    deps: {
      // workspace 内の @gh-gantt/* は npm publish 時に外部依存にできない（private）ため bundle する
      alwaysBundle: [/^@gh-gantt\//],
      neverBundle: [
        /^@playwright\/test$/,
        /^playwright$/,
        /^playwright-core$/,
        /^playwright\//,
        /^playwright-core\//,
        /^chromium-bidi\//,
        /^fsevents$/,
      ],
    },
  },
});
