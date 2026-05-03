import { useEffect } from "react";
import type { CSSProperties } from "react";
import {
  CameraKitProvider,
  LensPlayer,
  LiveCanvas,
  useCameraKit,
  usePlaybackOptions,
} from "@snap/react-camera-kit";

function SnapPlaybackAndCanvasBridge({
  pipDragging,
  onLiveCanvas,
}: {
  pipDragging: boolean;
  onLiveCanvas: (c: HTMLCanvasElement | null) => void;
}) {
  usePlaybackOptions({
    fpsLimit: pipDragging ? 12 : 24,
    muted: true,
  });
  const { liveCanvas } = useCameraKit();
  useEffect(() => {
    onLiveCanvas(liveCanvas ?? null);
    return () => onLiveCanvas(null);
  }, [liveCanvas, onLiveCanvas]);
  return null;
}

export type SnapPipLensProps = {
  apiToken: string;
  lensId: string;
  lensGroupId: string;
  className?: string;
  style?: CSSProperties;
  pipDragging: boolean;
  onLiveCanvas: (c: HTMLCanvasElement | null) => void;
};

export function SnapPipLens({
  apiToken,
  lensId,
  lensGroupId,
  className,
  style,
  pipDragging,
  onLiveCanvas,
}: SnapPipLensProps) {
  return (
    <CameraKitProvider apiToken={apiToken}>
      <LensPlayer lensId={lensId} lensGroupId={lensGroupId} className={className} style={style}>
        <LiveCanvas style={{ width: "100%", height: "100%", display: "block" }} />
        <SnapPlaybackAndCanvasBridge pipDragging={pipDragging} onLiveCanvas={onLiveCanvas} />
      </LensPlayer>
    </CameraKitProvider>
  );
}
