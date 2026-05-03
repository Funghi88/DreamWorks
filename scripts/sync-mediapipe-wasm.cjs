/**
 * Copy MediaPipe vision WASM into public/ so Vite dev never pre-bundles `node_modules/...?url`
 * (Vite 7 can crash the optimizer → blank Electron window).
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const destDir = path.join(root, "public", "mediapipe-wasm");

if (!fs.existsSync(srcDir)) {
  console.warn("[sync-mediapipe-wasm] skip: node_modules/@mediapipe/tasks-vision/wasm not found");
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });
for (const name of fs.readdirSync(srcDir)) {
  fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
}
console.log("[sync-mediapipe-wasm] copied to public/mediapipe-wasm/");
