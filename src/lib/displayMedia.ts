import { isDisplayMediaUserCancellation } from "./userMediaError";

/** True when running inside Electron (dev or packaged). */
function isElectronRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron
  );
}

/**
 * Chromium: avoid offering the **current browser tab/window** in the share picker so users
 * don’t capture DreamWork itself (infinite mirror + whiteboard inside “Capture Screen”).
 * Older engines ignore unknown keys; we retry without hints if the call fails for other reasons.
 */
type DisplayMediaWithSurfaceHints = DisplayMediaStreamOptions & {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
};

function displayMediaOpts(
  wantAudio: boolean,
  hints: boolean
): DisplayMediaStreamOptions {
  const base: DisplayMediaWithSurfaceHints = { video: true, audio: wantAudio };
  if (hints) {
    base.preferCurrentTab = false;
    base.selfBrowserSurface = "exclude";
  }
  return base;
}

/**
 * Screen capture for DreamWorks.
 *
 * On **Electron**, request **video without display audio first**, then retry with `audio: true` if
 * needed — avoids **Not supported** on some macOS/Chromium paths. (Main process does not set
 * `useSystemPicker`; that combination broke `getDisplayMedia` entirely in testing.)
 *
 * In a normal **browser**, one call with `wantAudio` is enough.
 */
export async function getDisplayMediaForScreenCapture(wantAudio: boolean): Promise<MediaStream> {
  const gdm = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

  const withHintsFallback = async (audio: boolean): Promise<MediaStream> => {
    try {
      return await gdm(displayMediaOpts(audio, true));
    } catch (e) {
      if (isDisplayMediaUserCancellation(e)) throw e;
      return await gdm(displayMediaOpts(audio, false));
    }
  };

  if (!isElectronRuntime()) {
    return withHintsFallback(wantAudio);
  }

  try {
    return await withHintsFallback(false);
  } catch (e) {
    if (isDisplayMediaUserCancellation(e)) throw e;
    if (!wantAudio) throw e;
  }

  return withHintsFallback(true);
}
