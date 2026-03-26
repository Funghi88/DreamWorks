/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  base: "./",
  assetsInclude: ["**/*.wasm"],
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
