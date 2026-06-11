/**
 * Vincony desktop — Electron main process.
 *
 * A thin, hardened native shell that loads the live hosted app
 * (https://app.vincony.com) — the web app is SSR and can't be statically bundled.
 * Adds the native power features the web tab can't: a global quick-ask hotkey, a
 * tray mini-chat, screenshot/clipboard → ask, auto-update, vincony:// deep links
 * (OAuth return), and OS notifications.
 */
import {
  app, BrowserWindow, Tray, Menu, globalShortcut, shell, ipcMain,
  desktopCapturer, screen, clipboard, nativeImage, Notification, type WebContents,
} from "electron";
import { autoUpdater } from "electron-updater";
import * as path from "node:path";

// The hosted app. Override for local testing: set VINCONY_APP_URL=http://localhost:3000
const APP_URL = process.env.VINCONY_APP_URL || "https://app.vincony.com";
const PROTOCOL = "vincony";
const QUICK_ASK_HOTKEY = process.env.VINCONY_HOTKEY || "Alt+Space";
const SCREENSHOT_HOTKEY = "CommandOrControl+Shift+S";
const CLIPBOARD_HOTKEY = "CommandOrControl+Shift+V";

let mainWindow: BrowserWindow | null = null;
let quickAskWindow: BrowserWindow | null = null;
let miniChatWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const icon = () => nativeImage.createFromPath(path.join(__dirname, "icon.png"));

function appOrigin(): string {
  try { return new URL(APP_URL).origin; } catch { return "https://app.vincony.com"; }
}

// Only *.vincony.com (+ localhost in dev) may navigate inside the webview; everything
// else (OAuth providers, Stripe, external links) is opened in the system browser.
function isInternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost")) return false;
    return u.hostname === "vincony.com" || u.hostname.endsWith(".vincony.com") || u.hostname === "localhost";
  } catch { return false; }
}

