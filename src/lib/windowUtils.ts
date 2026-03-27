export async function setCompactMode(
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top-center",
  width: number,
  height: number
) {
  try {
    const api = (window as unknown as { electronAPI?: { setCompactMode: (p: string, w: number, h: number) => Promise<void> } }).electronAPI;
    if (api?.setCompactMode) {
      await api.setCompactMode(position, width, height);
    }
  } catch {
    /* Electron not available (e.g. browser dev) */
  }
}

export async function setNormalMode() {
  try {
    const api = (window as unknown as { electronAPI?: { setNormalMode: () => Promise<void> } }).electronAPI;
    if (api?.setNormalMode) {
      await api.setNormalMode();
    }
  } catch {
    /* Electron not available */
  }
}

/** `false` = do not throttle timers/rAF when the window is in the background (needed for recording while using the shared window). */
export async function setBackgroundThrottling(throttlingEnabled: boolean) {
  try {
    const api = (window as unknown as {
      electronAPI?: { setBackgroundThrottling?: (v: boolean) => Promise<void> };
    }).electronAPI;
    await api?.setBackgroundThrottling?.(throttlingEnabled);
  } catch {
    /* Electron not available */
  }
}
