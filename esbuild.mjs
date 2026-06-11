// Bundles the Electron main + preload scripts (TypeScript) into dist/ and copies
// the quick-ask window's static HTML. electron + electron-updater stay external
// (provided by the runtime / packed as production deps).
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron", "electron-updater"],
  logLevel: "info",
};

await mkdir("dist", { recursive: true });

await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.js" });
await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.js" });
await build({ ...common, entryPoints: ["src/quick-ask/preload.ts"], outfile: "dist/quick-ask-preload.js" });

await copyFile("src/quick-ask/index.html", "dist/quick-ask.html");
// Runtime icon for the tray + notifications must live inside the packed dist/.
await copyFile("build/icon.png", "dist/icon.png");

console.log("✓ built main + preloads, copied quick-ask.html + icon");
