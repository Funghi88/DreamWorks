/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_SNAP_CAMERA_KIT?: string;
  readonly VITE_SNAP_API_TOKEN?: string;
  readonly VITE_SNAP_LENS_ID?: string;
  readonly VITE_SNAP_LENS_GROUP_ID?: string;
  /** `true` → console logs for Vosk follow pipeline (queue, feed ms, advance interval). */
  readonly VITE_TELEPROMPTER_FOLLOW_LATENCY_PROFILE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