function hardenNavigation(wc: WebContents) {
  wc.setWindowOpenHandler(({ url }) => {
    if (!isInternalUrl(url)) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });
  wc.on("will-navigate", (e, url) => {
    if (!isInternalUrl(url)) { e.preventDefault(); shell.openExternal(url); }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: "#0b0b14",
    icon: icon(),
    title: "Vincony",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  hardenNavigation(mainWindow.webContents);
  mainWindow.loadURL(APP_URL);

  mainWindow.on("closed", () => { mainWindow = null; });
  // Keep the app alive in the tray when the main window is closed (Windows/Linux).
  mainWindow.on("close", (e) => {
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting && process.platform !== "darwin") {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

function showMain(navigateTo?: string) {
  if (!mainWindow) { createMainWindow(); }
  const win = mainWindow!;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (navigateTo) win.loadURL(appOrigin() + navigateTo);
}

/* ── Quick-ask spotlight ─────────────────────────────────────────────── */
function createQuickAskWindow() {
  quickAskWindow = new BrowserWindow({
    width: 720,
    height: 132,
    frame: false,
    resizable: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "quick-ask-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  quickAskWindow.loadFile(path.join(__dirname, "quick-ask.html"));
  quickAskWindow.on("blur", () => quickAskWindow?.hide());
  quickAskWindow.on("closed", () => { quickAskWindow = null; });
}

function toggleQuickAsk() {
  if (!quickAskWindow) createQuickAskWindow();
  const w = quickAskWindow!;
  if (w.isVisible()) { w.hide(); return; }
  // Center on the display under the cursor.
  const cursor = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(cursor);
  const [bw, bh] = w.getSize();
  w.setPosition(
    Math.round(disp.workArea.x + (disp.workArea.width - bw) / 2),
    Math.round(disp.workArea.y + disp.workArea.height * 0.28),
  );
  w.show();
  w.focus();
}

/* ── Tray mini-chat ──────────────────────────────────────────────────── */
function toggleMiniChat() {
  if (miniChatWindow && miniChatWindow.isVisible()) { miniChatWindow.hide(); return; }
  if (!miniChatWindow) {
    miniChatWindow = new BrowserWindow({
      width: 420,
      height: 620,
      frame: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: "#0b0b14",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    hardenNavigation(miniChatWindow.webContents);
    miniChatWindow.loadURL(appOrigin() + "/os/chat");
    miniChatWindow.on("blur", () => miniChatWindow?.hide());
    miniChatWindow.on("closed", () => { miniChatWindow = null; });
  }
  // Anchor near the tray / cursor.
  const cursor = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(cursor);
  const [w, h] = miniChatWindow.getSize();
  miniChatWindow.setPosition(
    Math.min(cursor.x, disp.workArea.x + disp.workArea.width - w - 8),
    Math.max(disp.workArea.y + 8, disp.workArea.y + disp.workArea.height - h - 48),
  );
  miniChatWindow.show();
  miniChatWindow.focus();
}

function createTray() {
  tray = new Tray(icon().resize({ width: 18, height: 18 }));
  tray.setToolTip("Vincony");
  const menu = Menu.buildFromTemplate([
    { label: "Open Vincony", click: () => showMain() },
    { label: "New Chat", click: () => showMain("/os/chat") },
    { type: "separator" },
    { label: `Quick Ask (${QUICK_ASK_HOTKEY})`, click: () => toggleQuickAsk() },
    { label: "Mini Chat", click: () => toggleMiniChat() },
    { label: "Screenshot → Ask", click: () => captureAndAsk() },
    { label: "Ask about Clipboard", click: () => clipboardAsk() },
    { type: "separator" },
    { label: "Check for Updates…", click: () => autoUpdater.checkForUpdates().catch(() => {}) },
    { label: "Quit", click: () => { (app as unknown as { isQuitting?: boolean }).isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => toggleMiniChat());
  tray.on("double-click", () => showMain());
}

/* ── Screenshot → ask ────────────────────────────────────────────────── */
async function captureAndAsk() {
  try {
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { width, height } = disp.size;
    const scale = disp.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    });
    const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
    if (!src) return;
    const dataUrl = src.thumbnail.toDataURL();
    showMain();
    const wc = mainWindow!.webContents;
    const deliver = () => wc.send("incoming-image", { dataUrl, name: "screenshot.png" });
    if (wc.isLoading()) wc.once("did-finish-load", deliver); else deliver();
    // Make sure we land on the chat so the page-side reader picks the image up.
    setTimeout(() => wc.loadURL(appOrigin() + "/os/chat"), 60);
  } catch (e) {
    notify("Screenshot failed", String(e instanceof Error ? e.message : e));
  }
}

/* ── Clipboard → ask ─────────────────────────────────────────────────── */
function clipboardAsk() {
  const text = clipboard.readText().trim();
  if (!text) { notify("Clipboard is empty", "Copy some text first, then Ask about Clipboard."); return; }
  showMain("/os/chat?q=" + encodeURIComponent(text.slice(0, 4000)));
}

/* ── Notifications ───────────────────────────────────────────────────── */
function notify(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body, icon: icon() }).show();
}

/* ── Deep links (vincony://auth?code=…) ──────────────────────────────── */
function handleDeepLink(url?: string) {
  if (!url || !url.startsWith(`${PROTOCOL}://`)) return;
  try {
    const u = new URL(url);
    // vincony://auth?code=… → bounce the webview to the hosted /auth so the PKCE
    // code is exchanged in the same session that started the OAuth flow.
    const targetPath = "/" + (u.hostname || "auth") + (u.search || "");
    showMain(targetPath.replace("//", "/"));
  } catch { /* ignore malformed deep links */ }
}

/* ── Auto-update ─────────────────────────────────────────────────────── */
function initAutoUpdate() {
  autoUpdater.autoDownload = true;
  autoUpdater.on("update-available", (i) => notify("Update available", `Downloading Vincony ${i.version}…`));
  autoUpdater.on("update-downloaded", (i) => {
    notify("Update ready", `Vincony ${i.version} will install on restart.`);
  });
  autoUpdater.on("error", (e) => console.error("[updater]", e?.message || e));
  // Don't block startup; ignore failures (e.g. unsigned dev builds / no releases yet).
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

/* ── IPC ─────────────────────────────────────────────────────────────── */
ipcMain.handle("open-external", (_e, url: string) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url);
});
ipcMain.on("quick-ask-submit", (_e, text: string) => {
  quickAskWindow?.hide();
  const t = (text || "").trim();
  if (t) showMain("/os/chat?q=" + encodeURIComponent(t.slice(0, 4000)));
});
ipcMain.on("quick-ask-close", () => quickAskWindow?.hide());

/* ── Single-instance + protocol registration ────────────────────────── */
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    // Windows delivers the deep link as an argv entry on the second instance.
    const deepLink = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (deepLink) handleDeepLink(deepLink);
    else showMain();
  });

  app.on("open-url", (e, url) => { e.preventDefault(); handleDeepLink(url); }); // macOS

  app.whenReady().then(() => {
    createMainWindow();
    createTray();
    initAutoUpdate();
    globalShortcut.register(QUICK_ASK_HOTKEY, toggleQuickAsk);
    globalShortcut.register(SCREENSHOT_HOTKEY, captureAndAsk);
    globalShortcut.register(CLIPBOARD_HOTKEY, clipboardAsk);
    // A deep link can arrive in the initial argv (cold start) on Windows.
    const initialDeepLink = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (initialDeepLink) handleDeepLink(initialDeepLink);

    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); else showMain(); });
  });

  app.on("window-all-closed", () => { /* keep running in the tray; quit only via tray menu */ });
  app.on("will-quit", () => globalShortcut.unregisterAll());
}
