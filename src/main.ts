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
  desktopCapturer, screen, clipboard, nativeImage, Notification, session,
  systemPreferences, type WebContents,
} from "electron";
import { autoUpdater } from "electron-updater";
import * as path from "node:path";

// The hosted app. Override for local testing: set VINCONY_APP_URL=http://localhost:3000
const APP_URL = process.env.VINCONY_APP_URL || "https://app.vincony.com";
const PROTOCOL = "vincony";
// Ctrl/Cmd+Shift+Space — avoids the bare Alt+Space, which is Windows' system
// window-menu shortcut and gets hijacked. Override with VINCONY_HOTKEY.
const QUICK_ASK_HOTKEY = process.env.VINCONY_HOTKEY || "CommandOrControl+Shift+Space";
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
  // Server-side (3xx) redirects don't fire will-navigate; catch them too so an in-page
  // redirect to an OAuth provider / Stripe is bounced to the system browser.
  wc.on("will-redirect", (e, url) => {
    if (!isInternalUrl(url)) { e.preventDefault(); shell.openExternal(url); }
  });
}

// Let the hosted app use the mic (Voice Studio / voice input), notifications, and
// clipboard — but ONLY for *.vincony.com content. Everything else is denied. Without
// this, Electron denies getUserMedia by default and voice features silently fail.
const ALLOWED_PERMISSIONS = new Set([
  "media", "audioCapture", "notifications",
  "clipboard-read", "clipboard-sanitized-write", "fullscreen", "pointerLock",
]);
function installPermissionHandlers() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = details?.requestingUrl || wc?.getURL() || "";
    callback(isInternalUrl(url) && ALLOWED_PERMISSIONS.has(permission));
  });
  // getUserMedia also consults the synchronous check handler.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    isInternalUrl(requestingOrigin) && ALLOWED_PERMISSIONS.has(permission)
  );
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
  const trayIcon = icon().resize({ width: 18, height: 18 });
  // On macOS a template image renders as a monochrome mask that adapts to light/dark menu
  // bars; a colored icon looks out of place there. (No-op on Windows/Linux.)
  if (process.platform === "darwin") trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
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
    // macOS gates screen capture behind the Screen Recording permission; without it
    // getSources() returns a black frame. We can't prompt programmatically, so guide
    // the user to enable it (the OS lists the app after the first attempt).
    if (process.platform === "darwin" &&
        systemPreferences.getMediaAccessStatus("screen") !== "granted") {
      notify("Enable Screen Recording",
        "Allow Vincony in System Settings > Privacy & Security > Screen Recording, then try again.");
      shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
      return;
    }
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { width, height } = disp.size;
    const scale = disp.scaleFactor || 1;
    // Cap the long side at 1920px and encode JPEG. A full-res 4K PNG data URL exceeds the
    // ~5MB sessionStorage quota used to hand the image to the chat view, so setItem would
    // throw and the screenshot would be silently dropped. 1920px JPEG is ~5-10x smaller —
    // comfortably under quota and plenty of detail for "what is this?".
    const fullW = Math.round(width * scale);
    const fullH = Math.round(height * scale);
    const ratio = Math.min(1, 1920 / Math.max(fullW, fullH));
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(fullW * ratio), height: Math.round(fullH * ratio) },
    });
    const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
    if (!src) return;
    const dataUrl = "data:image/jpeg;base64," + src.thumbnail.toJPEG(85).toString("base64");
    showMain();
    const wc = mainWindow!.webContents;
    // Stage the image into sessionStorage on the CURRENT app page, THEN navigate to
    // /os/chat (same origin, so sessionStorage survives). This guarantees the image is
    // present before the chat view mounts and reads it once — no IPC/navigation race.
    const stageAndGo = async () => {
      const arg = JSON.stringify(JSON.stringify({ dataUrl, name: "screenshot.jpg" }));
      try {
        await wc.executeJavaScript(`sessionStorage.setItem("vinc_incoming_image", ${arg})`);
      } catch { /* page not ready / storage blocked — navigate anyway */ }
      wc.loadURL(appOrigin() + "/os/chat");
    };
    if (wc.isLoading()) wc.once("did-finish-load", stageAndGo); else stageAndGo();
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
    // Bounce the webview to the hosted path so the PKCE code is exchanged in the same
    // session that started the OAuth flow. Preserve any sub-path:
    //   vincony://auth?code=…          → /auth?code=…
    //   vincony://auth/callback?code=… → /auth/callback?code=…
    const host = u.hostname ? `/${u.hostname}` : "";
    const pathname = u.pathname && u.pathname !== "/" ? u.pathname : "";
    showMain(`${host}${pathname}${u.search || ""}` || "/auth");
  } catch { /* ignore malformed deep links */ }
}

/* ── Auto-update ─────────────────────────────────────────────────────── */
function initAutoUpdate() {
  // electron-updater only works in a packaged app (it reads app-update.yml). Skip in
  // dev to avoid noisy "cannot find update" errors.
  if (!app.isPackaged) return;
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
    // Windows attributes toast notifications by AppUserModelID; set it (matching the NSIS
    // appId) so Notification toasts show as "Vincony" instead of being dropped/generic.
    if (process.platform === "win32") app.setAppUserModelId("com.vincony.desktop");
    installPermissionHandlers();
    createMainWindow();
    createTray();
    initAutoUpdate();
    // register() returns false if the OS/another app already owns the combo. Collect any
    // failures and tell the user once, instead of silently doing nothing.
    const shortcuts: Array<[string, () => void]> = [
      [QUICK_ASK_HOTKEY, toggleQuickAsk],
      [SCREENSHOT_HOTKEY, captureAndAsk],
      [CLIPBOARD_HOTKEY, clipboardAsk],
    ];
    const failed = shortcuts.filter(([accel, fn]) => !globalShortcut.register(accel, fn)).map(([a]) => a);
    if (failed.length) {
      notify("Some hotkeys are unavailable",
        `${failed.join(", ")} ${failed.length > 1 ? "are" : "is"} in use by another app. Set VINCONY_HOTKEY to change quick-ask.`);
    }
    // A deep link can arrive in the initial argv (cold start) on Windows.
    const initialDeepLink = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (initialDeepLink) handleDeepLink(initialDeepLink);

    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); else showMain(); });
  });

  app.on("window-all-closed", () => { /* keep running in the tray; quit only via tray menu */ });
  app.on("will-quit", () => globalShortcut.unregisterAll());
}
