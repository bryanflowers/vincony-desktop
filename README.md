# Vincony Desktop

The Vincony desktop app for **Windows** (and **macOS** — Phase 2). A thin, hardened
Electron shell that loads the live hosted app (`https://app.vincony.com`) — the web
app is SSR and can't be statically bundled — and adds the native power features a
browser tab can't:

- **Global quick-ask hotkey** (`Alt+Space`) — a Spotlight-style floating bar to ask
  Vincony from any app; routes to `/os/chat?q=…`.
- **Tray mini-chat** — click the tray icon for a compact chat popover; the app keeps
  running in the tray.
- **Screenshot → ask** (`Ctrl+Shift+S`) — capture the screen and drop it straight
  into a new chat as an image.
- **Clipboard → ask** (`Ctrl+Shift+V`) — ask Vincony about whatever text you copied.
- **Auto-update** (electron-updater → GitHub Releases), **`vincony://` deep links**
  (OAuth return), and **OS notifications**.

Security: `contextIsolation` on, `nodeIntegration` off, `sandbox` on, navigation
locked to `*.vincony.com` (everything else opens in the system browser).

## Develop

```bash
npm install
npm run dev                  # builds + launches Electron against app.vincony.com
VINCONY_APP_URL=http://localhost:3000 npm run dev   # against a local web build
```

## Build a Windows installer locally

```bash
npm run dist                 # → release/Vincony Setup <version>.exe (unsigned locally)
```

## Release (CI)

Push a `v*` tag (e.g. `v1.0.0`) — GitHub Actions builds, **code-signs** (if the
`WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` repo secrets are set), and publishes the
installer + update feed to **GitHub Releases**. The running app auto-updates from there.

### Code signing (Windows)
Add two repo secrets so installs are clean (no SmartScreen warning):
- `WIN_CSC_LINK` — base64 of your code-signing `.pfx`
- `WIN_CSC_KEY_PASSWORD` — the `.pfx` password

### Supabase config
Add `vincony://auth` to the project's **Auth → URL Configuration → Redirect URLs**
so desktop OAuth can round-trip through the custom protocol.

## Phase 2 — macOS
The `mac` target is already in `electron-builder.yml`; it needs an Apple Developer
account, a macOS CI runner, `build/icon.icns`, and notarization secrets.
