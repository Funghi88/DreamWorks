import { lazy } from "react";

export type { SnapPipLensProps } from "./SnapPipLensImpl";

/** Code-splits `@snap/react-camera-kit`; only load when Snap PiP is mounted. */
export const SnapPipLens = lazy(() =>
  import("./SnapPipLensImpl").then((m) => ({ default: m.SnapPipLens }))
);
