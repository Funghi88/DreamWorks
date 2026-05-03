"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const readline = require("readline");
const { voskFinalText, voskPartialText } = require("./vosk-result-text.cjs");

/** @type {false | null | Record<string, unknown>} */
let voskLib = false;

function loadVoskInProcess() {
  if (voskLib !== false && voskLib !== null) return voskLib;
  try {
    const v = require("vosk");
    if (v && typeof v.setLogLevel === "function") v.setLogLevel(-1);
    voskLib = v;
  } catch (e) {
    if (process.env.DREAMWORK_VOSK_DEBUG) {
      console.warn("[vosk-stt] in-process require failed, will use Node child worker:", e && e.message ? e.message : e);
    }
    voskLib = null;
  }
  return voskLib;
}

/** Must be a file (spawn ENOTDIR if path is a directory or invalid). */
function isExecutableNodePath(p) {
  if (!p || typeof p !== "string") return false;
  try {
    const st = fs.statSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * True if `p` is under the ASAR virtual tree (`…/app.asar/…`), not `app.asar.unpacked`.
 * Electron's fs may treat these as directories, but OS chdir for spawn cannot — ENOTDIR.
 */
function isInsideAppAsarVirtual(p) {
  if (!p || typeof p !== "string") return false;
  const n = path.normalize(p).replace(/\\/g, "/");
  if (n.includes("/app.asar.unpacked/")) return false;
  return n.includes("/app.asar/");
}

/** Map `…/app.asar/…` → `…/app.asar.unpacked/…` (electron-builder asarUnpack mirror). */
function toAppAsarUnpackedPath(p) {
  if (!p || typeof p !== "string") return p;
  const n = path.normalize(p);
  const marker = `${path.sep}app.asar${path.sep}`;
  if (!n.includes(marker)) return p;
  return n.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function isUsableSpawnCwd(d) {
  if (!d) return false;
  try {
    if (isInsideAppAsarVirtual(d)) return false;
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
}

/**
 * cwd for the vosk child must be a real OS directory. Do not use `…/app.asar/…` (virtual) — spawn fails with ENOTDIR.
 */
function getWorkerCwd() {
  if (process.env.DREAMWORK_VOSK_WORKER_CWD) {
    const p = path.resolve(process.env.DREAMWORK_VOSK_WORKER_CWD.trim());
    if (isUsableSpawnCwd(p)) return p;
  }
  try {
    const { app } = require("electron");
    if (app?.isPackaged && process.resourcesPath) {
      const unpackedElectron = path.join(process.resourcesPath, "app.asar.unpacked", "electron");
      if (isUsableSpawnCwd(unpackedElectron)) return unpackedElectron;
    }
  } catch {
    /* no electron */
  }
  const unpackedFromDirname = toAppAsarUnpackedPath(__dirname);
  if (unpackedFromDirname !== __dirname && isUsableSpawnCwd(unpackedFromDirname)) {
    return unpackedFromDirname;
  }
  const tryDirs = [__dirname, path.join(__dirname, ".."), process.cwd()];
  for (const d of tryDirs) {
    if (isUsableSpawnCwd(d)) return d;
  }
  try {
    const { app } = require("electron");
    if (app?.getPath) {
      const ud = app.getPath("userData");
      if (isUsableSpawnCwd(ud)) return ud;
      try {
        const ap = app.getAppPath();
        const dir = fs.statSync(ap).isFile() ? path.dirname(ap) : ap;
        if (isUsableSpawnCwd(dir)) return dir;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* main-only or no electron */
  }
  const tmp = os.tmpdir();
  if (isUsableSpawnCwd(tmp)) return tmp;
  return tmp;
}

/** System `node` must read a real file; ASAR paths fail. Prefer app.asar.unpacked mirror. */
function resolveVoskWorkerScriptPath() {
  const primary = path.join(__dirname, "vosk-stt-worker.cjs");
  if (isExecutableNodePath(primary) && !isInsideAppAsarVirtual(primary)) {
    return primary;
  }
  const unpackedNext = path.join(toAppAsarUnpackedPath(__dirname), "vosk-stt-worker.cjs");
  if (isExecutableNodePath(unpackedNext)) return unpackedNext;
  try {
    const { app } = require("electron");
    if (app?.isPackaged && process.resourcesPath) {
      const rp = path.join(process.resourcesPath, "app.asar.unpacked", "electron", "vosk-stt-worker.cjs");
      if (isExecutableNodePath(rp)) return rp;
    }
  } catch {
    /* ignore */
  }
  return primary;
}

/** PATH for child / for lookups: GUI apps on macOS often have a minimal PATH (no /opt/homebrew/bin). */
function envWithNodePath() {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const cur = process.env.PATH || "";
  const merged = [...extra, cur].filter(Boolean).join(path.delimiter);
  return { ...process.env, PATH: merged };
}

/** System Node for worker (Electron’s binary cannot load vosk’s native stack reliably). */
function findNodeExecutable() {
  if (process.env.DREAMWORK_VOSK_NODE) {
    const p = path.resolve(process.env.DREAMWORK_VOSK_NODE.trim());
    if (isExecutableNodePath(p)) return p;
  }
  try {
    const out = execFileSync("/bin/sh", ["-c", "command -v node"], {
      encoding: "utf8",
      env: envWithNodePath(),
    })
      .trim()
      .split(/\r?\n/)[0]
      ?.trim();
    if (out && isExecutableNodePath(out)) return path.resolve(out);
  } catch {
    /* ignore */
  }
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    if (isExecutableNodePath(p)) return p;
  }
  try {
    const w = execFileSync("/usr/bin/which", ["node"], {
      encoding: "utf8",
      env: envWithNodePath(),
    })
      .trim()
      .split(/\r?\n/)[0]
      ?.trim();
    if (w && isExecutableNodePath(w)) return path.resolve(w);
  } catch {
    /* ignore */
  }
  /* Bare "node" — augmented PATH in spawn() so GUI-launched Electron finds Homebrew Node. */
  return "node";
}

/** Canonical path so cache hits after symlinks / different spellings (debug log: initMs ~9s on every Follow). */
function normalizeVoskModelPath(p) {
  const r = path.resolve(p);
  try {
    if (fs.existsSync(r)) return fs.realpathSync(r);
  } catch {
    /* keep r */
  }
  return r;
}

// #region agent log
/** Debug session 6bad53 — NDJSON to workspace .cursor (dev). */
function debugSession6Append(obj) {
  try {
    const logPath = path.join(__dirname, "..", ".cursor", "debug-6bad53.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      JSON.stringify({ sessionId: "6bad53", timestamp: Date.now(), ...obj }) + "\n",
    );
  } catch {
    /* ignore */
  }
}
// #endregion

let model = null;
let recognizer = null;
let useChild = false;
/** When set, init() skips reload and only reset()s the recognizer (fast follow re-enable). */
let loadedModelPath = null;
/** @type {import('child_process').ChildProcessWithoutNullStreams | null} */
let childProc = null;
/** @type {readline.Interface | null} */
let childRl = null;

/** Serialize stdin/stdout JSON lines so reset() never races feed(). */
let childWriteChain = Promise.resolve();

function killChild() {
  loadedModelPath = null;
  if (childProc) {
    try {
      childProc.stdin.write(JSON.stringify({ cmd: "exit" }) + "\n");
    } catch {
      /* ignore */
    }
    try {
      childProc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    childProc = null;
  }
  if (childRl) {
    try {
      childRl.close();
    } catch {
      /* ignore */
    }
    childRl = null;
  }
  useChild = false;
  childWriteChain = Promise.resolve();
}

function childRequest(obj) {
  const job = childWriteChain.then(() => {
    if (!childProc || !childRl) {
      return Promise.reject(new Error("vosk worker not running"));
    }
    return new Promise((resolve, reject) => {
      const onLine = (line) => {
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(e);
        }
      };
      childRl.once("line", onLine);
      try {
        childProc.stdin.write(JSON.stringify(obj) + "\n");
      } catch (e) {
        childRl.off("line", onLine);
        reject(e);
      }
    });
  });
  childWriteChain = job.catch(() => {});
  return job;
}

async function spawnWorkerAndWaitReady() {
  killChild();
  const nodeBin = findNodeExecutable();
  const workerPath = resolveVoskWorkerScriptPath();
  if (!isExecutableNodePath(workerPath)) {
    throw new Error(`vosk worker script missing or not a file: ${workerPath}`);
  }
  const cwdFromScript = path.dirname(workerPath);
  const cwd = isUsableSpawnCwd(cwdFromScript) ? cwdFromScript : getWorkerCwd();

  const proc = spawn(nodeBin, [workerPath], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: envWithNodePath(),
  });
  childProc = proc;

  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (process.env.DREAMWORK_VOSK_DEBUG) console.warn("[vosk-worker]", s);
  });

  childRl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

  const readyLine = await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("vosk worker start timeout"));
    }, 15000);
    const onLine = (line) => {
      clearTimeout(t);
      proc.off("exit", onExit);
      proc.off("error", onSpawnErr);
      resolve(line);
    };
    const onExit = (code) => {
      clearTimeout(t);
      childRl.off("line", onLine);
      proc.off("error", onSpawnErr);
      reject(new Error(`vosk worker exited before ready (${code})`));
    };
    const onSpawnErr = (err) => {
      clearTimeout(t);
      try {
        childRl?.off("line", onLine);
      } catch {
        /* ignore */
      }
      proc.off("exit", onExit);
      killChild();
      if (process.env.DREAMWORK_VOSK_DEBUG) {
        console.warn("[vosk-stt] worker spawn error:", err);
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    childRl.once("line", onLine);
    proc.once("exit", onExit);
    proc.once("error", onSpawnErr);
  });

  let boot;
  try {
    boot = JSON.parse(readyLine);
  } catch (e) {
    killChild();
    throw e;
  }
  if (!boot.ready) {
    killChild();
    throw new Error(boot.error || "vosk worker failed to load");
  }

  useChild = true;
}

