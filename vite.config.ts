/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        teleprompterHelper: path.resolve(__dirname, "teleprompter-helper.html"),
        teleprompterSlim: path.resolve(__dirname, "teleprompter-slim.html"),
      },
    },
  },
  /** ESM workers + `type: "module"` so the bundle has valid top-level `import` (classic workers forbid it). `mediapipeWorkerImportShim` maps `self.import` → dynamic `import()`. */
  worker: { format: "es" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  base: "./",
  assetsInclude: ["**/*.wasm"],
  /**
   * Pre-bundling `@mediapipe/tasks-vision` breaks on Vite 7 (`Cannot read properties of undefined (reading 'imports')`)
   * and takes down the whole dev optimizer → white screen. Load the package as native ESM instead.
   */
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "@mediapipe/tasks-vision"],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
