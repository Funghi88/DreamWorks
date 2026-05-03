const { app, BrowserWindow, ipcMain, screen, session, dialog, systemPreferences, desktopCapturer } = require("electron");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const embeddedSignaling = require("./embedded-signaling.cjs");
const voskStt = require("./vosk-stt.cjs");

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

let mainWindow = null;
const helperWindows = new Map();

/** Pending `getDisplayMedia` callback + sources list until user picks in the renderer (macOS). */
let displayMediaPending = null;

function clearDisplayMediaPending(rejectWithEmpty) {
  if (!displayMediaPending) return;
  if (displayMediaPending.timeoutId) {
    clearTimeout(displayMediaPending.timeoutId);
  }
  if (rejectWithEmpty && typeof displayMediaPending.callback === "function") {
    try {
      displayMediaPending.callback({});
    } catch (_) {
      /* ignore */
    }
  }
  displayMediaPending = null;
}

const APP_NAME = "DreamWorks";

/**
 * Remove this app’s main BrowserWindow from the picker so users pick another app or a full display.
 */
function filterOutMainWindowFromCaptureSources(sources) {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!win || !sources.length) return sources;
  let filtered = sources;
  try {
    if (typeof win.webContents.getMediaSourceId === "function") {
      const selfId = win.webContents.getMediaSourceId();
      if (selfId) {
        const byId = sources.filter((s) => s.id !== selfId);
        if (byId.length) filtered = byId;
      }
    }
  } catch (_) {
    /* ignore */
  }
  if (filtered.length === sources.length) {
    let title = APP_NAME;
    try {
      if (typeof win.getTitle === "function") title = win.getTitle() || APP_NAME;
    } catch (_) {
      /* ignore */
    }
    const norm = (s) => String(s || "").replace(/[\u200e\u200f]/g, "").trim();
    const byName = sources.filter((s) => {
      const n = norm(s.name);
      return n !== norm(title) && n !== APP_NAME;
    });
    if (byName.length) filtered = byName;
  }
  return filtered.length ? filtered : sources;
}

/** JPEG/base64 data URL for picker tiles; returns undefined if image is empty or conversion fails. */
function nativeImageToPickerDataUrl(img) {
  if (!img || (typeof img.isEmpty === "function" && img.isEmpty())) return undefined;
  try {
    const jpeg = img.toJPEG(85);
    if (jpeg && jpeg.length > 40) {
      return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    }
  } catch (_) {
    /* fall through to PNG data URL */
  }
  try {
    const d = img.toDataURL();
    if (d && d.length > 40) return d;
  } catch (_) {
    /* ignore */
  }
  return undefined;
}

/** Prefer live thumbnail; if macOS withheld previews (Screen Recording off), use window app icon when available. */
function pickerPreviewDataUrlForSource(s) {
  const fromThumb = nativeImageToPickerDataUrl(s.thumbnail);
  if (fromThumb) return fromThumb;
  const icon = s.appIcon;
  if (icon && typeof icon.isEmpty === "function" && !icon.isEmpty()) {
    return nativeImageToPickerDataUrl(icon);
  }
  return undefined;
}

/**
 * Thumbnails are blank when Screen Recording is denied; smaller size sometimes still helps after permission.
 * `fetchWindowIcons` fills `appIcon` so window rows show at least the app icon as a fallback preview.
 */
async function getDisplaySourcesForPicker() {
  const large = { width: 720, height: 405 };
  const small = { width: 256, height: 144 };
  const baseOpts = (thumbnailSize) => ({
    types: ["screen", "window"],
    thumbnailSize,
    fetchWindowIcons: true,
  });
  let sources = await desktopCapturer.getSources(baseOpts(large));
  const anyNonEmptyThumb = sources.some((src) => {
    try {
      return src.thumbnail && !src.thumbnail.isEmpty();
    } catch {
      return false;
    }
  });
  if (!anyNonEmptyThumb && sources.length > 0) {
    sources = await desktopCapturer.getSources(baseOpts(small));
  }
  return sources;
}

/**
 * macOS: `getDisplayMedia` needs a `desktopCapturer` handler. We defer `callback` until the user
 * picks a screen/window in the renderer (see `display-media-picker` IPC).
 */
