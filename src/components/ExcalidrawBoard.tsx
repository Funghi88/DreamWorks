import { useEffect, useRef, useState, useCallback, useMemo, startTransition } from "react";
import { createPortal } from "react-dom";
import { Excalidraw, MainMenu, loadFromBlob, serializeAsJSON, exportToBlob, getSceneVersion } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./ExcalidrawBoard.css";
import {
  loadSettings,
  loadSettingsAsync,
  saveSettings,
  getWhiteboardProjects,
  saveWhiteboardProjects,
  type WhiteboardProject,
  type WhiteboardLayer,
} from "@/lib/storage";

const BASE_LAYER: WhiteboardLayer = { id: "base", name: "Base" };
const isAnnotationLayer = (id: string) => id.startsWith("ann-") || id === "annotations";

const WHITEBOARD_TEXTURES = [
  { id: "", name: "None" },
  // Paper textures
  { id: "paper-crumpled.png", name: "Crumpled paper" },
  { id: "paper-crumpled-3.png", name: "Crumpled paper (new)" },
  { id: "paper-crumpled-4.png", name: "Crumpled paper 2" },
  { id: "paper-cream.png", name: "Cream paper" },
  { id: "paper-cream-grain.png", name: "Cream paper (grain)" },
  { id: "paper-white.png", name: "White paper" },
  { id: "paper-white-2.png", name: "White paper 2" },
  { id: "paper-fine-grain.png", name: "Fine grain paper" },
  { id: "paper-classic.png", name: "Classic white paper" },
  { id: "paper-textured.png", name: "Textured paper" },
  { id: "paper-crumpled-2.png", name: "Crumpled paper (alt)" },
  // Glitter
  { id: "glitter-pink.png", name: "Pink glitter" },
  { id: "glitter-gold.png", name: "Gold glitter" },
  { id: "glitter-silver.png", name: "Silver glitter" },
  { id: "glitter-rose-gold.png", name: "Rose gold glitter" },
  { id: "glitter-lime.png", name: "Lime glitter" },
  { id: "glitter-turquoise.png", name: "Turquoise glitter" },
  { id: "glitter-blue.png", name: "Blue glitter" },
  { id: "glitter-purple.png", name: "Purple glitter" },
] as const;

// Use relative path so textures load in packed Electron (file:// protocol)
const TEXTURE_BASE = `${import.meta.env.BASE_URL}whiteboard-textures/`;

/** Normalize Excalidraw's files map (plain object or Map). */
function normalizeFileMapInput(input: unknown): Record<string, unknown> | null {
  if (input == null) return null;
  if (input instanceof Map) {
    const o: Record<string, unknown> = {};
    input.forEach((v, k) => {
      if (v != null) o[String(k)] = v;
    });
    return o;
  }
  if (typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  return null;
}

/** Merge file blobs; later sources win. Survives getFiles()/storage skew. */
function mergeFileMaps(...sources: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sources) {
    const n = normalizeFileMapInput(s);
    if (!n) continue;
    for (const [k, v] of Object.entries(n)) {
      if (v != null) out[k] = v;
    }
  }
  return out;
}

/** Backup payload so Excalidraw's JSON pipeline can't strip DreamWorks-only data. */
type DreamworkFilePayload = {
  v: 1;
  whiteboardTexture?: string;
  files?: Record<string, unknown>;
};

type PersistExtra = boolean | { skipStateUpdate?: boolean; skipReact?: boolean };

type Props = {
  onCanvasLayersChange?: (layers: HTMLCanvasElement[]) => void;
  onWhiteboardTextureChange?: (textureId: string | null) => void;
  onExcalidrawReady?: (api: ExcalidrawAPI) => void;
};

type ProjectRow = { id: string; name: string };

type ExcalidrawAPI = {
  updateScene: (s: { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> }) => void;
  /** Required to load image binaries — updateScene ignores `files` in Excalidraw 0.18. */
  addFiles: (data: Record<string, unknown> | unknown[]) => void;
  getSceneElements: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
};

/** Derived name for a new project when opening a file (Electron path). */
function projectNameFromOpenPath(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  const base = parts[parts.length - 1]?.trim() ?? "";
  const withoutExt = base.replace(/\.(excalidraw|json)$/i, "").trim();
  return withoutExt || "Imported";
}

