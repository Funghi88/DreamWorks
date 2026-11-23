"use strict";

/**
 * Build (unless --skip-pack), verify signature, quit any running DreamWorks instance,
 * replace /Applications/DreamWorks.app, verify the installed copy, and launch (unless --no-launch).
 *
 * Usage:
 *   npm run install:mac
 *   node scripts/install-mac.cjs --skip-pack --no-launch
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "darwin") {
  console.error("[install-mac] This script only supports macOS.");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const skipPack = args.has("--skip-pack");
const noLaunch = args.has("--no-launch");

const root = path.resolve(__dirname, "..");
const archDir = process.arch === "arm64" ? "mac-arm64" : "mac";
const sourceApp = path.join(root, "release", archDir, "DreamWorks.app");
const targetApp = "/Applications/DreamWorks.app";

if (!skipPack) {
  console.log("[install-mac] Running npm run pack...");
  execFileSync("npm", ["run", "pack"], { cwd: root, stdio: "inherit" });
}

if (!fs.existsSync(sourceApp)) {
  console.error(`[install-mac] Built app not found at ${sourceApp}`);
  process.exit(1);
}

console.log("[install-mac] Verifying built app signature...");
execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=1", sourceApp], {
  stdio: "inherit",
});

console.log("[install-mac] Quitting any running DreamWorks instance...");
spawnSync("osascript", ["-e", 'tell application "DreamWorks" to quit'], {
  stdio: "ignore",
});

if (fs.existsSync(targetApp)) {
  console.log(`[install-mac] Removing previous ${targetApp}...`);
  fs.rmSync(targetApp, { recursive: true, force: true });
}

console.log(`[install-mac] Installing ${sourceApp} -> ${targetApp}...`);
execFileSync("ditto", [sourceApp, targetApp], { stdio: "inherit" });

console.log("[install-mac] Verifying installed app signature...");
execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=1", targetApp], {
  stdio: "inherit",
});

console.log(`[install-mac] Installed cleanly at ${targetApp}`);
if (!noLaunch) {
  execFileSync("open", [targetApp], { stdio: "inherit" });
}
