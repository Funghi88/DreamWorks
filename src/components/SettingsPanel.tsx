import { GlassButton } from "@/components/Glass";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RecordResolution, LetterboxBackground, LetterboxMode } from "@/lib/storage";
import type { BeautySettings } from "@/lib/beautyEffects";
import { presets, closestPresetName } from "@/lib/beautyEffects";
import type { FaceFilterType } from "@/lib/faceFilters";
export type AvatarShape = "circle" | "rect" | "portrait";
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
  /** 80–100: Share window / whiteboard record area vs frame; higher = sharper, less margin. */
  shareWindowFillPercent?: number;
  onShareWindowFillPercentChange?: (v: number) => void;
  letterboxBackground?: LetterboxBackground;
  onLetterboxBackgroundChange?: (v: LetterboxBackground) => void;
  letterboxCustomImage?: string | null;
  onLetterboxCustomImageChange?: (v: string | null) => void;
  letterboxMode?: LetterboxMode;
  onLetterboxModeChange?: (v: LetterboxMode) => void;
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
  shareWindowFillPercent,
  onShareWindowFillPercentChange,
  letterboxBackground,
  onLetterboxBackgroundChange,
  letterboxCustomImage,
  onLetterboxCustomImageChange,
  letterboxMode = "fit",
  onLetterboxModeChange,
  faceFilter = "none",
  onFaceFilterChange,
}: SettingsPanelProps) {
  const labelWidth = "w-16";
  const sectionGap = "gap-5";
  return (
    <div className={`flex flex-col ${sectionGap} text-slate-900`}>
      <div className="flex flex-col gap-4">
        <h3 className="text-base font-semibold text-slate-900 tracking-tight">Video</h3>
        <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className={`${labelWidth} shrink-0 text-xs font-medium text-slate-600 uppercase tracking-wider`}>Size</span>
          <Slider
            value={[avatarSize]}
            onValueChange={([v]) => onAvatarSizeChange(v ?? 120)}
            min={32}
            max={400}
            step={4}
            className="flex-1 min-w-0"
          />
          <span className="w-10 text-sm tabular-nums shrink-0">{avatarSize}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`${labelWidth} shrink-0 text-xs font-medium text-slate-600 uppercase tracking-wider`}>Shape</span>
          <div className="flex flex-wrap gap-2 flex-1 min-w-0">
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
          <GlassButton
            variant={avatarShape === "portrait" ? "primary" : "secondary"}
            size="sm"
            onClick={() => onAvatarShapeChange("portrait")}
          >
            Portrait
          </GlassButton>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`${labelWidth} shrink-0 text-xs font-medium text-slate-600 uppercase tracking-wider`}>Decor</span>
          <Select
            value={avatarDecor}
            onValueChange={(v) => onAvatarDecorChange(v as AvatarDecor)}
          >
            <SelectTrigger className="min-w-[7rem] flex-1 border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top" className="z-[1000001] border-slate-200 bg-white">
              <SelectItem value="none">Black border</SelectItem>
              <SelectItem value="simple">Simple</SelectItem>
              <SelectItem value="glow">Glow</SelectItem>
              <SelectItem value="dashed">Dashed</SelectItem>
            </SelectContent>
          </Select>
          {avatarDecor === "glow" && (
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={glowColor}
                onChange={(e) => onGlowColorChange(e.target.value)}
                className="h-7 w-7 cursor-pointer rounded-md border border-input"
                title="Glow color"
              />
              <span className="text-xs text-slate-500">Color</span>
            </div>
          )}
        </div>
        {onFaceFilterChange != null && (
          <div className="flex items-center gap-3">
            <span className={`${labelWidth} shrink-0 text-xs font-medium text-slate-600 uppercase tracking-wider`}>Effect</span>
            <Select
              value={faceFilter}
              onValueChange={(v) => onFaceFilterChange(v as FaceFilterType)}
            >
              <SelectTrigger className="min-w-[7rem] flex-1 border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent side="top" className="z-[1000001] border-slate-200 bg-white">
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="sunglasses">Sunglasses</SelectItem>
                  <SelectItem value="vampire">🐞</SelectItem>
                  <SelectItem value="heart">🩷</SelectItem>
                </SelectContent>
            </Select>
          </div>
        )}
        {onBeautyModeChange != null && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className={`${labelWidth} shrink-0 text-xs font-medium text-slate-600 uppercase tracking-wider`}>Beauty</span>
              <GlassButton
                variant={beautyMode ? "primary" : "secondary"}
                size="sm"
                onClick={() => onBeautyModeChange(!beautyMode)}
              >
                {beautyMode ? "On" : "Off"}
              </GlassButton>
              {beautyMode && onBeautySettingsChange && beautySettings && (
                <Select
                  value={closestPresetName(beautySettings)}
                  onValueChange={(v) => onBeautySettingsChange(presets[v] ?? presets.natural)}
                >
                  <SelectTrigger className="min-w-[6rem] border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent side="top" className="z-[1000001] border-slate-200 bg-white">
                    <SelectItem value="natural">Natural</SelectItem>
                    <SelectItem value="professional">Pro</SelectItem>
                    <SelectItem value="glamour">Glamour</SelectItem>
                    <SelectItem value="minimal">Minimal</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            {beautyMode && onBeautySettingsChange && beautySettings && (
              <div className="flex flex-col gap-2 pl-0">
                {(["skinSmoothing", "brighten", "glow", "whiten", "contrast", "saturation"] as const).map((key) => (
                  <div key={key} className="flex items-center gap-3">
                    <span className={`${labelWidth} shrink-0 text-xs text-slate-500`}>
                      {key === "skinSmoothing" ? "Smooth" : key === "brighten" ? "Bright" : key === "glow" ? "Glow" : key === "whiten" ? "White" : key === "contrast" ? "Contrast" : "Sat"}
                    </span>
                    <Slider
                      value={[beautySettings[key]]}
                      onValueChange={([v]) => onBeautySettingsChange({ ...beautySettings, [key]: v ?? 0 })}
                      min={0}
                      max={100}
                      className="flex-1"
                    />
                    <span className="w-7 shrink-0 text-xs tabular-nums text-slate-600">{beautySettings[key]}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {recordResolution != null && onRecordResolutionChange && (
          <div className="flex items-center gap-3">
            <span className={`${labelWidth} shrink-0 text-xs font-medium text-slate-600 uppercase tracking-wider`}>Res</span>
            <Select
              value={recordResolution}
              onValueChange={(v) => onRecordResolutionChange(v as RecordResolution)}
            >
              <SelectTrigger className="min-w-[5rem] border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900">
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top" className="z-[1000001] border-slate-200 bg-white">
                <SelectItem value="1080p">1080p</SelectItem>
                <SelectItem value="2K">2K</SelectItem>
                <SelectItem value="4K">4K</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {shareWindowFillPercent != null && onShareWindowFillPercentChange && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <span className={`${labelWidth} shrink-0 text-xs font-medium text-slate-600 uppercase tracking-wider`} title="Share area vs output frame">
                Share
              </span>
              <Slider
                value={[shareWindowFillPercent]}
                onValueChange={([v]) => onShareWindowFillPercentChange(Math.round(v ?? 80))}
                min={80}
                max={100}
                step={5}
                className="flex-1 min-w-0"
              />
              <span className="w-11 shrink-0 text-sm tabular-nums text-slate-700">{shareWindowFillPercent}%</span>
            </div>
            <p className="pl-[calc(4rem+0.75rem)] text-[11px] leading-snug text-slate-500">
              Target vs base mat: uniform scale (same aspect as output). Larger = more screen, less surround. Preview + recording.
            </p>
          </div>
        )}
        {letterboxBackground != null && onLetterboxBackgroundChange && (
          <div className="flex items-center gap-3">
            <span className={`${labelWidth} shrink-0 text-xs font-medium text-slate-600 uppercase tracking-wider`}>Bg</span>
            <Select
              value={letterboxBackground}
              onValueChange={(v) => onLetterboxBackgroundChange(v as LetterboxBackground)}
            >
              <SelectTrigger className="min-w-[10rem] flex-1 border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900">
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top" className="z-[1000001] border-slate-200 bg-white">
                <SelectItem value="black">Black</SelectItem>
                <SelectItem value="custom">Upload image</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {onLetterboxModeChange != null && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <span className={`${labelWidth} shrink-0 text-xs font-medium text-slate-600 uppercase tracking-wider`}>
                Scale
              </span>
              <div className="flex flex-1 min-w-0 flex-wrap gap-2">
                <GlassButton
                  size="sm"
                  variant={letterboxMode === "fill" ? "primary" : "secondary"}
                  onClick={() => onLetterboxModeChange("fill")}
                >
                  Fill
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant={letterboxMode === "fit" ? "primary" : "secondary"}
                  onClick={() => onLetterboxModeChange("fit")}
                >
                  Fit
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant={letterboxMode === "crop" ? "primary" : "secondary"}
                  onClick={() => onLetterboxModeChange("crop")}
                >
                  Crop
                </GlassButton>
              </div>
            </div>
            <p className="pl-[calc(4rem+0.75rem)] text-[11px] leading-snug text-slate-500">
              Controls background image scaling.
            </p>
          </div>
        )}
        {onLetterboxCustomImageChange && onLetterboxBackgroundChange && (
          <div className="flex items-center gap-3">
            <span className={`${labelWidth} shrink-0 text-xs font-medium text-slate-600 uppercase tracking-wider`}>Custom</span>
            <label className="cursor-pointer text-xs text-slate-600 hover:text-slate-900 shrink-0">
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
                className="text-xs text-slate-600 hover:text-slate-900 shrink-0"
                onClick={() => onLetterboxCustomImageChange(null)}
              >
                Clear
              </button>
            )}
          </div>
        )}
        <div className="flex items-center gap-3">
          <span className={`${labelWidth} shrink-0 text-xs font-medium text-slate-600 uppercase tracking-wider`}>Source</span>
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
      <div className="flex flex-col gap-4">
        <h3 className="text-base font-semibold text-slate-900 tracking-tight">Audio</h3>
        <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className={`${labelWidth} shrink-0 text-xs font-medium text-slate-600 uppercase tracking-wider`}>Mic</span>
          <Slider
            value={[micVolume]}
            onValueChange={([v]) => onMicVolumeChange(v ?? 100)}
            min={0}
            max={100}
            className="flex-1"
          />
        </div>
        <div className="flex items-center gap-3">
          <span className={`${labelWidth} shrink-0 text-xs font-medium text-slate-600 uppercase tracking-wider`}>System</span>
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
