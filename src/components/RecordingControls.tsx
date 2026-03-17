import { GlassButton } from "@/components/Glass";
import { Video } from "lucide-react";

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
  showWhiteboard,
  showTeleprompter = false,
  recordingTimeLabel = "00:00",
}: RecordingControlsProps) {
  const recordingCompact = compact && isRecording;
  const showCaptureAndCamera = !compact && !recordingCompact;
  const showCompactCamera = compact;
  const showCompactCapture = compact && !hasScreen;
  const showCompactStopShare = compact && hasScreen && !!onStopScreenShare;

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
