export interface BeautySettings {
  skinSmoothing: number;
  brighten: number;
  glow: number;
  whiten: number;
  contrast: number;
  saturation: number;
}

export const defaultBeautySettings: BeautySettings = {
  skinSmoothing: 0,
  brighten: 0,
  glow: 0,
  whiten: 0,
  contrast: 0,
  saturation: 0,
};

export const presets: Record<string, BeautySettings> = {
  natural: {
    skinSmoothing: 15,
    brighten: 8,
    glow: 5,
    whiten: 5,
    contrast: 2,
    saturation: 3,
  },
  professional: {
    skinSmoothing: 25,
    brighten: 12,
    glow: 10,
    whiten: 10,
    contrast: 5,
    saturation: 5,
  },
  glamour: {
    skinSmoothing: 40,
    brighten: 20,
    glow: 25,
    whiten: 20,
    contrast: 8,
    saturation: 15,
  },
  minimal: {
    skinSmoothing: 5,
    brighten: 3,
    glow: 2,
    whiten: 2,
    contrast: 0,
    saturation: 2,
  },
};

/** Find preset name closest to current settings (for Select display when user has adjusted sliders) */
export function closestPresetName(settings: BeautySettings): string {
  const keys = Object.keys(presets.natural) as (keyof BeautySettings)[];
  let best = "natural";
  let bestDist = Infinity;
  for (const [name, preset] of Object.entries(presets)) {
    const dist = keys.reduce((sum, k) => sum + Math.abs((settings[k] ?? 0) - (preset[k] ?? 0)), 0);
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

export function beautySettingsToFilter(s: BeautySettings): string {
  const brightness = 1 + (s.brighten / 100) * 0.35 + (s.glow / 100) * 0.15;
  const contrast = 1 + (s.contrast / 100) * 0.2 - (s.skinSmoothing / 100) * 0.08;
  const saturate = 1 + (s.saturation / 100) * 0.2 - (s.whiten / 100) * 0.15;
  const blur = (s.skinSmoothing / 100) * 0.6;
  const parts = [
    `brightness(${brightness.toFixed(2)})`,
    `contrast(${contrast.toFixed(2)})`,
    `saturate(${saturate.toFixed(2)})`,
  ];
  if (blur > 0.05) parts.push(`blur(${blur.toFixed(2)}px)`);
  return parts.join(" ");
}
