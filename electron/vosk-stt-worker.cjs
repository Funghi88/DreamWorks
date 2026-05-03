"use strict";

/**
 * Runs under system Node (spawned from Electron main). Loads vosk where native addons work.
 * Protocol: one JSON object per line on stdin; one JSON object per line on stdout (stderr for logs only).
 */
const fs = require("fs");
const readline = require("readline");
const path = require("path");
const { voskFinalText, voskPartialText } = require("./vosk-result-text.cjs");

process.chdir(path.join(__dirname, ".."));

let vosk;
try {
  vosk = require("vosk");
  vosk.setLogLevel(-1);
} catch (e) {
  process.stdout.write(JSON.stringify({ ready: false, error: String(e && e.message ? e.message : e) }) + "\n");
  process.exit(1);
}

process.stdout.write(JSON.stringify({ ready: true }) + "\n");

let model = null;
let recognizer = null;
/** Stable path for idempotent init (avoid ~10s reload when parent re-sends init). */
let loadedWorkerPath = null;

function resolveModelPath(p) {
  let r = path.resolve(p);
  try {
    if (fs.existsSync(r)) r = fs.realpathSync(r);
  } catch {
    /* keep r */
  }
  return r;
}

function releaseLocal() {
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
  loadedWorkerPath = null;
}

function reply(o) {
  process.stdout.write(JSON.stringify(o) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    reply({ kind: "error", error: "invalid json from parent" });
    return;
  }

  if (msg.cmd === "init") {
    try {
      const resolved = resolveModelPath(msg.modelPath);
      if (loadedWorkerPath === resolved && recognizer) {
        try {
          if (typeof recognizer.reset === "function") recognizer.reset();
        } catch {
          /* ignore */
        }
        reply({ ok: true });
        return;
      }
      releaseLocal();
      model = new vosk.Model(resolved);
      recognizer = new vosk.Recognizer({ model, sampleRate: 16000 });
      try {
        if (typeof recognizer.setWords === "function") recognizer.setWords(true);
        /* false → more frequent partial updates (lower perceived latency) than grouped partial words. */
        if (typeof recognizer.setPartialWords === "function") recognizer.setPartialWords(false);
      } catch {
        /* optional */
      }
      loadedWorkerPath = resolved;
      reply({ ok: true });
    } catch (e) {
      reply({ ok: false, error: e && e.message ? e.message : String(e) });
    }
    return;
  }

  if (msg.cmd === "feed") {
    if (!recognizer) {
      reply({ kind: "none" });
      return;
    }
    try {
      const buf = Buffer.from(msg.b64, "base64");
      const done = recognizer.acceptWaveform(buf);
      if (done) {
        reply({ kind: "final", text: voskFinalText(recognizer.result()) });
      } else {
        reply({ kind: "partial", partial: voskPartialText(recognizer.partialResult()) });
      }
    } catch (e) {
      reply({ kind: "error", error: e && e.message ? e.message : String(e) });
    }
    return;
  }

  if (msg.cmd === "reset") {
    try {
      if (recognizer && typeof recognizer.reset === "function") recognizer.reset();
    } catch {
      /* ignore */
    }
    reply({ ok: true });
    return;
  }

  if (msg.cmd === "exit") {
    releaseLocal();
    process.exit(0);
  }
});