export function ExcalidrawBoard({ onCanvasLayersChange, onWhiteboardTextureChange, onExcalidrawReady }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [projects, setProjects] = useState<WhiteboardProject[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [ready, setReady] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; projectId: string } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ projectId: string } | null>(null);
  const [saveAsDialog, setSaveAsDialog] = useState(false);
  const [textureDialog, setTextureDialog] = useState(false);
  const [layersDialog, setLayersDialog] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const saveAsInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last autosave was "viewport only" (Excalidraw scene version unchanged) — persist skips React setState to avoid jank on next pointer. */
  const pendingViewOnlyPersistRef = useRef(false);
  /** getSceneVersion after last successful persist; null until first save for this project session. */
  const lastSavedSceneVerRef = useRef<number | null>(null);
  /** Throttle texture background fix — without this, Excalidraw resets canvas fill during hand-pan and we were calling updateScene every tick (very janky). */
  const textureBgFixLastRef = useRef(0);
  const latestSceneRef = useRef<{
    elements: unknown[];
    appState: Record<string, unknown>;
    files?: Record<string, unknown>;
  }>({ elements: [], appState: {} });
  const excalidrawRef = useRef<ExcalidrawAPI | null>(null);
  const twoFingerRef = useRef<{ startTime: number; startX: number; startY: number } | null>(null);
  const [gestureBarVisible, setGestureBarVisible] = useState(false);
  const prevElementIdsRef = useRef<Set<string>>(new Set());
  const projectsRef = useRef(projects);
  const activeIdRef = useRef(activeId);
  const menuSigRef = useRef("");
  const menuRowsRef = useRef<ProjectRow[]>([]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const onExcalidrawReadyRef = useRef(onExcalidrawReady);
  useEffect(() => {
    onExcalidrawReadyRef.current = onExcalidrawReady;
  }, [onExcalidrawReady]);

  const bindExcalidrawApi = useCallback((api: unknown) => {
    excalidrawRef.current = api as unknown as ExcalidrawAPI;
    onExcalidrawReadyRef.current?.(api as unknown as ExcalidrawAPI);
  }, []);

  const isElectron =
    typeof window !== "undefined" && !!(window as unknown as { electronAPI?: unknown }).electronAPI;
  const electronAPI = isElectron
    ? (window as unknown as {
        electronAPI?: {
          openFile?: (f?: unknown) => Promise<{ path: string; content: string } | null>;
          saveFile?: (c: string, n?: string, f?: unknown) => Promise<boolean>;
          saveImage?: (base64: string, n?: string) => Promise<boolean>;
        };
      }).electronAPI
    : null;

  const excalidrawUiOptions = useMemo(
    () =>
      ({
        canvasActions: {
          loadScene: true,
          saveToActiveFile: !isElectron,
          saveAsImage: true,
          changeViewBackgroundColor: true,
          clearCanvas: true,
        },
      }) as React.ComponentProps<typeof Excalidraw>["UIOptions"],
    [isElectron]
  );

  const loadProjects = useCallback(async () => {
    const s = isElectron ? await loadSettingsAsync() : loadSettings();
    const list = getWhiteboardProjects(s);
    const aid = s.activeProjectId && list.some((p) => p.id === s.activeProjectId) ? s.activeProjectId : list[0]?.id ?? "default";
    setProjects(list);
    setActiveId(aid);
    setReady(true);
    if (!s.whiteboardProjects?.length && list.length) {
      saveSettings(saveWhiteboardProjects(s, list, aid));
    }
  }, [isElectron]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const dispatchKey = useCallback((opts: { key: string; code: string; metaKey: boolean; shiftKey?: boolean }) => {
    const ev = new KeyboardEvent("keydown", {
      key: opts.key,
      code: opts.code,
      metaKey: opts.metaKey,
      shiftKey: opts.shiftKey ?? false,
      bubbles: true,
      cancelable: true,
    });
    (rootRef.current ?? document.body).dispatchEvent(ev);
  }, []);

  const triggerUndo = useCallback(() => {
    const api = excalidrawRef.current as { executeAction?: (name: string) => void } | null;
    if (api?.executeAction) {
      api.executeAction("undo");
    } else {
      dispatchKey({ key: "z", code: "KeyZ", metaKey: true });
    }
  }, [dispatchKey]);

  const triggerRedo = useCallback(() => {
    const api = excalidrawRef.current as { executeAction?: (name: string) => void } | null;
    if (api?.executeAction) {
      api.executeAction("redo");
    } else {
      dispatchKey({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true });
    }
  }, [dispatchKey]);

  const triggerClearCanvas = useCallback(() => {
    const api = excalidrawRef.current as { executeAction?: (name: string) => void } | null;
    if (api?.executeAction) {
      api.executeAction("clearCanvas");
    }
  }, []);

  // Two/three-finger gesture (iPad Sidecar + Apple Pencil)
  useEffect(() => {
    if (!ready) return;
    const root = rootRef.current;
    if (!root) return;

    const isInWhiteboard = (target: EventTarget | null) =>
      target && root.contains(target as Node);

    // Touch events (direct iPad / mobile)
    const touchStartState = { current: null as { count: number; startTime: number } | null };
    const onTouchStart = (e: TouchEvent) => {
      if (!isInWhiteboard(e.target)) return;
      const n = e.touches.length;
      if (n >= 3) {
        touchStartState.current = { count: n, startTime: Date.now() };
      } else if (n >= 2) {
        twoFingerRef.current = { startTime: Date.now(), startX: 0, startY: 0 };
        touchStartState.current = null;
      } else {
        twoFingerRef.current = null;
        touchStartState.current = null;
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!isInWhiteboard(e.target)) return;
      if (e.touches.length === 0) {
        const threeState = touchStartState.current;
        if (threeState && threeState.count >= 3) {
          const elapsed = Date.now() - threeState.startTime;
          if (elapsed < 1000) {
            e.preventDefault();
            setGestureBarVisible((v) => !v);
          }
          touchStartState.current = null;
        } else {
          const state = twoFingerRef.current;
          if (state) {
            const elapsed = Date.now() - state.startTime;
            if (elapsed < 1000) {
              e.preventDefault();
              triggerUndo();
            }
          }
          twoFingerRef.current = null;
        }
      }
    };

    // Pointer events (Sidecar: iPad touch → pointer on Mac, exclude Apple Pencil)
    const touchPointers = new Map<number, number>();
    const pointerStartRef = { current: 0 };
    const pointerInWhiteboardRef = { current: false };

    const onPointerDown = (e: PointerEvent) => {
      if (touchPointers.size === 0) pointerInWhiteboardRef.current = !!isInWhiteboard(e.target);
      if (!pointerInWhiteboardRef.current) return;
      if (e.pointerType === "touch") {
        touchPointers.set(e.pointerId, Date.now());
        if (touchPointers.size >= 2) pointerStartRef.current = Date.now();
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const hadTwoTouch = touchPointers.size >= 2 && pointerInWhiteboardRef.current;
      const hadThreeTouch = touchPointers.size >= 3 && pointerInWhiteboardRef.current;
      touchPointers.delete(e.pointerId);
      if (touchPointers.size === 0) pointerInWhiteboardRef.current = false;
      if (hadThreeTouch && touchPointers.size === 0) {
        const elapsed = Date.now() - pointerStartRef.current;
        if (elapsed < 1000) {
          e.preventDefault();
          setGestureBarVisible((v) => !v);
        }
      } else if (hadTwoTouch && touchPointers.size === 0) {
        const elapsed = Date.now() - pointerStartRef.current;
        if (elapsed < 1000) {
          e.preventDefault();
          triggerUndo();
        }
      }
    };

    // Wheel: Sidecar 两指横滑可能转为 wheel (deltaX)
    // 必须挂在 whiteboard root 上而非 document：document + passive:false 会令每次全局 wheel
    //（含双指缩放）同步等待 JS，触摸板缩放手感发涩。
    const wheelDebounceRef = { last: 0 };
    const onWheel = (e: WheelEvent) => {
      if (!e.composedPath().includes(root)) return;
      if (e.ctrlKey || e.metaKey) return; // 双指缩放 / 浏览器缩放
      if (e.deltaZ !== 0) return; // 部分环境用 deltaZ 表示 zoom
      const dx = Math.abs(e.deltaX);
      const dy = Math.abs(e.deltaY);
      if (dx > 60 && dx > dy * 2) {
        const now = Date.now();
        if (now - wheelDebounceRef.last > 400) {
          wheelDebounceRef.last = now;
          e.preventDefault();
          triggerUndo();
        }
      }
    };

    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    document.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
    document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    document.addEventListener("pointerup", onPointerUp, { capture: true, passive: false });
    document.addEventListener("pointercancel", onPointerUp, { capture: true, passive: false });
    root.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      document.removeEventListener("touchstart", onTouchStart, { capture: true });
      document.removeEventListener("touchend", onTouchEnd, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      document.removeEventListener("pointerup", onPointerUp, { capture: true });
      document.removeEventListener("pointercancel", onPointerUp, { capture: true });
      root.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [ready, triggerUndo]);

  const currentProject = projects.find((p) => p.id === activeId);
  const projData = currentProject?.data as
    | {
        elements?: unknown[];
        appState?: Record<string, unknown>;
        files?: Record<string, unknown>;
        dreamwork?: DreamworkFilePayload;
        layers?: WhiteboardLayer[];
        layerAssignments?: Record<string, string>;
        hiddenLayerIds?: string[];
      }
    | undefined;
  const storedTexture =
    (typeof projData?.dreamwork?.whiteboardTexture === "string" && projData.dreamwork.whiteboardTexture
      ? projData.dreamwork.whiteboardTexture
      : undefined) ??
    ((currentProject?.data?.appState as Record<string, unknown> | undefined)?.whiteboardTexture as string | undefined);

  useEffect(() => {
    onWhiteboardTextureChange?.(storedTexture ?? null);
  }, [storedTexture, onWhiteboardTextureChange]);
  const hiddenLayerIds = projData?.hiddenLayerIds ?? [];
  const layerAssignmentsForFilter = projData?.layerAssignments ?? {};
  const visibleElements =
    projData?.elements?.filter(
      (el) => !hiddenLayerIds.includes((layerAssignmentsForFilter as Record<string, string>)[(el as { id?: string }).id ?? ""] ?? "base")
    ) ?? projData?.elements ?? [];
  const initialFiles = mergeFileMaps(projData?.dreamwork?.files, currentProject?.data?.files);
  const initialData = currentProject?.data
    ? {
        elements: hiddenLayerIds.length > 0 ? visibleElements : (projData?.elements ?? []),
        appState: {
          ...currentProject.data.appState,
          ...(storedTexture
            ? { whiteboardTexture: storedTexture, viewBackgroundColor: "transparent" }
            : {}),
          activeLayerId: (currentProject.data.appState as Record<string, unknown>)?.activeLayerId ?? "base",
        },
        ...(Object.keys(initialFiles).length > 0 ? { files: initialFiles } : {}),
      }
    : undefined;

  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { setWindowTitle?: (t: string) => Promise<void> } }).electronAPI;
    if (api?.setWindowTitle && currentProject?.name) {
      api.setWindowTitle(currentProject.name);
    }
  }, [currentProject?.name]);

  // Excalidraw restore strips custom keys; canvas default fill hides the z-0 texture layer unless background is transparent.
  useEffect(() => {
    if (!ready || !storedTexture || !excalidrawRef.current) return;
    excalidrawRef.current.updateScene({
      appState: {
        viewBackgroundColor: "transparent",
        whiteboardTexture: storedTexture,
      },
    });
  }, [ready, storedTexture, activeId]);

  const persist = useCallback(
    (elements: readonly unknown[], appState: Record<string, unknown>, persistExtra?: PersistExtra) => {
      const skipStateUpdate =
        persistExtra === true || (typeof persistExtra === "object" && persistExtra.skipStateUpdate === true);
      // Viewport-only: also skip getFiles() in merge — scene version unchanged.
      const skipReact = typeof persistExtra === "object" && persistExtra.skipReact === true;
      const activeIdSnap = activeIdRef.current;
      const projectsSnap = projectsRef.current;
      const projectSnap = projectsSnap.find((p) => p.id === activeIdSnap);
      const { collaborators: _, ...rest } = appState;
      const projData = projectSnap?.data as
        | {
            appState?: Record<string, unknown>;
            dreamwork?: DreamworkFilePayload;
            layerAssignments?: Record<string, string>;
            layers?: WhiteboardLayer[];
            hiddenLayerIds?: string[];
            elements?: unknown[];
          }
        | undefined;
      const existingTexture =
        projData?.appState?.whiteboardTexture ?? projData?.dreamwork?.whiteboardTexture;
      const existingActiveLayer = projData?.appState?.activeLayerId as string | undefined;
      const appStateToSave = {
        ...rest,
        ...(existingTexture && rest.whiteboardTexture === undefined ? { whiteboardTexture: existingTexture } : {}),
        ...(existingActiveLayer !== undefined && rest.activeLayerId === undefined ? { activeLayerId: existingActiveLayer } : {}),
      };
      const textureIdPersist =
        (typeof appStateToSave.whiteboardTexture === "string" && appStateToSave.whiteboardTexture.length > 0
          ? appStateToSave.whiteboardTexture
          : undefined) ??
        (typeof existingTexture === "string" && existingTexture.length > 0 ? existingTexture : undefined);
      const appStateFinal =
        textureIdPersist !== undefined
          ? { ...appStateToSave, whiteboardTexture: textureIdPersist, viewBackgroundColor: "transparent" }
          : appStateToSave;
      let layers: WhiteboardLayer[] = projData?.layers ?? [BASE_LAYER];
      let layerAssignments: Record<string, string> = { ...(projData?.layerAssignments ?? {}) };
      const activeLayerId = (appStateFinal.activeLayerId as string) ?? "base";
      const elemArr = elements as { id: string }[];
      for (const el of elemArr) {
        if (layerAssignments[el.id] === undefined) {
          layerAssignments[el.id] = prevElementIdsRef.current.has(el.id) ? "base" : activeLayerId;
        }
      }
      prevElementIdsRef.current = new Set(elemArr.map((e) => e.id));
      const hiddenIds = projData?.hiddenLayerIds ?? [];
      const hiddenElements = ((projData?.elements ?? []) as { id: string }[]).filter(
        (el) => hiddenIds.includes(layerAssignments[el.id] ?? "")
      );
      const visibleIds = new Set(elemArr.map((e) => e.id));
      const fullElements = [
        ...hiddenElements.filter((el) => !visibleIds.has(el.id)),
        ...elements,
      ] as unknown[];
      const filesMap = mergeFileMaps(
        (projectSnap?.data as { files?: Record<string, unknown> } | undefined)?.files,
        latestSceneRef.current.files,
        skipReact ? undefined : excalidrawRef.current?.getFiles()
      );
      const files = Object.keys(filesMap).length > 0 ? filesMap : undefined;
      const data: {
        elements: unknown[];
        appState: Record<string, unknown>;
        files?: Record<string, unknown>;
        dreamwork?: DreamworkFilePayload;
        layers?: WhiteboardLayer[];
        layerAssignments?: Record<string, string>;
        hiddenLayerIds?: string[];
      } = {
        elements: fullElements,
        appState: appStateFinal,
        layers,
        layerAssignments,
        ...(hiddenIds.length > 0 ? { hiddenLayerIds: hiddenIds } : {}),
      };
      if (files) data.files = files;
      const texPersist =
        typeof appStateFinal.whiteboardTexture === "string" && appStateFinal.whiteboardTexture.length > 0
          ? appStateFinal.whiteboardTexture
          : undefined;
      if (texPersist || files) {
        const dw: DreamworkFilePayload = { v: 1 };
        if (texPersist) dw.whiteboardTexture = texPersist;
        if (files) dw.files = files;
        data.dreamwork = dw;
      }
      const now = Date.now();
      const nextProjects = projectsSnap.map((p) =>
        p.id === activeIdSnap ? { ...p, data, name: p.name, updatedAt: now } : p
      );
      if (!nextProjects.some((p) => p.id === activeIdSnap)) {
        nextProjects.push({ id: activeIdSnap, name: projectSnap?.name ?? "Untitled", data, updatedAt: now });
      }
      /** Web: JSON.stringify + localStorage blocks the main thread; defer so the next pan starts cleanly. Flush path stays sync. */
      const flushDisk = () => {
        if (isElectron) {
          loadSettingsAsync().then((s) => {
            const merged = { ...s, whiteboardProjects: nextProjects, activeProjectId: activeIdSnap };
            if (merged.whiteboardData) delete merged.whiteboardData;
            saveSettings(merged);
          });
        } else {
          const next = saveWhiteboardProjects(loadSettings(), nextProjects, activeIdSnap);
          saveSettings(next);
        }
      };
      if (!skipStateUpdate) {
        projectsRef.current = nextProjects;
        if (!skipReact) {
          startTransition(() => setProjects(nextProjects));
        }
        window.setTimeout(flushDisk, 0);
      } else {
        flushDisk();
      }
      lastSavedSceneVerRef.current = getSceneVersion(elements as never);
    },
    [isElectron]
  );

  const handleChange = useCallback(
    (elements: readonly unknown[], appState: Record<string, unknown>, filesFromScene?: unknown) => {
      const { collaborators: _, ...rest } = appState;
      const prev = latestSceneRef.current;
      const activeToolEarly = (rest as { activeTool?: { type?: string } }).activeTool?.type;
      // Excalidraw calls onChange(elements, state, files). Avoid getFiles() on every hand-pan tick when the third arg is present.
      // Hand pan: images map does not change — getFiles() is costly; keep prev.files until a real edit supplies filesFromScene.
      const files = mergeFileMaps(
        prev.files,
        filesFromScene,
        filesFromScene === undefined && activeToolEarly !== "hand"
          ? excalidrawRef.current?.getFiles()
          : undefined
      );
      // Paper texture: keep view background transparent. Excalidraw often flips it during scroll/pan — fix on a throttle only.
      const bgMismatch = !!storedTexture && rest.viewBackgroundColor !== "transparent";
      const restPatched =
        bgMismatch
          ? { ...rest, viewBackgroundColor: "transparent", whiteboardTexture: storedTexture }
          : rest;
      // updateScene during hand-pan fights Excalidraw's drag loop; patch local ref only, fix after tool change / idle.
      if (bgMismatch && activeToolEarly !== "hand") {
        const now = performance.now();
        if (now - textureBgFixLastRef.current >= 280) {
          textureBgFixLastRef.current = now;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              excalidrawRef.current?.updateScene({
                appState: { viewBackgroundColor: "transparent", whiteboardTexture: storedTexture },
              });
            });
          });
        }
      }
      const elArr = elements as unknown[];
      const nextElements = prev.elements === elArr ? prev.elements : [...elements];
      latestSceneRef.current = {
        elements: nextElements,
        appState: restPatched,
        files: Object.keys(files).length > 0 ? files : prev.files,
      };
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      const appStateForPersist = bgMismatch ? { ...appState, viewBackgroundColor: "transparent", whiteboardTexture: storedTexture } : appState;
      const elSameRef = prev.elements === elArr;
      const structuralChange =
        lastSavedSceneVerRef.current === null ||
        (!elSameRef && getSceneVersion(elements as never) !== lastSavedSceneVerRef.current);
      pendingViewOnlyPersistRef.current = !structuralChange;
      const debounceMs = structuralChange ? 520 : 2500;
      saveTimeoutRef.current = setTimeout(() => {
        const viewOnly = pendingViewOnlyPersistRef.current;
        const runPersist = () => persist(elements, appStateForPersist, viewOnly ? { skipReact: true } : undefined);
        if (viewOnly && typeof requestIdleCallback !== "undefined") {
          requestIdleCallback(() => requestAnimationFrame(runPersist), { timeout: 800 });
        } else {
          requestAnimationFrame(runPersist);
        }
      }, debounceMs);
    },
    [persist, storedTexture]
  );

  const flushPersist = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    const api = excalidrawRef.current;
    const elements = api?.getSceneElements() ?? latestSceneRef.current.elements;
    const appState = api?.getAppState() ?? latestSceneRef.current.appState;
    if (elements.length > 0 || Object.keys(appState).length > 0) {
      persist(elements, appState as Record<string, unknown>, true); // skipStateUpdate to avoid re-render loop
    }
  }, [persist]);

  const switchProject = useCallback(
    (id: string) => {
      const proj = projectsRef.current.find((p) => p.id === id);
      if (!proj || id === activeIdRef.current) return;
      flushPersist();
      lastSavedSceneVerRef.current = null;
      prevElementIdsRef.current = new Set();
      setActiveId(id);
    },
    [flushPersist]
  );

  useEffect(() => {
    const onBeforeUnload = () => flushPersist();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushPersist();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flushPersist(); // Save when unmounting (e.g. Capture Screen collapses whiteboard)
    };
  }, [flushPersist]);

  useEffect(() => {
    if (!currentProject?.data?.elements) return;
    const ids = (currentProject.data.elements as { id: string }[]).map((e) => e.id);
    prevElementIdsRef.current = new Set(ids);
  }, [activeId]);

  // Sync latestSceneRef from project data so flushPersist has correct data when user hasn't edited yet
  useEffect(() => {
    const data = currentProject?.data;
    if (!data) return;
    const projData = data as {
      elements?: unknown[];
      appState?: Record<string, unknown>;
      files?: Record<string, unknown>;
      dreamwork?: DreamworkFilePayload;
    };
    const syncedFiles = mergeFileMaps(projData.dreamwork?.files, projData.files);
    latestSceneRef.current = {
      elements: projData.elements ?? [],
      appState: projData.appState ?? {},
      ...(Object.keys(syncedFiles).length > 0 ? { files: syncedFiles } : {}),
    };
  }, [activeId, currentProject?.data]);

  const newProject = useCallback(() => {
    const id = "proj-" + Date.now();
    const proj: WhiteboardProject = {
      id,
      name: "Untitled",
      data: { elements: [], appState: {} },
      updatedAt: Date.now(),
    };
    setProjects((prev) => {
      const next = [...prev, proj];
      projectsRef.current = next;
      saveSettings(saveWhiteboardProjects(loadSettings(), next, id));
      return next;
    });
    setActiveId(id);
    activeIdRef.current = id;
    lastSavedSceneVerRef.current = null;
  }, []);

  const deleteProject = useCallback(
    (id: string) => {
      if (projects.length <= 1) return;
      flushPersist();
      const next = projects.filter((p) => p.id !== id);
      const newActiveId = activeId === id ? (next[0]?.id ?? "default") : activeId;
      setProjects(next);
      setActiveId(newActiveId);
      lastSavedSceneVerRef.current = null;
      saveSettings(saveWhiteboardProjects(loadSettings(), next, newActiveId));
    },
    [projects, activeId, flushPersist]
  );

  const addAnnotationsLayer = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    const aid = activeIdRef.current;
    const cp = projectsRef.current.find((p) => p.id === aid);
    const projData = cp?.data as
      | { layers?: WhiteboardLayer[]; appState?: Record<string, unknown> }
      | undefined;
    const layers = projData?.layers ?? [BASE_LAYER];
    const annCount = layers.filter((l) => isAnnotationLayer(l.id)).length;
    const newLayer: WhiteboardLayer = {
      id: `ann-${Date.now()}`,
      name: `Annotation ${annCount + 1}`,
    };
    const nextLayers = [...layers, newLayer];
    const appState = excalidrawRef.current?.getAppState() ?? {};
    const storedTexture = projData?.appState?.whiteboardTexture as string | undefined;
    const nextAppState = {
      ...appState,
      activeLayerId: newLayer.id,
      ...(storedTexture !== undefined && { whiteboardTexture: storedTexture, viewBackgroundColor: "transparent" }),
    };
    excalidrawRef.current?.updateScene({ appState: nextAppState });
    latestSceneRef.current = { ...latestSceneRef.current, appState: nextAppState };
    const elements = excalidrawRef.current?.getSceneElements() ?? [];
    const layerAssignments = (cp?.data as { layerAssignments?: Record<string, string> })?.layerAssignments ?? {};
    const files = excalidrawRef.current?.getFiles();
    const data = {
      ...cp?.data,
      elements: [...elements],
      appState: nextAppState,
      layers: nextLayers,
      layerAssignments: { ...layerAssignments },
      ...(files && Object.keys(files).length > 0 ? { files } : {}),
    };
    const nextProjects = projectsRef.current.map((p) =>
      p.id === aid ? { ...p, data: data as WhiteboardProject["data"], updatedAt: Date.now() } : p
    );
    projectsRef.current = nextProjects;
    setProjects(nextProjects);
    lastSavedSceneVerRef.current = null;
    saveSettings(saveWhiteboardProjects(loadSettings(), nextProjects, aid));
  }, []);

  const deleteLayer = useCallback(
    (layerId: string) => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      const projData = currentProject?.data as
        | { layers?: WhiteboardLayer[]; layerAssignments?: Record<string, string>; elements?: unknown[]; appState?: Record<string, unknown>; hiddenLayerIds?: string[] }
        | undefined;
      const layerAssignments = projData?.layerAssignments ?? {};
      const fullElements = (projData?.elements ?? []) as { id: string }[];
      const excalElements = (excalidrawRef.current?.getSceneElements() ?? []) as { id: string }[];
      const visibleIds = new Set(excalElements.map((e) => e.id));
      const hiddenElements = fullElements.filter(
        (el) => (projData?.hiddenLayerIds ?? []).includes(layerAssignments[el.id] ?? "")
      );
      const allElements = [...hiddenElements.filter((el) => !visibleIds.has(el.id)), ...excalElements];
      const kept = allElements.filter((el) => layerAssignments[el.id] !== layerId) as unknown[];
      const newAssignments = { ...layerAssignments };
      for (const el of allElements) {
        if (layerAssignments[el.id] === layerId) delete newAssignments[el.id];
      }
      const layers = (projData?.layers ?? [BASE_LAYER]).filter((l) => l.id !== layerId);
      if (layers.length === 0) layers.push(BASE_LAYER);
      const appState = excalidrawRef.current?.getAppState() ?? {};
      const storedTexture = projData?.appState?.whiteboardTexture as string | undefined;
      const nextAppState = {
        ...appState,
        activeLayerId: "base",
        ...(storedTexture !== undefined && { whiteboardTexture: storedTexture, viewBackgroundColor: "transparent" }),
      };
      const visibleKept = kept.filter(
        (el) => !(projData?.hiddenLayerIds ?? []).includes(newAssignments[(el as { id: string }).id] ?? "")
      );
      excalidrawRef.current?.updateScene({ elements: visibleKept, appState: nextAppState });
      latestSceneRef.current = { elements: visibleKept, appState: nextAppState };
      prevElementIdsRef.current = new Set((kept as { id: string }[]).map((e) => e.id));
      const newHiddenIds = (projData?.hiddenLayerIds ?? []).filter((id) => id !== layerId);
      const files = excalidrawRef.current?.getFiles();
      const data = {
        ...currentProject?.data,
        elements: kept,
        appState: nextAppState,
        layers,
        layerAssignments: newAssignments,
        ...(newHiddenIds.length > 0 ? { hiddenLayerIds: newHiddenIds } : {}),
        ...(files && Object.keys(files).length > 0 ? { files } : {}),
      };
      if (newHiddenIds.length === 0 && (data as { hiddenLayerIds?: string[] }).hiddenLayerIds) {
        delete (data as { hiddenLayerIds?: string[] }).hiddenLayerIds;
      }
      const nextProjects = projects.map((p) =>
        p.id === activeId ? { ...p, data: data as WhiteboardProject["data"], updatedAt: Date.now() } : p
      );
      setProjects(nextProjects);
      saveSettings(saveWhiteboardProjects(loadSettings(), nextProjects, activeId));
    },
    [currentProject, projects, activeId]
  );

  const toggleLayerVisibility = useCallback(
    (layerId: string) => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      const projData = currentProject?.data as
        | { layers?: WhiteboardLayer[]; layerAssignments?: Record<string, string>; elements?: unknown[]; hiddenLayerIds?: string[] }
        | undefined;
      const hiddenIds = projData?.hiddenLayerIds ?? [];
      const isHidden = hiddenIds.includes(layerId);
      const newHiddenIds = isHidden ? hiddenIds.filter((id) => id !== layerId) : [...hiddenIds, layerId];
      const layerAssignments = projData?.layerAssignments ?? {};
      const excalElements = (excalidrawRef.current?.getSceneElements() ?? []) as { id: string }[];
      const visibleIds = new Set(excalElements.map((e) => e.id));
      const hiddenElements = ((projData?.elements ?? []) as { id: string }[]).filter((el) =>
        hiddenIds.includes(layerAssignments[el.id] ?? "")
      );
      const fullElements = [...hiddenElements.filter((el) => !visibleIds.has(el.id)), ...excalElements];
      const visibleElements = fullElements.filter(
        (el) => !newHiddenIds.includes(layerAssignments[(el as { id: string }).id] ?? "")
      );
      excalidrawRef.current?.updateScene({ elements: visibleElements });
      latestSceneRef.current = { ...latestSceneRef.current, elements: [...visibleElements] };
      const data = {
        ...currentProject?.data,
        elements: fullElements,
        hiddenLayerIds: newHiddenIds.length > 0 ? newHiddenIds : undefined,
      };
      if (!data.hiddenLayerIds) delete (data as { hiddenLayerIds?: string[] }).hiddenLayerIds;
      const nextProjects = projects.map((p) =>
        p.id === activeId ? { ...p, data: data as WhiteboardProject["data"], updatedAt: Date.now() } : p
      );
      setProjects(nextProjects);
      saveSettings(saveWhiteboardProjects(loadSettings(), nextProjects, activeId));
    },
    [currentProject, projects, activeId]
  );

  const setActiveLayer = useCallback(
    (layerId: string) => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      const projData = currentProject?.data as { appState?: Record<string, unknown> } | undefined;
      const storedTexture = projData?.appState?.whiteboardTexture as string | undefined;
      const appState = excalidrawRef.current?.getAppState() ?? {};
      const nextAppState = {
        ...appState,
        activeLayerId: layerId,
        ...(storedTexture !== undefined && { whiteboardTexture: storedTexture, viewBackgroundColor: "transparent" }),
      };
      excalidrawRef.current?.updateScene({ appState: nextAppState });
      latestSceneRef.current = { ...latestSceneRef.current, appState: nextAppState };
      const data = {
        ...currentProject?.data,
        appState: nextAppState,
      };
      const nextProjects = projects.map((p) =>
        p.id === activeId ? { ...p, data: data as WhiteboardProject["data"], updatedAt: Date.now() } : p
      );
      setProjects(nextProjects);
      saveSettings(saveWhiteboardProjects(loadSettings(), nextProjects, activeId));
    },
    [currentProject, projects, activeId]
  );

  const applyTexture = useCallback(
    (textureId: string) => {
      const appState = excalidrawRef.current?.getAppState() ?? {};
      const next = {
        ...appState,
        whiteboardTexture: textureId || undefined,
        viewBackgroundColor: textureId ? "transparent" : "#ffffff",
      };
      if (!textureId) delete next.whiteboardTexture;
      excalidrawRef.current?.updateScene({ appState: next });
      latestSceneRef.current = { ...latestSceneRef.current, appState: next };
      persist(excalidrawRef.current?.getSceneElements() ?? [], next);
      setTextureDialog(false);
    },
    [persist]
  );

  const applyRename = useCallback(
    (id: string, name: string) => {
      const proj = projects.find((p) => p.id === id);
      if (!proj) return;
      const trimmed = name.trim() || "Untitled";
      if (trimmed === proj.name) return;
      const next = projects.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
      setProjects(next);
      saveSettings(saveWhiteboardProjects(loadSettings(), next, activeId));
    },
    [projects, activeId]
  );

  const openSaveAsDialog = useCallback(() => setSaveAsDialog(true), []);

  const confirmSaveAs = useCallback(
    (name: string) => {
      const trimmed = name.trim() || "Untitled";
      const id = "proj-" + Date.now();
      const { elements, appState } = latestSceneRef.current;
      const aid = activeIdRef.current;
      const projSnap = projectsRef.current.find((p) => p.id === aid);
      const projData = projSnap?.data as
        | {
            appState?: Record<string, unknown>;
            files?: Record<string, unknown>;
            layerAssignments?: Record<string, string>;
            layers?: WhiteboardLayer[];
            hiddenLayerIds?: string[];
            elements?: unknown[];
          }
        | undefined;
      const textureRaw = appState.whiteboardTexture ?? projData?.appState?.whiteboardTexture;
      const texStr =
        typeof textureRaw === "string" && textureRaw.length > 0
          ? textureRaw
          : undefined;
      const appStateWithTexture =
        texStr !== undefined
          ? { ...appState, whiteboardTexture: texStr, viewBackgroundColor: "transparent" }
          : appState;
      const files = mergeFileMaps(projData?.files, latestSceneRef.current.files, excalidrawRef.current?.getFiles());
      const layers = projData?.layers ?? [BASE_LAYER];
      const layerAssignments = projData?.layerAssignments ?? {};
      const hiddenIds = projData?.hiddenLayerIds ?? [];
      const hiddenElements = ((projData?.elements ?? []) as { id: string }[]).filter((el) =>
        hiddenIds.includes(layerAssignments[el.id] ?? "")
      );
      const visibleIds = new Set((elements as { id: string }[]).map((e) => e.id));
      const fullElements = [...hiddenElements.filter((el) => !visibleIds.has(el.id)), ...elements];
      const tex = texStr;
      const data = {
        elements: fullElements,
        appState: appStateWithTexture,
        layers,
        layerAssignments: { ...layerAssignments },
        ...(hiddenIds.length > 0 ? { hiddenLayerIds: hiddenIds } : {}),
        ...(Object.keys(files).length > 0 ? { files } : {}),
      };
      if (tex || Object.keys(files).length > 0) {
        const dw: DreamworkFilePayload = { v: 1 };
        if (tex) dw.whiteboardTexture = tex;
        if (Object.keys(files).length > 0) dw.files = files;
        (data as { dreamwork?: DreamworkFilePayload }).dreamwork = dw;
      }
      const proj: WhiteboardProject = {
        id,
        name: trimmed,
        data,
        updatedAt: Date.now(),
      };
      const next = [...projectsRef.current, proj];
      projectsRef.current = next;
      setProjects(next);
      setActiveId(id);
      activeIdRef.current = id;
      lastSavedSceneVerRef.current = null;
      saveSettings(saveWhiteboardProjects(loadSettings(), next, id));
      setSaveAsDialog(false);
    },
    []
  );

  const handleLoadScene = useCallback(async () => {
    if (isElectron && electronAPI?.openFile) {
      const result = await electronAPI.openFile([{ name: "Excalidraw", extensions: ["excalidraw", "json"] }]);
      if (!result?.content) return;
      flushPersist();
      const parsed = JSON.parse(result.content) as {
        elements?: unknown[];
        appState?: Record<string, unknown>;
        files?: Record<string, unknown>;
        dreamwork?: DreamworkFilePayload;
        layers?: WhiteboardLayer[];
        layerAssignments?: Record<string, string>;
        hiddenLayerIds?: string[];
      };
      const blob = new Blob([result.content], { type: "application/json" });
      const scene = (await loadFromBlob(blob, null, null)) as {
        elements: unknown[];
        appState: Record<string, unknown>;
        files?: Record<string, unknown>;
      };
      const layerAssignments = parsed.layerAssignments && typeof parsed.layerAssignments === "object" ? parsed.layerAssignments : {};
      const hiddenIds = Array.isArray(parsed.hiddenLayerIds) ? parsed.hiddenLayerIds : [];
      const visibleElements =
        hiddenIds.length > 0
          ? (scene.elements as { id: string }[]).filter(
              (el) => !hiddenIds.includes(layerAssignments[el.id] ?? "base")
            )
          : scene.elements;
      const dw = parsed.dreamwork;
      // dreamwork first: written by DreamWorks on save; Excalidraw restore can still drop custom blobs.
      const mergedFilesRaw = mergeFileMaps(dw?.files, parsed.files, scene.files);
      const mergedFiles = Object.keys(mergedFilesRaw).length > 0 ? mergedFilesRaw : undefined;
      const rawSavedApp = parsed.appState as Record<string, unknown> | undefined;
      const textureFromFile =
        (typeof dw?.whiteboardTexture === "string" && dw.whiteboardTexture
          ? dw.whiteboardTexture
          : undefined) ??
        (typeof rawSavedApp?.whiteboardTexture === "string" && rawSavedApp.whiteboardTexture
          ? rawSavedApp.whiteboardTexture
          : undefined);
      const mergedAppState = {
        ...scene.appState,
        ...(textureFromFile
          ? { whiteboardTexture: textureFromFile, viewBackgroundColor: "transparent" }
          : {}),
      };
      const { collaborators: _c, ...appRest } = mergedAppState as Record<string, unknown> & { collaborators?: unknown };
      latestSceneRef.current = {
        elements: [...visibleElements],
        appState: appRest as Record<string, unknown>,
        ...(mergedFiles ? { files: mergedFiles } : {}),
      };
      prevElementIdsRef.current = new Set((scene.elements as { id: string }[]).map((e) => e.id));
      const dwOut: DreamworkFilePayload = { v: 1 };
      if (textureFromFile) dwOut.whiteboardTexture = textureFromFile;
      if (mergedFiles) dwOut.files = mergedFiles;
      const data = {
        elements: scene.elements,
        appState: mergedAppState,
        ...(mergedFiles ? { files: mergedFiles } : {}),
        ...((textureFromFile || mergedFiles) ? { dreamwork: dwOut } : {}),
        layers:
          Array.isArray(parsed.layers) && parsed.layers.every((l: unknown) => l && typeof (l as { id?: unknown }).id === "string" && typeof (l as { name?: unknown }).name === "string")
            ? (parsed.layers as WhiteboardLayer[])
            : [BASE_LAYER],
        layerAssignments,
        ...(hiddenIds.length > 0 ? { hiddenLayerIds: hiddenIds } : {}),
      };
      const newId = "proj-" + Date.now();
      const proj: WhiteboardProject = {
        id: newId,
        name: projectNameFromOpenPath(result.path),
        data: data as WhiteboardProject["data"],
        updatedAt: Date.now(),
      };
      const next = [...projectsRef.current, proj];
      projectsRef.current = next;
      setProjects(next);
      setActiveId(newId);
      activeIdRef.current = newId;
      lastSavedSceneVerRef.current = getSceneVersion(scene.elements as never);
      saveSettings(saveWhiteboardProjects(loadSettings(), next, newId));
    }
  }, [isElectron, electronAPI, flushPersist]);

  const handleSaveToFile = useCallback(async () => {
    if (isElectron && electronAPI?.saveFile && excalidrawRef.current) {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      const api = excalidrawRef.current;
      const aid = activeIdRef.current;
      const project = projectsRef.current.find((p) => p.id === aid);
      const visibleElements = api.getSceneElements();
      const projData = project?.data as {
        elements?: unknown[];
        appState?: Record<string, unknown>;
        files?: Record<string, unknown>;
        layers?: WhiteboardLayer[];
        layerAssignments?: Record<string, string>;
        hiddenLayerIds?: string[];
      } | undefined;
      const hiddenIds = projData?.hiddenLayerIds ?? [];
      const layerAssignments = projData?.layerAssignments ?? {};
      const hiddenElements = ((projData?.elements ?? []) as { id: string }[]).filter((el) =>
        hiddenIds.includes(layerAssignments[el.id] ?? "")
      );
      const visibleIds = new Set((visibleElements as { id: string }[]).map((e) => e.id));
      const fullElements = [...hiddenElements.filter((el) => !visibleIds.has(el.id)), ...visibleElements];
      const rawAppState = api.getAppState();
      const textureRaw =
        (rawAppState as Record<string, unknown>).whiteboardTexture ?? projData?.appState?.whiteboardTexture;
      const texture = typeof textureRaw === "string" && textureRaw.length > 0 ? textureRaw : undefined;
      const appState =
        texture !== undefined
          ? { ...rawAppState, whiteboardTexture: texture, viewBackgroundColor: "transparent" }
          : rawAppState;
      const filesMerged = mergeFileMaps(projData?.files, latestSceneRef.current.files, api.getFiles());
      latestSceneRef.current = {
        elements: [...fullElements],
        appState: { ...(appState as Record<string, unknown>) },
        ...(Object.keys(filesMerged).length > 0 ? { files: filesMerged } : {}),
      };
      const json = serializeAsJSON(
        fullElements as Parameters<typeof serializeAsJSON>[0],
        appState as Parameters<typeof serializeAsJSON>[1],
        filesMerged as Parameters<typeof serializeAsJSON>[2],
        "local"
      );
      const parsed = JSON.parse(json) as Record<string, unknown>;
      if (!parsed.appState || typeof parsed.appState !== "object") parsed.appState = {};
      const appStateInJson = parsed.appState as Record<string, unknown>;
      if (texture !== undefined) {
        appStateInJson.whiteboardTexture = texture;
        appStateInJson.viewBackgroundColor = "transparent";
      }
      // Force files onto disk: serializeAsJSON can still omit entries vs. live scene.
      if (Object.keys(filesMerged).length > 0) {
        parsed.files = mergeFileMaps(parsed.files, filesMerged) as Record<string, unknown>;
      }
      const dw: DreamworkFilePayload = { v: 1 };
      if (texture !== undefined) dw.whiteboardTexture = texture;
      if (Object.keys(filesMerged).length > 0) dw.files = filesMerged;
      parsed.dreamwork = dw;
      if (projData?.layers?.length) parsed.layers = projData.layers;
      if (projData?.layerAssignments && Object.keys(projData.layerAssignments ?? {}).length > 0) parsed.layerAssignments = projData.layerAssignments;
      if (hiddenIds.length > 0) parsed.hiddenLayerIds = hiddenIds;
      const finalJson = JSON.stringify(parsed);
      await electronAPI.saveFile(finalJson, `${project?.name ?? "drawing"}.excalidraw`, [
        { name: "Excalidraw", extensions: ["excalidraw", "json"] },
      ]);
    }
  }, [isElectron, electronAPI]);

  const handleExport = useCallback(async () => {
    await handleSaveToFile();
  }, [handleSaveToFile]);

  const handleExportImage = useCallback(async () => {
    if (isElectron && electronAPI?.saveImage && excalidrawRef.current) {
      const project = projectsRef.current.find((p) => p.id === activeIdRef.current);
      const elements = excalidrawRef.current.getSceneElements();
      const rawAppState = excalidrawRef.current.getAppState();
      const projData = project?.data as {
        appState?: Record<string, unknown>;
        files?: Record<string, unknown>;
      } | undefined;
      const texture =
        (rawAppState as Record<string, unknown>).whiteboardTexture ??
        projData?.appState?.whiteboardTexture;
      const appState =
        texture !== undefined ? { ...rawAppState, whiteboardTexture: texture } : rawAppState;
      const files = mergeFileMaps(projData?.files, latestSceneRef.current.files, excalidrawRef.current.getFiles());
      const blob = await exportToBlob({
        elements: elements as Parameters<typeof exportToBlob>[0]["elements"],
        appState: appState as Parameters<typeof exportToBlob>[0]["appState"],
        files: files as Parameters<typeof exportToBlob>[0]["files"],
        mimeType: "image/png",
      });
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve((r.result as string).split(",")[1] ?? "");
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
      await electronAPI.saveImage(base64, `${project?.name ?? "export"}.png`);
    }
  }, [isElectron, electronAPI]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const t = setTimeout(() => document.addEventListener("click", close), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("click", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!renameDialog) return;
    const t = setTimeout(() => renameInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [renameDialog]);

  useEffect(() => {
    if (!saveAsDialog) return;
    const t = setTimeout(() => saveAsInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [saveAsDialog]);

  const contextMenuPortal =
    contextMenu &&
    createPortal(
      <div
        className="fixed z-[9999] min-w-[120px] rounded-md border border-gray-200 bg-white py-1 shadow-lg"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="block w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100"
          onClick={() => {
            setRenameDialog({ projectId: contextMenu.projectId });
            setContextMenu(null);
          }}
        >
          Rename
        </button>
        <button
          type="button"
          className="block w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={projects.length <= 1}
          onClick={() => {
            deleteProject(contextMenu.projectId);
            setContextMenu(null);
          }}
        >
          Delete
        </button>
      </div>,
      document.body
    );

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onCanvasLayersChange) return;

    const collect = () => {
      const layers = Array.from(root.querySelectorAll("canvas")).filter(
        (el): el is HTMLCanvasElement => el instanceof HTMLCanvasElement
      );
      onCanvasLayersChange(layers);
    };

    let rafId = 0;
    const scheduleCollect = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        collect();
      });
    };

    collect();
    // Avoid attributes: true — Excalidraw updates styles/transforms constantly while panning/zooming,
    // which fired this observer + querySelectorAll hundreds of times per second and janked the UI.
    const mo = new MutationObserver(scheduleCollect);
    mo.observe(root, { childList: true, subtree: true });
    const ro = new ResizeObserver(scheduleCollect);
    ro.observe(root);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      mo.disconnect();
      ro.disconnect();
      onCanvasLayersChange([]);
    };
  }, [onCanvasLayersChange]);

  const menuSig = projects.map((p) => `${p.id}:${p.name}`).join("|");
  if (menuSig !== menuSigRef.current) {
    menuSigRef.current = menuSig;
    menuRowsRef.current = projects.map((p) => ({ id: p.id, name: p.name }));
  }

  const excalidrawMainMenu = useMemo(
    () => {
      const menuRows = menuRowsRef.current;
      return (
        <MainMenu>
          {isElectron ? (
            <MainMenu.Item onSelect={handleLoadScene}>Open</MainMenu.Item>
          ) : (
            <MainMenu.DefaultItems.LoadScene />
          )}
          {isElectron ? (
            <MainMenu.Item onSelect={handleSaveToFile}>Save to...</MainMenu.Item>
          ) : (
            <MainMenu.DefaultItems.SaveToActiveFile />
          )}
          {isElectron ? (
            <MainMenu.Item onSelect={handleExport}>Export...</MainMenu.Item>
          ) : (
            <MainMenu.DefaultItems.Export />
          )}
          {isElectron ? (
            <MainMenu.Item onSelect={handleExportImage}>Export image...</MainMenu.Item>
          ) : (
            <MainMenu.DefaultItems.SaveAsImage />
          )}
          <MainMenu.Separator />
          <MainMenu.Item onSelect={triggerUndo}>Undo</MainMenu.Item>
          <MainMenu.Item onSelect={triggerRedo}>Redo</MainMenu.Item>
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.Group title="Project">
            {menuRows.map((p) => (
              <MainMenu.Item
                key={p.id}
                onSelect={() => switchProject(p.id)}
                selected={p.id === activeId}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, projectId: p.id });
                }}
              >
                {p.name}
              </MainMenu.Item>
            ))}
            <MainMenu.Item onSelect={newProject}>New project</MainMenu.Item>
            <MainMenu.Item onSelect={openSaveAsDialog}>Save as...</MainMenu.Item>
          </MainMenu.Group>
          <MainMenu.Separator />
          <MainMenu.Group title="Layers">
            <MainMenu.Item onSelect={() => setLayersDialog(true)}>Layers...</MainMenu.Item>
            <MainMenu.Item onSelect={addAnnotationsLayer}>New annotation layer</MainMenu.Item>
          </MainMenu.Group>
          <MainMenu.Separator />
          <MainMenu.Group title="Paper texture">
            <MainMenu.Item onSelect={() => setTextureDialog(true)}>Choose texture...</MainMenu.Item>
          </MainMenu.Group>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.Socials />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      );
    },
    [
      menuSig,
      activeId,
      isElectron,
      triggerUndo,
      triggerRedo,
      handleLoadScene,
      handleSaveToFile,
      handleExport,
      handleExportImage,
      switchProject,
      newProject,
      openSaveAsDialog,
      addAnnotationsLayer,
    ]
  );

  if (!ready) {
    return (
      <div ref={rootRef} className="flex h-full w-full min-h-[200px] flex-col bg-white">
        <div className="flex flex-1 items-center justify-center">
          <div className="animate-pulse text-sm text-gray-400">Loading whiteboard...</div>
        </div>
      </div>
    );
  }

  const renameDialogProject = renameDialog ? projects.find((p) => p.id === renameDialog.projectId) : null;

  return (
    <>
      {contextMenuPortal}
      {renameDialog && renameDialogProject &&
        createPortal(
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/30"
            onClick={() => setRenameDialog(null)}
          >
            <div
              className="rounded-lg border border-gray-200 bg-white p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <label className="mb-2 block text-sm font-medium text-gray-700">Project name</label>
              <input
                ref={renameInputRef}
                type="text"
                defaultValue={renameDialogProject.name}
                className="mb-3 w-64 rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    applyRename(renameDialog.projectId, (e.target as HTMLInputElement).value);
                    setRenameDialog(null);
                  }
                  if (e.key === "Escape") setRenameDialog(null);
                }}
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded px-3 py-1 text-sm text-gray-600 hover:bg-gray-100"
                  onClick={() => setRenameDialog(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700"
                  onClick={() => {
                    const val = renameInputRef.current?.value ?? "";
                    applyRename(renameDialog.projectId, val);
                    setRenameDialog(null);
                  }}
                >
                  OK
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      {saveAsDialog &&
        createPortal(
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/30"
            onClick={() => setSaveAsDialog(false)}
          >
            <div
              className="rounded-lg border border-gray-200 bg-white p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <label className="mb-2 block text-sm font-medium text-gray-700">Project name</label>
              <input
                ref={saveAsInputRef}
                type="text"
                defaultValue="Untitled"
                className="mb-3 w-64 rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    confirmSaveAs((e.target as HTMLInputElement).value);
                  }
                  if (e.key === "Escape") setSaveAsDialog(false);
                }}
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded px-3 py-1 text-sm text-gray-600 hover:bg-gray-100"
                  onClick={() => setSaveAsDialog(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700"
                  onClick={() => {
                    const val = saveAsInputRef.current?.value ?? "";
                    confirmSaveAs(val);
                  }}
                >
                  OK
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      {layersDialog &&
        createPortal(
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/30"
            onClick={() => setLayersDialog(false)}
          >
            <div
              className="max-h-[80vh] w-[320px] overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="mb-3 text-sm font-medium text-gray-700">Layers</h3>
              <div className="space-y-1">
                {((currentProject?.data as { layers?: WhiteboardLayer[] } | undefined)?.layers ?? [BASE_LAYER]).map(
                  (layer) => {
                    const hiddenIds = (currentProject?.data as { hiddenLayerIds?: string[] } | undefined)?.hiddenLayerIds ?? [];
                    const isHidden = hiddenIds.includes(layer.id);
                    const isActive =
                      ((currentProject?.data?.appState as Record<string, unknown>)?.activeLayerId as string) === layer.id;
                    return (
                      <div
                        key={layer.id}
                        className={`flex items-center gap-2 rounded px-2 py-1.5 ${
                          isActive ? "bg-blue-50" : "hover:bg-gray-50"
                        }`}
                      >
                        <button
                          type="button"
                          className="shrink-0 rounded p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
                          onClick={() => toggleLayerVisibility(layer.id)}
                          title={isHidden ? "Show layer" : "Hide layer"}
                        >
                          {isHidden ? (
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                            </svg>
                          ) : (
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                          )}
                        </button>
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left text-sm"
                          onClick={() => {
                            if (isHidden) toggleLayerVisibility(layer.id);
                            setActiveLayer(layer.id);
                          }}
                        >
                          {layer.name}
                        </button>
                        {isAnnotationLayer(layer.id) && (
                          <button
                            type="button"
                            className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-red-100 hover:text-red-600"
                            onClick={() => {
                              deleteLayer(layer.id);
                            }}
                            title="Delete layer"
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )}
                      </div>
                    );
                  }
                )}
              </div>
              <button
                type="button"
                className="mt-3 w-full rounded border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
                onClick={() => {
                  addAnnotationsLayer();
                  setLayersDialog(false);
                }}
              >
                New annotation layer
              </button>
            </div>
          </div>,
          document.body
        )}
      {textureDialog &&
        createPortal(
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/30"
            onClick={() => setTextureDialog(false)}
          >
            <div
              className="max-h-[80vh] w-[480px] overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="mb-3 text-sm font-medium text-gray-700">Paper texture</h3>
              <div className="grid grid-cols-4 gap-2">
                {WHITEBOARD_TEXTURES.map((t) => (
                  <button
                    key={t.id || "none"}
                    type="button"
                    className={`flex flex-col items-center rounded border p-2 transition ${
                      storedTexture === t.id || (!storedTexture && !t.id)
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                    onClick={() => applyTexture(t.id)}
                  >
                    {t.id ? (
                      <div
                        className="mb-1 h-12 w-12 shrink-0 rounded bg-gray-100 bg-cover bg-center"
                        style={{ backgroundImage: `url(${TEXTURE_BASE}${t.id})` }}
                      />
                    ) : (
                      <div className="mb-1 h-12 w-12 shrink-0 rounded bg-white border border-gray-200" />
                    )}
                    <span className="text-xs text-gray-600">{t.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>,
          document.body
        )}
      <div ref={rootRef} className="relative flex h-full w-full min-h-[200px] flex-col bg-white">
      {gestureBarVisible && (
        <div
          className="absolute bottom-4 left-1/2 z-50 flex -translate-x-1/2 gap-2 rounded-lg border border-gray-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur"
          data-dreamwork-no-intercept
        >
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
            onClick={() => {
              triggerUndo();
            }}
            title="Undo"
          >
            Undo
          </button>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
            onClick={() => {
              triggerRedo();
            }}
            title="Redo"
          >
            Redo
          </button>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
            onClick={() => {
              triggerClearCanvas();
            }}
            title="Clear canvas"
          >
            Clear
          </button>
          <button
            type="button"
            className="rounded px-2 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
            onClick={() => setGestureBarVisible(false)}
            title="Close"
          >
            ✕
          </button>
        </div>
      )}
      {storedTexture && (
        <div
          className="absolute inset-0 z-0 bg-cover bg-center bg-repeat pointer-events-none"
          style={{ backgroundImage: `url(${TEXTURE_BASE}${storedTexture})` }}
        />
      )}
      <div
        className={`dreamwork-whiteboard-touch relative z-10 min-h-0 flex-1${storedTexture ? " dreamwork-whiteboard-has-paper" : ""}`}
        style={storedTexture ? { backgroundColor: "transparent" } : undefined}
      >
        <Excalidraw
        key={activeId}
        langCode="en"
        viewModeEnabled={false}
        initialData={(initialData ?? undefined) as React.ComponentProps<typeof Excalidraw>["initialData"]}
        onChange={handleChange as unknown as React.ComponentProps<typeof Excalidraw>["onChange"]}
        excalidrawAPI={bindExcalidrawApi}
        UIOptions={excalidrawUiOptions}
      >
        {excalidrawMainMenu}
      </Excalidraw>
      </div>
    </div>
    </>
  );
}