function isModelDir(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
  const finalMdl = path.join(dir, "am", "final.mdl");
  if (fs.existsSync(finalMdl)) return true;
  return fs.existsSync(path.join(dir, "am", "model"));
}

function releaseNative() {
  try {
    if (recognizer && typeof recognizer.free === "function") recognizer.free();
  } catch {
    /* ignore */
  }
  try {
    if (model && typeof model.free === "function") model.free();
  } catch {
    /* ignore */
  }
  recognizer = null;
  model = null;
  loadedModelPath = null;
}

function feedNative(buffer) {
  if (!recognizer) return null;
  try {
    const done = recognizer.acceptWaveform(buffer);
    if (done) {
      return { kind: "final", text: voskFinalText(recognizer.result()) };
    }
    return { kind: "partial", partial: voskPartialText(recognizer.partialResult()) };
  } catch (e) {
    return { kind: "error", error: e && e.message ? e.message : String(e) };
  }
}

function voskWorkerUsable() {
  if (!childProc || !childRl) return false;
  if (childProc.killed) return false;
  /* Node/Electron: running child often has exitCode/signalCode as null; some builds use undefined — strict === null caused false "dead" and ~10s reload every Follow. */
  if (childProc.exitCode != null) return false;
  if (childProc.signalCode != null) return false;
  return true;
}

