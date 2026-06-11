/**
 * Main-window preload. Runs in an isolated world (contextIsolation + sandbox) but
 * shares the page's DOM. It injects a Capacitor-shaped bridge so the hosted web
 * app's src/lib/native.ts reports platform "desktop" and routes OAuth/checkout to
 * the system browser via openExternal(), plus a small vincony API + the
 * screenshot-handoff listener.
 */
import { contextBridge, ipcRenderer } from "electron";

// 1) Capacitor-shaped bridge — native.ts reads window.Capacitor.{isNativePlatform,
//    getPlatform, Plugins.Browser.open}. Reporting "desktop" keeps Stripe purchasing
//    visible (only native iOS is Reader-App gated) and sends OAuth to a real browser.
contextBridge.exposeInMainWorld("Capacitor", {
  isNativePlatform: () => true,
  getPlatform: () => "desktop",
  Plugins: {
    Browser: {
      open: (opts: { url: string }) => ipcRenderer.invoke("open-external", opts?.url),
    },
  },
});

// 2) A small first-party desktop API for future use.
contextBridge.exposeInMainWorld("vincony", {
  platform: "desktop",
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
});

// (The screenshot → ask hand-off is staged directly into sessionStorage by the main
//  process via executeJavaScript before navigating to /os/chat — no IPC needed here.)
