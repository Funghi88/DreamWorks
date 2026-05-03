/**
 * OSS / DISTRIBUTION COMPLIANCE — SNAP CAMERA KIT
 *
 * If this repository or a derived product is **publicly distributed** (open source release,
 * app store build for general users, etc.), you MUST re-evaluate:
 * - Snap Inc. Camera Kit / Lens Studio license terms and attribution requirements
 * - Whether this integration may remain bundled or must be removed / replaced
 *
 * The env-gated integration below is intended for **private / self-use** builds unless
 * compliance has been explicitly cleared.
 */

export const SNAP_CAMERA_KIT_ENABLED =
  import.meta.env.VITE_ENABLE_SNAP_CAMERA_KIT === "true";

export function snapCameraKitEnvConfigured(): boolean {
  const token = import.meta.env.VITE_SNAP_API_TOKEN;
  const lensId = import.meta.env.VITE_SNAP_LENS_ID;
  const groupId = import.meta.env.VITE_SNAP_LENS_GROUP_ID;
  return (
    SNAP_CAMERA_KIT_ENABLED &&
    typeof token === "string" &&
    token.length > 0 &&
    typeof lensId === "string" &&
    lensId.length > 0 &&
    typeof groupId === "string" &&
    groupId.length > 0
  );
}

export function getSnapCameraKitConfig(): {
  apiToken: string;
  lensId: string;
  lensGroupId: string;
} | null {
  if (!snapCameraKitEnvConfigured()) return null;
  return {
    apiToken: import.meta.env.VITE_SNAP_API_TOKEN as string,
    lensId: import.meta.env.VITE_SNAP_LENS_ID as string,
    lensGroupId: import.meta.env.VITE_SNAP_LENS_GROUP_ID as string,
  };
}

export type PipEffectBackend = "mediapipe" | "snap";

/**
 * Console: voskFeed IPC ms (rolling avg), PCM queue depth, ms between readChars advances.
 * Set `VITE_TELEPROMPTER_FOLLOW_LATENCY_PROFILE=true` in `.env` / env.
 */
export const TELEPROMPTER_FOLLOW_LATENCY_PROFILE =
  import.meta.env.VITE_TELEPROMPTER_FOLLOW_LATENCY_PROFILE === "true";
