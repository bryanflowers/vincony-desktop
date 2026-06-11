/**
 * electron-builder afterSign hook: notarize the macOS app with Apple — but ONLY when
 * the Apple credentials are present in the environment. Without them (local dev or an
 * unsigned validation build) it skips gracefully so the build still succeeds.
 *
 * Provide via CI secrets: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.
 */
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log("[notarize] Apple creds not set — skipping notarization (unsigned/validation build).");
    return;
  }

  const { notarize } = require("@electron/notarize");
  const appName = context.packager.appInfo.productFilename;
  console.log(`[notarize] Notarizing ${appName}.app …`);
  await notarize({
    appBundleId: "com.vincony.desktop",
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log("[notarize] Done.");
};
