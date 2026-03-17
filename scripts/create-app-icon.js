#!/usr/bin/env node
/**
 * Create app icon from an avatar image.
 * Usage: node scripts/create-app-icon.js [input.png] [--circle]
 *   --circle: crop to circle (default: fill entire square)
 * Output: electron/icon.png (1024x1024)
 */
import sharp from "sharp";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const args = process.argv.slice(2);
const useCircle = args.includes("--circle");
const input = args.find((a) => !a.startsWith("--")) || join(root, "avatar-source.png");
const output = join(root, "electron", "icon.png");

if (!existsSync(input)) {
  console.error("Input not found:", input);
  process.exit(1);
}

const size = 1024;
let pipeline = sharp(input).resize(size, size, { fit: "cover", position: "center" });

if (useCircle) {
  const circleSvg = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/>
  </svg>`
  );
  pipeline = pipeline.composite([{ input: circleSvg, blend: "dest-in" }]);
}

await pipeline.png().toFile(output);
console.log("Created:", output, useCircle ? "(circular)" : "(fill)");