function installDarwinDisplayMediaHandler() {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      clearDisplayMediaPending(true);
      getDisplaySourcesForPicker()
        .then((sources) => {
          if (!sources.length) {
            console.warn("[DreamWorks] desktopCapturer: no sources (Screen Recording permission?)");
            callback({});
            return;
          }
          const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
          if (!wc) {
            callback({});
            return;
          }
          /** Don’t list the main DreamWorks window — choosing it captures the app UI and causes infinite mirror + whiteboard inside Capture Screen. */
          const filteredSources = filterOutMainWindowFromCaptureSources(sources);
          const timeoutId = setTimeout(() => {
            if (displayMediaPending && displayMediaPending.callback === callback) {
              clearDisplayMediaPending(true);
            }
          }, 120000);
          displayMediaPending = { callback, sources: filteredSources, timeoutId };
          const payload = filteredSources.map((s) => ({
            id: s.id,
            name: s.name,
            thumbnailDataUrl: pickerPreviewDataUrlForSource(s),
          }));
          const anyPreview = payload.some((p) => p.thumbnailDataUrl);
          if (!anyPreview && payload.length > 0) {
            let status = "unknown";
            try {
              if (typeof systemPreferences.getMediaAccessStatus === "function") {
                status = systemPreferences.getMediaAccessStatus("screen");
              }
            } catch (_) {
              /* ignore */
            }
            console.warn(
              "[DreamWorks] Picker has no image previews (thumbnails empty). Screen Recording status:",
              status,
              "— On macOS: System Settings → Privacy & Security → Screen Recording → enable DreamWorks (or Electron if you run from dev). Quit and reopen the app after changing."
            );
          }
          wc.send("display-media-picker", payload);
        })
        .catch((err) => {
          console.error("[DreamWorks] desktopCapturer.getSources:", err);
          callback({});
        });
    });
  } catch (e) {
    console.warn("[DreamWorks] setDisplayMediaRequestHandler:", e);
  }
}

function createMainWindow() {
  const iconPath = path.join(__dirname, "icon.png");
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    title: APP_NAME,
    /* Avoid transparent GPU clear flashes before first paint / during resize */
    backgroundColor: "#eef2f7",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    helperWindows.forEach((w) => w.close());
    helperWindows.clear();
    embeddedSignaling.stop();
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Show save dialog when whiteboard exports image
  mainWindow.webContents.session.on("will-download", (event, item) => {
    const name = item.getFilename();
    if (!/\.(png|svg|webp|jpe?g)$/i.test(name)) return;
    item.pause();
    dialog
      .showSaveDialog(mainWindow, {
        defaultPath: name,
        filters: [
          { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "svg"] },
          { name: "PNG", extensions: ["png"] },
          { name: "JPEG", extensions: ["jpg", "jpeg"] },
          { name: "WebP", extensions: ["webp"] },
          { name: "SVG", extensions: ["svg"] },
        ],
      })
      .then(({ canceled, filePath }) => {
        if (canceled || !filePath) {
          item.cancel();
        } else {
          item.setSavePath(filePath);
          item.resume();
        }
      });
  });
}

function createHelperWindow(kind, options = {}) {
  const label = kind === "teleprompter" ? "teleprompter-helper" : "recording-monitor";
  const existing = helperWindows.get(label);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }

  const isTeleprompter = kind === "teleprompter";
  const win = new BrowserWindow({
    width: isTeleprompter ? 760 : 100,
    height: isTeleprompter ? 320 : 100,
    minWidth: isTeleprompter ? 400 : 100,
    minHeight: isTeleprompter ? 180 : 100,
    x: isTeleprompter ? 180 : 24,
    y: isTeleprompter ? 240 : 280,
    resizable: isTeleprompter,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    roundedCorners: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
    ...options,
  });

  const url = isTeleprompter ? "/teleprompter-helper.html" : "/recording-monitor.html";
  if (isDev) {
    win.loadURL(`http://localhost:5173${url}`);
  } else {
    win.loadFile(path.join(__dirname, "../dist", url));
  }

  win.on("closed", () => helperWindows.delete(label));
  helperWindows.set(label, win);
  return win;
}

/** Slim-only window: same stacking as Helper (`alwaysOnTop: true`); opens near bottom of work area. */
function createTeleprompterSlimWindow(options = {}) {
  const label = "teleprompter-slim";
  const existing = helperWindows.get(label);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  /** Narrow bar; default height fits drag strip + toolbar + ~2 text lines at typical font (content sizes in renderer). */
  const winW = 520;
  const winH = 152;
  let pos = { x: 120, y: 100 };
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    pos = {
      x: Math.round(wa.x + (wa.width - winW) / 2),
      y: Math.round(wa.y + wa.height - winH - 16),
    };
  } catch {
    /* keep defaults */
  }
  const win = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 320,
    minHeight: 108,
    x: pos.x,
    y: pos.y,
    resizable: true,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    roundedCorners: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
    ...options,
  });
  const url = "/teleprompter-slim.html";
  if (isDev) {
    win.loadURL(`http://localhost:5173${url}`);
  } else {
    win.loadFile(path.join(__dirname, "../dist", "teleprompter-slim.html"));
  }
  win.on("closed", () => helperWindows.delete(label));
  helperWindows.set(label, win);
  return win;
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

