"use strict";

const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * electron-builder afterPack hook:
 * When no Developer ID certificate is configured, electron-builder skips code signing,
 * leaving Electron's stub linker signature (Identifier=Electron, Info.plist=not bound).
 * macOS TCC (Screen Recording / Camera / Microphone) rejects bundles with broken/unbound
 * signatures even when toggled on in Privacy & Security.
 *
 * Ad-hoc signing binds Info.plist + CFBundleIdentifier + Sealed Resources cleanly,
 * then verifies the signature so broken bundles fail loudly during packaging.
 * If a Developer ID certificate IS available, electron-builder's subsequent signing step
 * replaces this ad-hoc signature automatically.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin" && process.platform !== "darwin") {
    return;
  }
  const appName = context.packager.appInfo.productFilename;
  const expectedAppId = context.packager.appInfo.id;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) {
    return;
  }
  console.log(`[adhoc-sign-mac] Ad-hoc signing ${appPath}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=1", appPath], {
    stdio: "inherit",
  });
  const inspect = spawnSync("codesign", ["-dv", appPath], { encoding: "utf8" });
  const detail = `${inspect.stdout || ""}\n${inspect.stderr || ""}`;
  if (inspect.status !== 0) {
    throw new Error(`[adhoc-sign-mac] codesign -dv failed for ${appPath}:\n${detail}`);
  }
  if (detail.includes("Info.plist=not bound")) {
    throw new Error(`[adhoc-sign-mac] Info.plist is not bound in ${appPath}`);
  }
  if (expectedAppId && !detail.includes(`Identifier=${expectedAppId}`)) {
    throw new Error(
      `[adhoc-sign-mac] Unexpected signature identifier (expected ${expectedAppId}):\n${detail}`
    );
  }
  console.log(`[adhoc-sign-mac] Verified valid signature (${expectedAppId})`);
};
