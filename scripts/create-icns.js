#!/usr/bin/env node
/**
 * Create macOS .icns from electron/icon.png
 * Requires: macOS with sips and iconutil
 * Output: build/icon.icns
 */
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const input = join(root, "electron", "icon.png");
const iconsetDir = join(root, "build", "icon.iconset");
const output = join(root, "build", "icon.icns");

if (!existsSync(input)) {
  console.error("Input not found:", input);
  process.exit(1);
}

mkdirSync(join(root, "build"), { recursive: true });
mkdirSync(iconsetDir, { recursive: true });

const sizes = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

for (const [size, name] of sizes) {
  execSync(`sips -z ${size} ${size} "${input}" --out "${join(iconsetDir, name)}"`, {
    stdio: "pipe",
  });
}

execSync(`iconutil -c icns "${iconsetDir}" -o "${output}"`, { stdio: "pipe" });
execSync(`rm -rf "${iconsetDir}"`, { stdio: "pipe" });

console.log("Created:", output);