function isEmptySettings(obj) {
  return !obj || (typeof obj === "object" && Object.keys(obj).length === 0);
}

/**
 * User data lives outside the .app (see README). If the primary file is missing/empty,
 * migrate from legacy folder name `dreamwork` (older package name) or optional bundled seed.
 */
function loadSettingsWithMigration(settingsPath) {
  let data = readJsonFile(settingsPath);
  if (!isEmptySettings(data)) return data;

  const userDataDir = path.dirname(settingsPath);
  const appSupport = path.dirname(userDataDir);
  const legacyPath = path.join(appSupport, "dreamwork", "settings.json");
  const legacy = readJsonFile(legacyPath);
  if (!isEmptySettings(legacy)) {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(legacy), "utf8");
      console.log("[DreamWorks] Migrated settings from", legacyPath);
    } catch (e) {
      console.warn("[DreamWorks] Could not write migrated settings:", e);
    }
    return legacy;
  }

  const seedPath = path.join(process.resourcesPath || "", "defaults", "settings.json");
  if (fs.existsSync(seedPath)) {
    const seeded = readJsonFile(seedPath);
    if (!isEmptySettings(seeded)) {
      try {
        fs.mkdirSync(userDataDir, { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(seeded), "utf8");
        console.log("[DreamWorks] Installed default settings from app bundle:", seedPath);
      } catch (e) {
        console.warn("[DreamWorks] Could not install seeded settings:", e);
      }
      return seeded;
    }
  }

  return data || {};
}

app.whenReady().then(() => {
  app.setName(APP_NAME);

  // Register IPC handlers (must be before createMainWindow so they exist when renderer loads)
  const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");
  ipcMain.handle("getHardwareModel", async () => {
    if (process.platform !== "darwin") return null;
    try {
      return execSync("sysctl -n hw.model", { encoding: "utf8" }).trim() || null;
    } catch {
      return null;
    }
  });

  ipcMain.handle("getSettings", async () => {
    return loadSettingsWithMigration(SETTINGS_PATH);
  });
  ipcMain.handle("saveSettings", async (_, settings) => {
    try {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings), "utf8");
    } catch (e) {
      console.error("saveSettings:", e);
    }
  });

  // Request camera access (macOS) - helps system show camera in Control Center
  ipcMain.handle("requestCameraAccess", async () => {
    if (process.platform !== "darwin") return true;
    try {
      return await systemPreferences.askForMediaAccess("camera");
    } catch {
      return false;
    }
  });

  ipcMain.handle("displayMediaPick", async (_, sourceId) => {
    if (!displayMediaPending?.sources || typeof displayMediaPending.callback !== "function") {
      return false;
    }
    const src = displayMediaPending.sources.find((s) => s.id === sourceId);
    if (!src) {
      clearDisplayMediaPending(true);
      return false;
    }
    const cb = displayMediaPending.callback;
    if (displayMediaPending.timeoutId) clearTimeout(displayMediaPending.timeoutId);
    displayMediaPending = null;
    try {
      cb({ video: src });
    } catch (e) {
      console.error("[DreamWorks] displayMediaPick callback:", e);
      return false;
    }
    return true;
  });

  ipcMain.handle("displayMediaCancel", async () => {
    clearDisplayMediaPending(true);
  });

  installDarwinDisplayMediaHandler();

  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// IPC: setCompactMode
ipcMain.handle("setCompactMode", async (_, position, width, height) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win || win.isDestroyed()) return;
  win.setMinimumSize(240, 96);
  win.setSize(width, height);
  win.setAlwaysOnTop(true);
  win.setResizable(false);
  win.setSkipTaskbar(true);

  const primaryDisplay = screen.getPrimaryDisplay();
  const { workArea } = primaryDisplay;
  const margin = 8;
  let x, y;
  switch (position) {
    case "top-left":
      x = workArea.x + margin;
      y = workArea.y + margin;
      break;
    case "top-center":
      x = workArea.x + (workArea.width - width) / 2;
      y = workArea.y + margin;
      break;
    case "top-right":
      x = workArea.x + workArea.width - width - margin;
      y = workArea.y + margin;
      break;
    case "bottom-left":
      x = workArea.x + margin;
      y = workArea.y + workArea.height - height - margin;
      break;
    default:
      x = workArea.x + workArea.width - width - margin;
      y = workArea.y + workArea.height - height - margin;
  }
  win.setPosition(x, y);
  win.show();
  win.focus();
});

