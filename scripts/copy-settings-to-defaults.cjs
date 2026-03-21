#!/usr/bin/env node
/**
 * Copies the live DreamWorks settings.json into defaults/ so the next `npm run pack`
 * can bundle it (see defaults/README.md).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

function userSettingsPath() {
  const h = os.homedir();
  if (process.platform === "darwin") {
    return path.join(h, "Library", "Application Support", "DreamWorks", "settings.json");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(h, "AppData", "Roaming"), "DreamWorks", "settings.json");
  }
  return path.join(h, ".config", "DreamWorks", "settings.json");
}

const src = userSettingsPath();
const destDir = path.join(__dirname, "..", "defaults");
const dest = path.join(destDir, "settings.json");

if (!fs.existsSync(src)) {
  console.error("[copy-settings-to-defaults] No file at:\n  ", src);
  console.error("Open the app once so settings are saved, or export from the app.");
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log("[copy-settings-to-defaults] Copied\n  from", src, "\n  to  ", dest);
console.log("Next: npm run pack — first launch will seed user data if profile was empty.");
