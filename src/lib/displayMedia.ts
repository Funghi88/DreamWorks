/** Prefer full display (monitor); fall back if the runtime rejects the constraint. */
export async function getDisplayMediaPreferMonitor(audio: boolean): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "monitor" },
      audio,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "OverconstrainedError") {
      return navigator.mediaDevices.getDisplayMedia({ video: true, audio });
    }
    throw e;
  }
}
