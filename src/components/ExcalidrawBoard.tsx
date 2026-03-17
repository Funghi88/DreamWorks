import { useEffect, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

type Props = {
  onCanvasLayersChange?: (layers: HTMLCanvasElement[]) => void;
};

export function ExcalidrawBoard({ onCanvasLayersChange }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onCanvasLayersChange) return;

    const collect = () => {
      const layers = Array.from(root.querySelectorAll("canvas")).filter(
        (el): el is HTMLCanvasElement => el instanceof HTMLCanvasElement
      );
      onCanvasLayersChange(layers);
    };

    collect();
    const mo = new MutationObserver(collect);
    mo.observe(root, { childList: true, subtree: true, attributes: true });
    const ro = new ResizeObserver(collect);
    ro.observe(root);
    return () => {
      mo.disconnect();
      ro.disconnect();
      onCanvasLayersChange([]);
    };
  }, [onCanvasLayersChange]);

  return (
    <div ref={rootRef} className="h-full w-full min-h-[200px] bg-white">
      <Excalidraw viewModeEnabled={false} />
    </div>
  );
}

