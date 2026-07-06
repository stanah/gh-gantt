import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ["src/__tests__/setup.ts"],
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
