import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: false,
    fixedExtension: false,
    deps: {
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