// IPC: setNormalMode — undo compact-window chrome only; never call setBounds/setSize (preserve user size / fullscreen after recording or stop share).
ipcMain.handle("setNormalMode", async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(false);
  win.setResizable(true);
  win.setSkipTaskbar(false);
  win.setMinimumSize(800, 600);
});

/**
 * Chromium throttles `requestAnimationFrame` and timers when the window is in the background.
 * During screen recording we must keep compositing so the shared window keeps updating while the
 * user operates it in the foreground (same as `webContents.setBackgroundThrottling` in Electron docs).
 */
ipcMain.handle("setBackgroundThrottling", async (_, throttlingEnabled) => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!win) return;
  try {
    if (typeof win.webContents.setBackgroundThrottling === "function") {
      win.webContents.setBackgroundThrottling(Boolean(throttlingEnabled));
    }
  } catch (e) {
    console.warn("[DreamWorks] setBackgroundThrottling:", e);
  }
});

// IPC: openHelperWindow
ipcMain.handle("openHelperWindow", async (_, kind) => {
  createHelperWindow(kind);
});

ipcMain.handle("openTeleprompterSlimWindow", async () => {
  createTeleprompterSlimWindow();
});

// IPC: closeHelperWindow
ipcMain.handle("closeHelperWindow", async (_, label) => {
  const win = helperWindows.get(label);
  if (win && !win.isDestroyed()) {
    win.close();
    helperWindows.delete(label);
  }
});

ipcMain.handle("getHelperWindowBounds", async (_, label) => {
  const win = helperWindows.get(label);
  if (!win || win.isDestroyed()) return null;
  return win.getBounds();
});

ipcMain.handle("setHelperWindowBounds", async (_, label, bounds) => {
  const win = helperWindows.get(label);
  if (!win || win.isDestroyed()) return false;
  const cur = win.getBounds();
  const isTeleprompter = label === "teleprompter-helper";
  const minW = isTeleprompter ? 400 : 100;
  const minH = isTeleprompter ? 180 : 100;
  const nw = Math.round(bounds?.width ?? cur.width);
  const nh = Math.round(bounds?.height ?? cur.height);
  win.setBounds({
    x: typeof bounds?.x === "number" ? Math.round(bounds.x) : cur.x,
    y: typeof bounds?.y === "number" ? Math.round(bounds.y) : cur.y,
    width: Math.max(minW, nw),
    height: Math.max(minH, nh),
  });
  return true;
});

// IPC: getHelperByLabel (for close)
ipcMain.handle("closeHelperByLabel", async (_, label) => {
  const win = helperWindows.get(label);
  if (win && !win.isDestroyed()) {
    win.close();
    helperWindows.delete(label);
  }
});

// IPC: embedded signaling (Option C - local meeting)
ipcMain.handle("startEmbeddedSignaling", async () => {
  return embeddedSignaling.start();
});
ipcMain.handle("stopEmbeddedSignaling", async () => {
  embeddedSignaling.stop();
});

// IPC: openFile (for whiteboard Load)
ipcMain.handle("openFile", async (_, filters = [{ name: "Excalidraw", extensions: ["excalidraw", "json"] }]) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters,
    properties: ["openFile"],
  });
  if (canceled || !filePaths?.length) return null;
  try {
    const content = fs.readFileSync(filePaths[0], "utf8");
    return { path: filePaths[0], content };
  } catch (e) {
    console.error("openFile:", e);
    return null;
  }
});

// IPC: teleprompter — native open dialog + fs.readFile (avoids hidden <input type="file"> issues in Electron)
ipcMain.handle("openTextFiles", async (_, options = {}) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return { ok: false, files: [] };
  const multi = options.multi !== false;
  const filters = Array.isArray(options.filters) && options.filters.length
    ? options.filters
    : [
        { name: "Text / Markdown", extensions: ["txt", "md", "markdown", "script"] },
        { name: "All files", extensions: ["*"] },
      ];
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters,
    properties: multi ? ["openFile", "multiSelections"] : ["openFile"],
  });
  if (canceled || !filePaths?.length) return { ok: false, files: [] };
  const files = [];
  for (const p of filePaths) {
    try {
      const content = fs.readFileSync(p, "utf8");
      files.push({ path: p, name: path.basename(p), content });
    } catch (e) {
      console.error("openTextFiles read:", p, e);
    }
  }
  return { ok: files.length > 0, files };
});

