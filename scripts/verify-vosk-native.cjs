"use strict";

/**
 * Quick check that the vosk native addon loads under the current Node (e.g. 24).
 * Does not load a model; only verifies .node binding + require().
 *
 * Usage: node scripts/verify-vosk-native.cjs
 *    or: npm run verify:vosk
 */
try {
  const vosk = require("vosk");
  if (!vosk || typeof vosk.setLogLevel !== "function") {
    console.error("[verify-vosk-native] FAILED: vosk export unexpected");
    process.exit(1);
  }
  vosk.setLogLevel(-1);
  console.log("[verify-vosk-native] OK — vosk native addon loaded (Node", process.version + ")");
  process.exit(0);
} catch (e) {
  console.error("[verify-vosk-native] FAILED:", e && e.message ? e.message : e);
  process.exit(1);
}
