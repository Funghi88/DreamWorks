const { app, BrowserWindow, ipcMain, screen, session, desktopCapturer, dialog, systemPreferences } = require("electron");
const path = require("path");
const fs = require("fs");
const embeddedSignaling = require("./embedded-signaling.cjs");

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

let mainWindow = null;
const helperWindows = new Map();

const APP_NAME = "DreamWorks";

/**
 * Native picker when the OS provides it (useSystemPicker: true).
 * Fallback only: request screen sources first, then window — never assume a combined list order.
 */
function installNativeDisplayMediaHandler() {
  const thumb = { width: 150, height: 150 };
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      (async () => {
        try {
          const screens = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: thumb });
          if (screens.length > 0) {
            callback({ video: screens[0], audio: "loopback" });
            return;
          }
          // Do not fall back to a random window: that looked like “can’t share desktop” and caused
          // infinite-mirror previews when the window was DreamWorks. If screens is empty, fix Screen Recording.
          console.warn(
            "[DreamWorks] No display sources from desktopCapturer — Screen Recording permission or system issue."
          );
          callback({});
        } catch (err) {
          console.error("Capture Screen error:", err);
          callback({});
        }
      })();
    },
    { useSystemPicker: true }
  );
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
    if (!/\.(png|svg|webp)$/i.test(name)) return;
    item.pause();
    dialog
      .showSaveDialog(mainWindow, {
        defaultPath: name,
        filters: [{ name: "Image", extensions: ["png", "svg", "webp"] }],
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

app.whenReady().then(() => {
  app.setName(APP_NAME);
  // Register IPC handlers (must be before createMainWindow so they exist when renderer loads)
  const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");
  ipcMain.handle("getSettings", async () => {
    try {
      const data = fs.readFileSync(SETTINGS_PATH, "utf8");
      return JSON.parse(data);
    } catch {
      return {};
    }
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

  installNativeDisplayMediaHandler();

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
  if (!win) return;
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

// IPC: setNormalMode
ipcMain.handle("setNormalMode", async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return;
  win.setAlwaysOnTop(false);
  win.setResizable(true);
  win.setSkipTaskbar(false);
  win.setSize(1000, 700);
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

// IPC: saveFile (for whiteboard Save/Export)
ipcMain.handle(
  "saveFile",
  async (
    _,
    content,
    defaultName = "drawing.excalidraw",
    filters = [{ name: "Excalidraw", extensions: ["excalidraw", "json"] }]
  ) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!win) return false;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters,
    });
    if (canceled || !filePath) return false;
    try {
      fs.writeFileSync(filePath, content, "utf8");
      return true;
    } catch (e) {
      console.error("saveFile:", e);
      return false;
    }
  }
);

// IPC: saveImage (for Export image in Electron)
ipcMain.handle("saveImage", async (_, base64, defaultName = "export.png") => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return false;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: [{ name: "Image", extensions: ["png", "svg", "webp"] }],
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
