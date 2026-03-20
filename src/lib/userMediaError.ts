/** User dismissed the capture UI or denied the prompt (NotAllowedError / AbortError). Used to avoid showing a harsh error for a normal cancel. */
export function isDisplayMediaUserCancellation(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const name = (err as DOMException).name;
  return name === "NotAllowedError" || name === "AbortError";
}
