import { isDisplayMediaUserCancellation } from "./userMediaError";

/** True when running inside Electron (dev or packaged). */
function isElectronRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron
  );
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

  if (!isElectronRuntime()) {
    return gdm({ video: true, audio: wantAudio });
  }

  try {
    const stream = await gdm({ video: true, audio: false });
    return stream;
  } catch (e) {
    if (isDisplayMediaUserCancellation(e)) throw e;
    if (!wantAudio) throw e;
  }

  try {
    const stream2 = await gdm({ video: true, audio: true });
    return stream2;
  } catch (e2) {
    throw e2;
  }
}
