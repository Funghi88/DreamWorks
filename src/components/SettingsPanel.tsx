import { GlassButton } from "@/components/Glass";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RecordResolution, LetterboxBackground } from "@/lib/storage";
import type { BeautySettings } from "@/lib/beautyEffects";
import { presets } from "@/lib/beautyEffects";
import type { FaceFilterType } from "@/lib/faceFilters";
export type AvatarShape = "circle" | "rect";
export type AvatarDecor = "none" | "simple" | "glow" | "dashed";

interface SettingsPanelProps {
  avatarSize: number;
  onAvatarSizeChange: (v: number) => void;
  avatarShape: AvatarShape;
  onAvatarShapeChange: (v: AvatarShape) => void;
  avatarDecor: AvatarDecor;
  onAvatarDecorChange: (v: AvatarDecor) => void;
  glowColor: string;
  onGlowColorChange: (v: string) => void;
  avatarImageSrc: string | null;
  onUseImage: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClearImage: () => void;
  beautyMode?: boolean;
  onBeautyModeChange?: (v: boolean) => void;
  beautySettings?: BeautySettings;
  onBeautySettingsChange?: (v: BeautySettings) => void;
  micVolume: number;
  onMicVolumeChange: (v: number) => void;
  systemVolume: number;
  onSystemVolumeChange: (v: number) => void;
  recordResolution?: RecordResolution;
  onRecordResolutionChange?: (v: RecordResolution) => void;
  letterboxBackground?: LetterboxBackground;
  onLetterboxBackgroundChange?: (v: LetterboxBackground) => void;
  letterboxCustomImage?: string | null;
  onLetterboxCustomImageChange?: (v: string | null) => void;
  faceFilter?: FaceFilterType;
  onFaceFilterChange?: (v: FaceFilterType) => void;
}

