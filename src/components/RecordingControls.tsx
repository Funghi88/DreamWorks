import { useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { GlassButton } from "@/components/Glass";
import { Video, Camera } from "lucide-react";
import { CAPTURE_MODES, CAPTURE_PRESETS, type CapturePresetId, type CaptureModeId } from "@/lib/capture";

interface RecordingControlsProps {
  hasScreen: boolean;
  hasCamera: boolean;
  isRecording: boolean;
  isRecordingPaused?: boolean;
  compact?: boolean;
  onCaptureScreen: () => void;
  onStopScreenShare?: () => void;
  onToggleCamera: () => void;
  onToggleRecord: () => void;
  onPauseRecording?: () => void;
  onResumeRecording?: () => void;
  onToggleWhiteboard?: () => void;
  onOpenFullPageWhiteboard?: () => void;
  onOpenLiveMeeting?: () => void;
  onToggleTeleprompter?: () => void;
  onRecoverOverlays?: () => void;
  onCaptureScreenshot?: (presetId: CapturePresetId | CaptureModeId) => void;
  showWhiteboard: boolean;
  showTeleprompter?: boolean;
  recordingTimeLabel?: string;
}

export function RecordingControls({
  hasScreen,
  hasCamera,
  isRecording,
  isRecordingPaused = false,
  compact = false,
  onCaptureScreen,
  onStopScreenShare,
  onToggleCamera,
  onToggleRecord,
  onPauseRecording,
  onResumeRecording,
  onToggleWhiteboard,
  onOpenFullPageWhiteboard,
  onOpenLiveMeeting,
  onToggleTeleprompter,
  onRecoverOverlays,
  onCaptureScreenshot,
  showWhiteboard,
  showTeleprompter = false,
  recordingTimeLabel = "00:00",
}: RecordingControlsProps) {
  const [captureOpen, setCaptureOpen] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);
  const [dropdownRect, setDropdownRect] = useState<{ top: number; left: number } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [pendingPreset, setPendingPreset] = useState<CapturePresetId | CaptureModeId | null>(null);

  useEffect(() => {
    if (countdown === null || pendingPreset === null) return;
    if (countdown <= 0) {
      onCaptureScreenshot?.(pendingPreset);
      const t = setTimeout(() => {
        setPendingPreset(null);
        setCountdown(null);
      }, 200);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setCountdown((c) => (c != null ? c - 1 : null)), 1000);
    return () => clearTimeout(t);
  }, [countdown, pendingPreset, onCaptureScreenshot]);

  useEffect(() => {
    if (!captureOpen || !captureRef.current) return;
    const btn = captureRef.current.querySelector("button");
    if (btn) {
      const r = btn.getBoundingClientRect();
      setDropdownRect({ top: r.bottom + 4, left: r.left });
    }
  }, [captureOpen]);

  useEffect(() => {
    if (!captureOpen) return;
    const close = (e: MouseEvent) => {
      if (captureRef.current && !captureRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement;
        if (!target.closest?.("[data-capture-dropdown]")) {
          setCaptureOpen(false);
        }
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [captureOpen]);

  const recordingCompact = compact && isRecording;
  const showCaptureAndCamera = !compact && !recordingCompact;
  const showCompactCamera = compact;
  const showCompactCapture = compact && !hasScreen;
  const showCompactStopShare = compact && hasScreen && !!onStopScreenShare;
  const canCapture = !!onCaptureScreenshot;

  return (
    <div
      className={`flex items-center [&_button]:text-[12px] [&_button]:font-semibold ${
        compact
          ? "flex-wrap overflow-visible gap-1.5 pb-1 [&_button]:h-9 [&_button]:min-w-[74px] [&_button]:shrink-0 [&_button]:justify-center [&_button]:px-2"
          : "flex-nowrap justify-center gap-3"
      }`}
    >
      {showCaptureAndCamera && (
        <>
          <GlassButton
            variant={hasScreen ? "primary" : "secondary"}
            onClick={hasScreen && onStopScreenShare ? onStopScreenShare : onCaptureScreen}
            size="sm"
          >
            {hasScreen ? (compact ? "Stop share" : "Stop sharing") : (compact ? "Capture" : "Capture Screen")}
          </GlassButton>
          <GlassButton
            variant={hasCamera ? "primary" : "secondary"}
            onClick={onToggleCamera}
            size="sm"
          >
            {compact ? (hasCamera ? "Stop Cam" : "Camera") : hasCamera ? "Stop Camera" : "Start Camera"}
          </GlassButton>
        </>
      )}
      {showCompactCapture && (
        <GlassButton variant="secondary" onClick={onCaptureScreen} size="sm">
          Capture
        </GlassButton>
      )}
      {showCompactStopShare && (
        <GlassButton variant="primary" onClick={onStopScreenShare} size="sm">
          Stop share
        </GlassButton>
      )}
      {showCompactCamera && (
        <GlassButton
          variant={hasCamera ? "primary" : "secondary"}
          onClick={onToggleCamera}
          size="sm"
          title={hasCamera ? "Hide camera avatar" : "Show camera avatar"}
        >
          {hasCamera ? "Cam On" : "Cam"}
        </GlassButton>
      )}
      {isRecording ? (
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-3">
            <GlassButton
              variant="primary"
              size="sm"
              disabled={!hasScreen && !hasCamera}
              onClick={onToggleRecord}
              title={!hasScreen && !hasCamera ? "Capture screen or start camera first" : undefined}
            >
              Stop
            </GlassButton>
            {onPauseRecording && onResumeRecording && (
              <GlassButton
                variant="secondary"
                size="sm"
                onClick={isRecordingPaused ? onResumeRecording : onPauseRecording}
              >
                {isRecordingPaused ? "Resume" : "Pause"}
              </GlassButton>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full h-2 w-2 animate-pulse bg-red-500" />
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {recordingTimeLabel}
            </span>
          </div>
        </div>
      ) : (
        <GlassButton
          variant="destructive"
          size="sm"
          disabled={!hasScreen && !hasCamera}
          onClick={onToggleRecord}
          title={!hasScreen && !hasCamera ? "Capture screen or start camera first" : undefined}
        >
          {compact ? "Start" : "Start Recording"}
        </GlassButton>
      )}
      {compact && onToggleTeleprompter && (
        <GlassButton variant={showTeleprompter ? "primary" : "secondary"} size="sm" onClick={onToggleTeleprompter}>
          Teleprompter
        </GlassButton>
      )}
      {compact && hasScreen && onRecoverOverlays && (
        <GlassButton variant="secondary" size="sm" onClick={onRecoverOverlays} title="Reopen camera and teleprompter overlays">
          Recover
        </GlassButton>
      )}
      {canCapture && (
        <div ref={captureRef} className="relative">
          <GlassButton
            variant="secondary"
            size="sm"
            onClick={() => setCaptureOpen((o) => !o)}
            title="Capture current frame as image"
          >
            <Camera className="size-3.5" />
            {!compact && (
              <>
                <span className="ml-1">Capture</span>
              </>
            )}
          </GlassButton>
          {captureOpen &&
            dropdownRect &&
            createPortal(
              <div
                data-capture-dropdown
                className="fixed z-[100000] min-w-[200px] rounded-lg border border-slate-200 bg-white py-1 shadow-xl"
                style={{ top: dropdownRect.top, left: dropdownRect.left }}
              >
                {CAPTURE_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="w-full px-3 py-2 text-left text-xs text-slate-900 hover:bg-slate-100 font-medium"
                    onClick={() => {
                      setCaptureOpen(false);
                      setPendingPreset(m.id);
                      setCountdown(3);
                    }}
                  >
                    {m.label}
                  </button>
                ))}
                <div className="my-1 border-t border-slate-200" />
                {CAPTURE_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="w-full px-3 py-2 text-left text-xs text-slate-900 hover:bg-slate-100"
                    onClick={() => {
                      setCaptureOpen(false);
                      setPendingPreset(p.id);
                      setCountdown(3);
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>,
              document.body
            )}
          {countdown !== null &&
            countdown >= 0 &&
            createPortal(
              <div
                data-dreamwork-no-intercept
                className="fixed inset-0 z-[100001] flex items-center justify-center bg-black/30 backdrop-blur-sm"
              >
                <div className="rounded-2xl border border-white/30 bg-slate-900/90 px-12 py-8 shadow-2xl backdrop-blur-md">
                  <span className="font-mono text-6xl font-bold tabular-nums text-white">
                    {countdown > 0 ? countdown : "📸"}
                  </span>
                </div>
              </div>,
              document.body
            )}
        </div>
      )}
      {!compact && (
        <>
          <span className="mx-1 text-muted-foreground/40">·</span>
          <GlassButton
            variant={showWhiteboard ? "primary" : "secondary"}
            onClick={onOpenFullPageWhiteboard ?? onToggleWhiteboard}
            size="sm"
          >
            Whiteboard
          </GlassButton>
          {onToggleTeleprompter && (
            <GlassButton variant={showTeleprompter ? "primary" : "secondary"} size="sm" onClick={onToggleTeleprompter}>
              Teleprompter
            </GlassButton>
          )}
          {onOpenLiveMeeting && (
            <GlassButton variant="secondary" size="sm" onClick={onOpenLiveMeeting}>
              <Video size={14} />
              Live Meeting
            </GlassButton>
          )}
        </>
      )}
    </div>
  );
}