// IPC: saveFile (for whiteboard Save/Export). If `existingPath` is set, write without dialog (overwrite).
ipcMain.handle(
  "saveFile",
  async (
    _,
    content,
    defaultName = "drawing.excalidraw",
    filters = [{ name: "Excalidraw", extensions: ["excalidraw", "json"] }],
    existingPath = null
  ) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!win) return { ok: false };
    let filePath = typeof existingPath === "string" && existingPath.length > 0 ? existingPath : null;
    if (!filePath) {
      const { canceled, filePath: picked } = await dialog.showSaveDialog(win, {
        defaultPath: defaultName,
        filters,
      });
      if (canceled || !picked) return { ok: false };
      filePath = picked;
    }
    try {
      fs.writeFileSync(filePath, content, "utf8");
      return { ok: true, path: filePath };
    } catch (e) {
      console.error("saveFile:", e);
      return { ok: false };
    }
  }
);

// IPC: getDefaultSavePath — returns ~/Documents/DreamWork/, creating it if needed.
ipcMain.handle("getDefaultSavePath", () => {
  const dir = path.join(app.getPath("documents"), "DreamWork");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* ignore */ }
  return dir;
});

// IPC: saveImage (for Export image in Electron)
ipcMain.handle("saveImage", async (_, base64, defaultName = "export.png") => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return false;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "svg"] },
      { name: "PNG", extensions: ["png"] },
      { name: "JPEG", extensions: ["jpg", "jpeg"] },
      { name: "WebP", extensions: ["webp"] },
      { name: "SVG", extensions: ["svg"] },
    ],
  });
  if (canceled || !filePath) return false;
  try {
    const buf = Buffer.from(base64, "base64");
    fs.writeFileSync(filePath, buf);
    return true;
  } catch (e) {
    console.error("saveImage:", e);
    return false;
  }
});

// IPC: setWindowTitle
ipcMain.handle("setWindowTitle", async (_, title) => {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  win.setTitle(typeof title === "string" ? `${APP_NAME} - ${title}` : APP_NAME);
});

// IPC: setWindowIcon
ipcMain.handle("setWindowIcon", async (_, buffer) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return;
  const { nativeImage } = require("electron");
  const img = nativeImage.createFromBuffer(Buffer.from(buffer));
  if (!img.isEmpty()) win.setIcon(img);
});

/** Vosk model per language: user unpacks under userData/vosk-models/{en|zh|it}/ */
function voskModelBaseDir() {
  return path.join(app.getPath("userData"), "vosk-models");
}

ipcMain.handle("vosk:modelPath", async (_, lang) => {
  const sub = lang === "zh" ? "zh" : lang === "it" ? "it" : "en";
  const direct = path.join(voskModelBaseDir(), sub);
  if (voskStt.isModelDir(direct)) return { path: direct, ok: true };
  try {
    if (fs.existsSync(direct)) {
      const names = fs.readdirSync(direct, { withFileTypes: true });
      const dirs = names.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirs) {
        const p = path.join(direct, d.name);
        if (voskStt.isModelDir(p)) return { path: p, ok: true };
      }
    }
  } catch {
    /* ignore */
  }
  return { path: direct, ok: false };
});

ipcMain.handle("vosk:init", async (_, modelPath) => {
  try {
    return await voskStt.init(modelPath);
  } catch (e) {
    console.error("[vosk:init]", e);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

function voskPcmPayloadToBuffer(payload) {
  if (payload == null) return null;
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (typeof payload === "object" && payload.buffer instanceof ArrayBuffer) {
    const o = payload;
    return Buffer.from(o.buffer, o.byteOffset ?? 0, o.byteLength ?? o.buffer.byteLength);
  }
  if (typeof payload === "object" && payload.type === "Buffer" && Array.isArray(payload.data)) {
    return Buffer.from(payload.data);
  }
  return null;
}

ipcMain.handle("vosk:feed", async (_, payload) => {
  const buf = voskPcmPayloadToBuffer(payload);
  if (!buf || buf.length < 2) return null;
  if (buf.length % 2 !== 0) return null;
  return voskStt.feed(buf);
});

ipcMain.handle("vosk:reset", async () => {
  await voskStt.reset();
});

ipcMain.handle("vosk:release", async () => {
  voskStt.release();
});

app.on("before-quit", () => {
  try {
    voskStt.release();
  } catch {
    /* ignore */
  }
});
