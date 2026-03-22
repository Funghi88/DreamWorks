const { app, BrowserWindow, ipcMain, screen, session, dialog, systemPreferences, desktopCapturer } = require("electron");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const embeddedSignaling = require("./embedded-signaling.cjs");

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
 * macOS: `getDisplayMedia` needs a `desktopCapturer` handler. We defer `callback` until the user
 * picks a screen/window in the renderer (see `display-media-picker` IPC).
 */
function installDarwinDisplayMediaHandler() {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    /* Larger 16:9 thumbs so previews look sharp in the picker (was 200², very blurry when scaled). */
    const thumb = { width: 720, height: 405 };
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      clearDisplayMediaPending(true);
      desktopCapturer
        .getSources({ types: ["screen", "window"], thumbnailSize: thumb })
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
          const timeoutId = setTimeout(() => {
            if (displayMediaPending && displayMediaPending.callback === callback) {
              clearDisplayMediaPending(true);
            }
          }, 120000);
          displayMediaPending = { callback, sources, timeoutId };
          const payload = sources.map((s) => {
            let thumbnailDataUrl;
            if (s.thumbnail && !s.thumbnail.isEmpty()) {
              try {
                const jpeg = s.thumbnail.toJPEG(85);
                thumbnailDataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
              } catch {
                thumbnailDataUrl = s.thumbnail.toDataURL();
              }
            }
            return { id: s.id, name: s.name, thumbnailDataUrl };
          });
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

// IPC: openHelperWindow
ipcMain.handle("openHelperWindow", async (_, kind) => {
  createHelperWindow(kind);
});

// IPC: closeHelperWindow
ipcMain.handle("closeHelperWindow", async (_, label) => {
  const win = helperWindows.get(label);
  if (win && !win.isDestroyed()) {
    win.close();
    helperWindows.delete(label);
  }
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
