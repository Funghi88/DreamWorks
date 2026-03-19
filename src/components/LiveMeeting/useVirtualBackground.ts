import { useState } from "react";

export type BackgroundMode = "none" | "blur" | "color" | "image";

export function useVirtualBackground() {
  const [mode, setMode] = useState<BackgroundMode>("none");
  const [color, setColor] = useState("#1e293b");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  return { mode, setMode, color, setColor, imageUrl, setImageUrl };
}
