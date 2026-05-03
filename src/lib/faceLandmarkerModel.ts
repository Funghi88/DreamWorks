/**
 * WASM is served from `public/mediapipe-wasm/` (see `scripts/sync-mediapipe-wasm.cjs`).
 * Avoids `import ... from 'node_modules/...?url'` which can break Vite 7 dependency optimization (blank window).
 */
const WASM_REL = `${import.meta.env.BASE_URL}mediapipe-wasm/`;

/**
 * Main window: resolve against the document URL (correct for dev, Electron http, and file://).
 * Dedicated Worker: must NOT use `self.location.href` as the base — that is the worker script path
 * (e.g. …/dist/assets/worker.js), so `mediapipe-wasm` would wrongly nest under `assets/`.
 * Use same-origin + path, or `file://…/dist/` for packaged Electron.
 */
function resolveVisionWasmDirUrl(): string {
  if (typeof window !== "undefined" && window.location?.href) {
    return new URL(WASM_REL, window.location.href).href;
  }
  if (typeof self !== "undefined" && self.location) {
    const origin = self.location.origin;
    if (origin && origin !== "null") {
      return new URL(WASM_REL, `${origin}/`).href;
    }
    const href = self.location.href;
    const fileDist = href.match(/^(file:\/.*\/dist)\//);
    if (fileDist) {
      return `${fileDist[1]}/mediapipe-wasm/`;
    }
    return new URL(WASM_REL, href).href;
  }
  return new URL(WASM_REL, "http://127.0.0.1/").href;
}

/** Shared by face landmark worker and main-thread fallback */
export const FACE_LANDMARKER_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/** Directory URL for vision WASM (FilesetResolver loads sibling `.wasm` next to the loader script). */
export const MEDIAPIPE_VISION_WASM_URL = resolveVisionWasmDirUrl();
