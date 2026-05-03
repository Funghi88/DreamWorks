/**
 * Chromium suspends AudioContext unless it is created (and resumed) during a user gesture.
 * Follow mode turned on from useEffect runs too late; we prime a context on the Follow click
 * and the hook consumes it when wiring getUserMedia → ScriptProcessor.
 */

let stashedCtx: AudioContext | null = null;

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
    null
  );
}

/** Call synchronously from the Follow button before setting follow mode on. */
export function primeTeleprompterFollowAudioFromUserGesture(): void {
  abandonStashedTeleprompterFollowAudioContext();
  const AC = getAudioContextCtor();
  if (!AC) return;
  const ctx = new AC();
  void ctx.resume();
  stashedCtx = ctx;
}

export function abandonStashedTeleprompterFollowAudioContext(): void {
  try {
    void stashedCtx?.close();
  } catch {
    /* ignore */
  }
  stashedCtx = null;
}

/** Hook takes ownership; stash must be empty after this. */
export function takeTeleprompterFollowAudioContext(): AudioContext | null {
  const c = stashedCtx;
  stashedCtx = null;
  return c;
}

export function handleTeleprompterFollowToggle(
  followMode: boolean,
  onSetFollowMode: (on: boolean) => void
): void {
  const next = !followMode;
  if (next) primeTeleprompterFollowAudioFromUserGesture();
  else abandonStashedTeleprompterFollowAudioContext();
  onSetFollowMode(next);
}
