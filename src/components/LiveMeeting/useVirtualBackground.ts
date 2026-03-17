import { useState } from "react";

export type BackgroundMode = "none" | "blur" | "color";

export function useVirtualBackground() {
  const [mode, setMode] = useState<BackgroundMode>("none");
  const [color, setColor] = useState("#1e293b");
  return { mode, setMode, color, setColor };
}
