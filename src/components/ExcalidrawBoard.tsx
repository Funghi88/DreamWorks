import { useEffect, useRef, useState, useCallback } from "react";
import { Excalidraw, MainMenu, loadFromBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import {
  loadSettings,
  loadSettingsAsync,
  saveSettings,
  getWhiteboardProjects,
  saveWhiteboardProjects,
  type WhiteboardProject,
} from "@/lib/storage";

type Props = {
  onCanvasLayersChange?: (layers: HTMLCanvasElement[]) => void;
};

type ExcalidrawAPI = {
  updateScene: (s: { elements: unknown[]; appState: Record<string, unknown> }) => void;
  getSceneElements: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
};

export function ExcalidrawBoard({ onCanvasLayersChange }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [projects, setProjects] = useState<WhiteboardProject[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [ready, setReady] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSceneRef = useRef<{ elements: unknown[]; appState: Record<string, unknown> }>({ elements: [], appState: {} });
  const excalidrawRef = useRef<ExcalidrawAPI | null>(null);

  const isElectron =
    typeof window !== "undefined" && !!(window as unknown as { electronAPI?: unknown }).electronAPI;
  const electronAPI = isElectron
    ? (window as unknown as { electronAPI?: { openFile?: (f?: unknown) => Promise<{ path: string; content: string } | null>; saveFile?: (c: string, n?: string, f?: unknown) => Promise<boolean> } })
        .electronAPI
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

  const currentProject = projects.find((p) => p.id === activeId);
  const initialData = currentProject?.data ?? undefined;

  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { setWindowTitle?: (t: string) => Promise<void> } }).electronAPI;
    if (api?.setWindowTitle && currentProject?.name) {
      api.setWindowTitle(currentProject.name);
    }
  }, [currentProject?.name]);

  const persist = useCallback(
    (elements: readonly unknown[], appState: Record<string, unknown>) => {
      const { collaborators: _, ...rest } = appState;
      const data = { elements: [...elements], appState: rest };
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

  const saveAsNew = useCallback(() => {
    const name = (typeof window !== "undefined" ? window.prompt("Project name:", "Untitled") : null) || "Untitled";
    const id = "proj-" + Date.now();
    const { elements, appState } = latestSceneRef.current;
    const proj: WhiteboardProject = {
      id,
      name,
      data: { elements: [...elements], appState: { ...appState } },
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
      const scene = (await loadFromBlob(blob, null, null)) as { elements: unknown[]; appState: Record<string, unknown> };
      excalidrawRef.current.updateScene({
        elements: scene.elements,
        appState: scene.appState,
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

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

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

  return (
    <div ref={rootRef} className="h-full w-full min-h-[200px] bg-white">
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
          <MainMenu.DefaultItems.SaveAsImage />
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
              >
                {p.name}
              </MainMenu.Item>
            ))}
            <MainMenu.Item onSelect={newProject}>New project</MainMenu.Item>
            <MainMenu.Item onSelect={saveAsNew}>Save as...</MainMenu.Item>
          </MainMenu.Group>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.Socials />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