export function SettingsPanel({
  avatarSize,
  onAvatarSizeChange,
  avatarShape,
  onAvatarShapeChange,
  avatarDecor,
  onAvatarDecorChange,
  glowColor,
  onGlowColorChange,
  avatarImageSrc,
  onUseImage,
  onClearImage,
  beautyMode = false,
  onBeautyModeChange,
  beautySettings,
  onBeautySettingsChange,
  micVolume,
  onMicVolumeChange,
  systemVolume,
  onSystemVolumeChange,
  recordResolution,
  onRecordResolutionChange,
  letterboxBackground,
  onLetterboxBackgroundChange,
  letterboxCustomImage,
  onLetterboxCustomImageChange,
  faceFilter = "none",
  onFaceFilterChange,
}: SettingsPanelProps) {
  return (
    <div className="flex flex-col gap-4 text-slate-900">
      <div className="space-y-3">
        <span className="text-sm font-medium text-slate-900">Video</span>
        <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="w-14 text-sm">Size</span>
          <Slider
            value={[avatarSize]}
            onValueChange={([v]) => onAvatarSizeChange(v ?? 120)}
            min={32}
            max={280}
            step={4}
            className="flex-1 min-w-0"
          />
          <span className="w-10 text-sm tabular-nums shrink-0">{avatarSize}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-14 text-sm">Shape</span>
          <GlassButton
            variant={avatarShape === "circle" ? "primary" : "secondary"}
            size="sm"
            onClick={() => onAvatarShapeChange("circle")}
          >
            Circle
          </GlassButton>
          <GlassButton
            variant={avatarShape === "rect" ? "primary" : "secondary"}
            size="sm"
            onClick={() => onAvatarShapeChange("rect")}
          >
            Landscape
          </GlassButton>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-14 text-sm">Decor</span>
          <Select
            value={avatarDecor}
            onValueChange={(v) => onAvatarDecorChange(v as AvatarDecor)}
          >
            <SelectTrigger className="w-28 border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top" className="z-[100000] border-slate-200 bg-white">
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="simple">Simple</SelectItem>
              <SelectItem value="glow">Glow</SelectItem>
              <SelectItem value="dashed">Dashed</SelectItem>
            </SelectContent>
          </Select>
          {avatarDecor === "glow" && (
            <input
              type="color"
              value={glowColor}
              onChange={(e) => onGlowColorChange(e.target.value)}
              className="h-7 w-7 cursor-pointer rounded-md border border-input"
            />
          )}
        </div>
        {onFaceFilterChange != null && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="w-14 text-sm">Effect</span>
              <Select
                value={faceFilter}
                onValueChange={(v) => onFaceFilterChange(v as FaceFilterType)}
              >
                <SelectTrigger className="w-28 border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent side="top" className="z-[100000] border-slate-200 bg-white">
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="sunglasses">Sunglasses</SelectItem>
                  <SelectItem value="vampire">🐞</SelectItem>
                  <SelectItem value="heart">🩷</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        {onBeautyModeChange != null && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="w-14 text-sm">Beauty</span>
              <GlassButton
                variant={beautyMode ? "primary" : "secondary"}
                size="sm"
                onClick={() => onBeautyModeChange(!beautyMode)}
              >
                {beautyMode ? "On" : "Off"}
              </GlassButton>
              {beautyMode && onBeautySettingsChange && beautySettings && (
                <Select
                  value={Object.entries(presets).find(([, v]) =>
                    JSON.stringify(v) === JSON.stringify(beautySettings)
                  )?.[0] ?? "natural"}
                  onValueChange={(v) => onBeautySettingsChange(presets[v] ?? presets.natural)}
                >
                  <SelectTrigger className="w-24 border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent side="top" className="z-[100000] border-slate-200 bg-white">
                    <SelectItem value="natural">Natural</SelectItem>
                    <SelectItem value="professional">Pro</SelectItem>
                    <SelectItem value="glamour">Glamour</SelectItem>
                    <SelectItem value="minimal">Minimal</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            {beautyMode && onBeautySettingsChange && beautySettings && (
              <div className="flex flex-col gap-1.5 pl-0">
                {(["skinSmoothing", "brighten", "glow", "whiten", "contrast", "saturation"] as const).map((key) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="w-14 text-xs text-slate-600">
                      {key === "skinSmoothing" ? "Smooth" : key === "brighten" ? "Bright" : key === "glow" ? "Glow" : key === "whiten" ? "White" : key === "contrast" ? "Contrast" : "Sat"}
                    </span>
                    <Slider
                      value={[beautySettings[key]]}
                      onValueChange={([v]) => onBeautySettingsChange({ ...beautySettings, [key]: v ?? 0 })}
                      min={0}
                      max={100}
                      className="flex-1"
                    />
                    <span className="w-6 text-xs tabular-nums">{beautySettings[key]}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {recordResolution != null && onRecordResolutionChange && (
          <div className="flex items-center gap-2">
            <span className="w-14 text-sm">Res</span>
            <Select
              value={recordResolution}
              onValueChange={(v) => onRecordResolutionChange(v as RecordResolution)}
            >
              <SelectTrigger className="w-24 border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900">
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top" className="z-[100000] border-slate-200 bg-white">
                <SelectItem value="1080p">1080p</SelectItem>
                <SelectItem value="2K">2K</SelectItem>
                <SelectItem value="4K">4K</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {letterboxBackground != null && onLetterboxBackgroundChange && (
          <div className="flex items-center gap-2">
            <span className="w-14 text-sm">Bg</span>
            <Select
              value={letterboxBackground}
              onValueChange={(v) => onLetterboxBackgroundChange(v as LetterboxBackground)}
            >
              <SelectTrigger className="w-28 border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900">
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top" className="z-[100000] border-slate-200 bg-white">
                <SelectItem value="black">Black</SelectItem>
                <SelectItem value="custom">Upload image</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {onLetterboxCustomImageChange && onLetterboxBackgroundChange && (
          <div className="flex items-center gap-2">
            <span className="w-14 text-sm">Custom</span>
            <label className="cursor-pointer text-xs text-slate-600 hover:text-slate-900">
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    const r = new FileReader();
                    r.onload = () => {
                      onLetterboxCustomImageChange(r.result as string);
                      onLetterboxBackgroundChange("custom");
                    };
                    r.readAsDataURL(f);
                  }
                  e.target.value = "";
                }}
              />
              Upload bg
            </label>
            {letterboxCustomImage && (
              <button
                type="button"
                className="text-xs text-slate-600 hover:text-slate-900"
                onClick={() => onLetterboxCustomImageChange(null)}
              >
                Clear
              </button>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="w-14 text-sm">Source</span>
          <label className="cursor-pointer">
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onUseImage}
            />
            <span className="inline-flex h-8 cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-900 hover:bg-slate-100">
              Use image
            </span>
          </label>
          {avatarImageSrc && (
            <GlassButton variant="ghost" size="sm" onClick={onClearImage}>
              Clear image
            </GlassButton>
          )}
        </div>
        </div>
      </div>
      <div className="space-y-3">
        <span className="text-sm font-medium text-slate-900">Audio</span>
        <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="w-14 text-sm">Mic</span>
          <Slider
            value={[micVolume]}
            onValueChange={([v]) => onMicVolumeChange(v ?? 100)}
            min={0}
            max={100}
            className="flex-1"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-14 text-sm">System</span>
          <Slider
            value={[systemVolume]}
            onValueChange={([v]) => onSystemVolumeChange(v ?? 80)}
            min={0}
            max={100}
            className="flex-1"
          />
        </div>
        </div>
      </div>
    </div>
  );
}