function voskDebugLog(payload) {
  const line = `${JSON.stringify({ sessionId: "e625b6", ...payload, timestamp: Date.now() })}\n`;
  const candidates = [
    path.join(__dirname, "..", ".cursor", "debug-e625b6.log"),
    path.join(require("os").tmpdir(), "dreamwork-vosk-e625b6.log"),
  ];
  for (const logPath of candidates) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, line);
      return;
    } catch {
      /* try next */
    }
  }
}

/** Serialize init — prewarm + Follow can invoke vosk:init concurrently and both miss cache, double spawn + release. */
let initQueue = Promise.resolve();

async function init(modelPath) {
  const p = initQueue.then(() => initCore(modelPath));
  initQueue = p.then(
    () => undefined,
    () => undefined
  );
  return p;
}

async function initCore(modelPath) {
  const resolved = normalizeVoskModelPath(modelPath);
  const initCoreT0 = Date.now();
  if (!isModelDir(resolved)) {
    // #region agent log
    debugSession6Append({
      hypothesisId: "H_LOAD_MAIN",
      location: "vosk-stt.cjs:initCore",
      message: "vosk init skipped — invalid model dir",
      branch: "invalid_dir",
      elapsedMs: Date.now() - initCoreT0,
    });
    // #endregion
    return {
      ok: false,
      error: `Not a Vosk model folder (expected am/final.mdl): ${resolved}`,
    };
  }

  const inProcReady = !useChild && !!recognizer;
  const workerReady = useChild && voskWorkerUsable();
  const pathMatch = loadedModelPath === resolved;
  const cacheHit = pathMatch && (inProcReady || workerReady);

  voskDebugLog({
    location: "vosk-stt.cjs:initCore",
    message: "init decision",
    hypothesisId: "H1",
    pathMatch,
    cacheHit,
    useChild,
    inProcReady,
    workerReady,
    exitCode: childProc ? childProc.exitCode : undefined,
    signalCode: childProc ? childProc.signalCode : undefined,
    killed: childProc ? childProc.killed : undefined,
  });

  if (cacheHit) {
    await reset();
    voskDebugLog({ location: "vosk-stt.cjs:initCore", message: "init cache hit + reset done", hypothesisId: "H1" });
    // #region agent log
    debugSession6Append({
      hypothesisId: "H_LOAD_MAIN",
      location: "vosk-stt.cjs:initCore",
      message: "vosk init done",
      branch: "cache_hit_reset",
      elapsedMs: Date.now() - initCoreT0,
    });
    // #endregion
    return { ok: true };
  }

  release();
  const v = loadVoskInProcess();
  if (v) {
    try {
      model = new v.Model(resolved);
      recognizer = new v.Recognizer({ model, sampleRate: 16000 });
      try {
        if (typeof recognizer.setWords === "function") recognizer.setWords(true);
        if (typeof recognizer.setPartialWords === "function") recognizer.setPartialWords(false);
      } catch {
        /* optional */
      }
      useChild = false;
      loadedModelPath = resolved;
      voskDebugLog({ location: "vosk-stt.cjs:initCore", message: "init in-process load done", hypothesisId: "H1" });
      // #region agent log
      debugSession6Append({
        hypothesisId: "H_LOAD_MAIN",
        location: "vosk-stt.cjs:initCore",
        message: "vosk init done",
        branch: "in_process",
        elapsedMs: Date.now() - initCoreT0,
      });
      // #endregion
      return { ok: true };
    } catch (e) {
      releaseNative();
      /* fall through to child */
    }
  }

  try {
    await spawnWorkerAndWaitReady();
    const res = await childRequest({ cmd: "init", modelPath: resolved });
    if (!res.ok) {
      killChild();
      // #region agent log
      debugSession6Append({
        hypothesisId: "H_LOAD_MAIN",
        location: "vosk-stt.cjs:initCore",
        message: "vosk init failed",
        branch: "worker_child_init",
        elapsedMs: Date.now() - initCoreT0,
        error: res.error || "worker init failed",
      });
      // #endregion
      return { ok: false, error: res.error || "worker init failed" };
    }
    loadedModelPath = resolved;
    voskDebugLog({ location: "vosk-stt.cjs:initCore", message: "init worker cold load done", hypothesisId: "H1" });
    // #region agent log
    debugSession6Append({
      hypothesisId: "H_LOAD_MAIN",
      location: "vosk-stt.cjs:initCore",
      message: "vosk init done",
      branch: "worker_cold",
      elapsedMs: Date.now() - initCoreT0,
    });
    // #endregion
    return { ok: true };
  } catch (e) {
    killChild();
    // #region agent log
    debugSession6Append({
      hypothesisId: "H_LOAD_MAIN",
      location: "vosk-stt.cjs:initCore",
      message: "vosk init exception",
      branch: "worker_spawn",
      elapsedMs: Date.now() - initCoreT0,
      error: String(e && e.message ? e.message : e),
    });
    // #endregion
    return {
      ok: false,
      error:
        (e && e.message ? e.message : String(e)) +
        " — Ensure `node` is on PATH (same machine as `npm run verify:vosk`).",
    };
  }
}

async function feed(buffer) {
  if (useChild && childProc && childRl) {
    const res = await childRequest({ cmd: "feed", b64: buffer.toString("base64") });
    if (res && res.kind === "none") return null;
    return res;
  }
  return feedNative(buffer);
}

async function reset() {
  if (useChild && childProc && childRl) {
    try {
      await childRequest({ cmd: "reset" });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    if (recognizer && typeof recognizer.reset === "function") recognizer.reset();
  } catch {
    /* ignore */
  }
}

function release() {
  killChild();
  releaseNative();
}

module.exports = { init, feed, reset, release, isModelDir };
