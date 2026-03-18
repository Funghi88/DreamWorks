import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { Excalidraw, MainMenu, loadFromBlob, serializeAsJSON, exportToBlob } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./ExcalidrawBoard.css";
import {
  loadSettings,
  loadSettingsAsync,
  saveSettings,
  getWhiteboardProjects,
  saveWhiteboardProjects,
  type WhiteboardProject,
} from "@/lib/storage";

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

type Props = {
  onCanvasLayersChange?: (layers: HTMLCanvasElement[]) => void;
};

type ExcalidrawAPI = {
  updateScene: (s: { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> }) => void;
  getSceneElements: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
};

export function ExcalidrawBoard({ onCanvasLayersChange }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [projects, setProjects] = useState<WhiteboardProject[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [ready, setReady] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; projectId: string } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ projectId: string } | null>(null);
  const [textureDialog, setTextureDialog] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSceneRef = useRef<{ elements: unknown[]; appState: Record<string, unknown> }>({ elements: [], appState: {} });
  const excalidrawRef = useRef<ExcalidrawAPI | null>(null);
  const twoFingerRef = useRef<{ startTime: number; startX: number; startY: number } | null>(null);

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

  // Two/three-finger gesture to undo (iPad Sidecar + Apple Pencil)
  useEffect(() => {
    if (!ready) return;
    const root = rootRef.current;
    if (!root) return;

    const isInWhiteboard = (target: EventTarget | null) =>
      target && root.contains(target as Node);

    const triggerUndo = () => {
      const api = excalidrawRef.current as { executeAction?: (name: string) => void } | null;
      if (api?.executeAction) {
        api.executeAction("undo");
      } else {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "z", code: "KeyZ", metaKey: true, bubbles: true })
        );
      }
    };

    // Touch events (direct iPad / mobile)
    const onTouchStart = (e: TouchEvent) => {
      if (!isInWhiteboard(e.target)) return;
      if (e.touches.length >= 2) {
        twoFingerRef.current = { startTime: Date.now(), startX: 0, startY: 0 };
      } else {
        twoFingerRef.current = null;
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!isInWhiteboard(e.target)) return;
      const state = twoFingerRef.current;
      if (!state || e.touches.length !== 0) return;
      const elapsed = Date.now() - state.startTime;
      if (elapsed < 1000) {
        e.preventDefault();
        triggerUndo();
      }
      twoFingerRef.current = null;
    };

    // Pointer events (Sidecar: iPad touch → pointer on Mac, exclude Apple Pencil)
    const touchPointers = new Map<number, number>(); // pointerId -> pointerId (only touch type)
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
      touchPointers.delete(e.pointerId);
      if (touchPointers.size === 0) pointerInWhiteboardRef.current = false;
      if (hadTwoTouch && touchPointers.size === 0) {
        const elapsed = Date.now() - pointerStartRef.current;
        if (elapsed < 1000) {
          e.preventDefault();
          triggerUndo();
        }
      }
    };

    // Wheel: Sidecar 两指横滑可能转为 wheel (deltaX)
    const wheelDebounceRef = { last: 0 };
    const onWheel = (e: WheelEvent) => {
      if (!isInWhiteboard(e.target)) return;
      if (e.ctrlKey || e.metaKey) return; // 不干扰 pinch zoom
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
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      document.removeEventListener("touchstart", onTouchStart, { capture: true });
      document.removeEventListener("touchend", onTouchEnd, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      document.removeEventListener("pointerup", onPointerUp, { capture: true });
      document.removeEventListener("pointercancel", onPointerUp, { capture: true });
      document.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [ready]);

  const currentProject = projects.find((p) => p.id === activeId);
  const storedTexture = (currentProject?.data?.appState as Record<string, unknown> | undefined)?.whiteboardTexture as string | undefined;
  const initialData = currentProject?.data
    ? {
        elements: currentProject.data.elements,
        appState: {
          ...currentProject.data.appState,
          ...(storedTexture ? { viewBackgroundColor: "#ffffff00" } : {}),
        },
        // 图片等文件数据必须传入，否则 pack 后重开会变空
        ...(currentProject.data.files && Object.keys(currentProject.data.files).length > 0
          ? { files: currentProject.data.files }
          : {}),
      }
    : undefined;

  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { setWindowTitle?: (t: string) => Promise<void> } }).electronAPI;
    if (api?.setWindowTitle && currentProject?.name) {
      api.setWindowTitle(currentProject.name);
    }
  }, [currentProject?.name]);

  const persist = useCallback(
    (elements: readonly unknown[], appState: Record<string, unknown>) => {
      const { collaborators: _, ...rest } = appState;
      const files = excalidrawRef.current?.getFiles();
      const data: { elements: unknown[]; appState: Record<string, unknown>; files?: Record<string, unknown> } = {
        elements: [...elements],
        appState: rest,
      };
      if (files && Object.keys(files).length > 0) data.files = files;
      const now = Date.now();
      const nextProjects = projects.map((p) =>
        p.id === activeId ? { ...p, data, name: p.name, updatedAt: now } : p
      );
      if (!nextProjects.some((p) => p.id === activeId)) {
        nextProjects.push({ id: activeId, name: currentProject?.name ?? "Untitled", data, updatedAt: now });
      }
      const next = saveWhiteboardProjects(loadSettings(), nextProjects, activeId);
      if (isElectron) {
        loadSettingsAsync().then((s) => {
          const merged = { ...s, whiteboardProjects: nextProjects, activeProjectId: activeId };
          if (merged.whiteboardData) delete merged.whiteboardData;
          saveSettings(merged);
        });
      } else {
        saveSettings(next);
      }
      setProjects(nextProjects);
    },
    [projects, activeId, currentProject?.name, isElectron]
  );

  const handleChange = useCallback(
    (elements: readonly unknown[], appState: Record<string, unknown>) => {
      const { collaborators: _, ...rest } = appState;
      latestSceneRef.current = { elements: [...elements], appState: rest };
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => persist(elements, appState), 500);
    },
    [persist]
  );

  const switchProject = useCallback((id: string) => {
    const proj = projects.find((p) => p.id === id);
    if (!proj || id === activeId) return;
    setActiveId(id);
  }, [projects, activeId]);

  const newProject = useCallback(() => {
    const id = "proj-" + Date.now();
    const proj: WhiteboardProject = {
      id,
      name: "Untitled",
      data: { elements: [], appState: {} },
      updatedAt: Date.now(),
    };
    const next = [...projects, proj];
    setProjects(next);
    setActiveId(id);
    saveSettings(saveWhiteboardProjects(loadSettings(), next, id));
  }, [projects]);

  const deleteProject = useCallback(
    (id: string) => {
      if (projects.length <= 1) return;
      const next = projects.filter((p) => p.id !== id);
      const newActiveId = activeId === id ? (next[0]?.id ?? "default") : activeId;
      setProjects(next);
      setActiveId(newActiveId);
      saveSettings(saveWhiteboardProjects(loadSettings(), next, newActiveId));
    },
    [projects, activeId]
  );

  const applyTexture = useCallback(
    (textureId: string) => {
      const appState = excalidrawRef.current?.getAppState() ?? {};
      const next = {
        ...appState,
        whiteboardTexture: textureId || undefined,
        viewBackgroundColor: textureId ? "#ffffff00" : "#ffffff",
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

  const saveAsNew = useCallback(() => {
    const name = (typeof window !== "undefined" ? window.prompt("Project name:", "Untitled") : null) || "Untitled";
    const id = "proj-" + Date.now();
    const { elements, appState } = latestSceneRef.current;
    const files = excalidrawRef.current?.getFiles();
    const data: { elements: unknown[]; appState: Record<string, unknown>; files?: Record<string, unknown> } = {
      elements: [...elements],
      appState: { ...appState },
    };
    if (files && Object.keys(files).length > 0) data.files = files;
    const proj: WhiteboardProject = {
      id,
      name,
      data,
      updatedAt: Date.now(),
    };
    const next = [...projects, proj];
    setProjects(next);
    setActiveId(id);
    saveSettings(saveWhiteboardProjects(loadSettings(), next, id));
  }, [projects]);

  const handleLoadScene = useCallback(async () => {
    if (isElectron && electronAPI?.openFile) {
      const result = await electronAPI.openFile([{ name: "Excalidraw", extensions: ["excalidraw", "json"] }]);
      if (!result?.content || !excalidrawRef.current) return;
      const blob = new Blob([result.content], { type: "application/json" });
      const scene = (await loadFromBlob(blob, null, null)) as {
        elements: unknown[];
        appState: Record<string, unknown>;
        files?: Record<string, unknown>;
      };
      excalidrawRef.current.updateScene({
        elements: scene.elements,
        appState: scene.appState,
        ...(scene.files && Object.keys(scene.files).length > 0 ? { files: scene.files } : {}),
      });
    }
  }, [isElectron, electronAPI]);

  const handleSaveToFile = useCallback(async () => {
    if (isElectron && electronAPI?.saveFile && excalidrawRef.current) {
      const elements = excalidrawRef.current.getSceneElements();
      const appState = excalidrawRef.current.getAppState();
      const files = excalidrawRef.current.getFiles();
      const json = serializeAsJSON(
        elements as Parameters<typeof serializeAsJSON>[0],
        appState as Parameters<typeof serializeAsJSON>[1],
        files as Parameters<typeof serializeAsJSON>[2],
        "local"
      );
      await electronAPI.saveFile(json, `${currentProject?.name ?? "drawing"}.excalidraw`, [
        { name: "Excalidraw", extensions: ["excalidraw", "json"] },
      ]);
    }
  }, [isElectron, electronAPI, currentProject?.name]);

  const handleExport = useCallback(async () => {
    await handleSaveToFile();
  }, [handleSaveToFile]);

  const handleExportImage = useCallback(async () => {
    if (isElectron && electronAPI?.saveImage && excalidrawRef.current) {
      const elements = excalidrawRef.current.getSceneElements();
      const appState = excalidrawRef.current.getAppState();
      const files = excalidrawRef.current.getFiles();
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
      await electronAPI.saveImage(base64, `${currentProject?.name ?? "export"}.png`);
    }
  }, [isElectron, electronAPI, currentProject?.name]);

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

  if (!ready) {
    return (
      <div ref={rootRef} className="flex h-full w-full min-h-[200px] flex-col bg-white">
        <div className="flex flex-1 items-center justify-center">
          <div className="animate-pulse text-sm text-gray-400">Loading whiteboard...</div>
        </div>
      </div>
    );
  }

  const renderLoadItem = () =>
    isElectron ? (
      <MainMenu.Item onSelect={handleLoadScene}>Open</MainMenu.Item>
    ) : (
      <MainMenu.DefaultItems.LoadScene />
    );

  const renderSaveItem = () =>
    isElectron ? (
      <MainMenu.Item onSelect={handleSaveToFile}>Save to...</MainMenu.Item>
    ) : (
      <MainMenu.DefaultItems.SaveToActiveFile />
    );

  const renderExportItem = () =>
    isElectron ? (
      <MainMenu.Item onSelect={handleExport}>Export...</MainMenu.Item>
    ) : (
      <MainMenu.DefaultItems.Export />
    );

  const renderSaveAsImageItem = () =>
    isElectron ? (
      <MainMenu.Item onSelect={handleExportImage}>Export image...</MainMenu.Item>
    ) : (
      <MainMenu.DefaultItems.SaveAsImage />
    );

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
      {storedTexture && (
        <div
          className="absolute inset-0 z-0 bg-cover bg-center bg-repeat"
          style={{ backgroundImage: `url(${TEXTURE_BASE}${storedTexture})` }}
        />
      )}
      <div className="dreamwork-whiteboard-touch relative z-10 min-h-0 flex-1">
        <Excalidraw
        key={activeId}
        langCode="en"
        viewModeEnabled={false}
        initialData={(initialData ?? undefined) as React.ComponentProps<typeof Excalidraw>["initialData"]}
        onChange={handleChange as unknown as React.ComponentProps<typeof Excalidraw>["onChange"]}
        excalidrawAPI={(api) => {
          excalidrawRef.current = api as unknown as ExcalidrawAPI;
        }}
        UIOptions={{
          canvasActions: {
            loadScene: true,
            saveToActiveFile: true,
            saveAsImage: true,
            changeViewBackgroundColor: true,
            clearCanvas: true,
          },
        }}
      >
        <MainMenu>
          {renderLoadItem()}
          {renderSaveItem()}
          {renderExportItem()}
          {renderSaveAsImageItem()}
          <MainMenu.Separator />
          <MainMenu.Item
            onSelect={() =>
              (excalidrawRef.current as { executeAction?: (n: string) => void } | null)?.executeAction?.("undo")
            }
          >
            Undo
          </MainMenu.Item>
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.Group title="Project">
            {projects.map((p) => (
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
            <MainMenu.Item onSelect={saveAsNew}>Save as...</MainMenu.Item>
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
      </Excalidraw>
      </div>
    </div>
    </>
  );
}
