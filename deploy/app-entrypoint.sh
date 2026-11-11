#!/bin/sh
# Starts only the Treasury app. It never starts a gateway or an agent executor.
set -eu
umask 077

APP_DIR=${APP_DIR:-/app}
export APP_STATE="${APP_STATE:-/data/app}"
export APP_WEB_DIST="${APP_WEB_DIST:-$APP_DIR/web/dist}"
export PORT="${PORT:-8080}"
cd "$APP_DIR"

# Validate configuration and the exact owner page before opening a listener. Errors name fields, never their values.
node --input-type=module <<'JS'
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

const refuse = message => { console.error(`Treasury app startup refused: ${message}`); process.exit(1); };
for (const name of ["APP_HOST", "PLATFORM_URL", "SESSION_SECRET", "TREASURY_APP_CREDENTIAL"])
  if (!process.env[name]) refuse(`Set ${name} in the app service environment.`);
if (process.env.SESSION_SECRET.length < 32) refuse("SESSION_SECRET must have at least 32 characters.");
try {
  const value = process.env.APP_HOST, host = new URL(`https://${value}`);
  if (host.host.toLowerCase() !== value.toLowerCase() || host.username || host.password || host.pathname !== "/" || host.search || host.hash)
    refuse("APP_HOST must be a hostname with an optional port.");
} catch { refuse("APP_HOST must be a hostname with an optional port."); }
try {
  const platform = new URL(process.env.PLATFORM_URL);
  if (platform.protocol !== "https:" || platform.username || platform.password || platform.pathname !== "/" || platform.search || platform.hash)
    refuse("PLATFORM_URL must be an HTTPS origin without a path, credentials, query or fragment.");
} catch { refuse("PLATFORM_URL must be an HTTPS origin without a path, credentials, query or fragment."); }
if (!/^[0-9]+$/.test(process.env.PORT) || Number(process.env.PORT) > 65535)
  refuse("PORT must be an integer from 0 to 65535.");
if (!isAbsolute(process.env.APP_STATE)) refuse("APP_STATE must be an absolute path on persistent storage.");
if (!isAbsolute(process.env.APP_WEB_DIST)) refuse("APP_WEB_DIST must be an absolute path to the built app assets.");
if (process.env.RAILWAY_ENVIRONMENT_ID && process.env.RAILWAY_VOLUME_MOUNT_PATH !== "/data")
  refuse("Attach the app service's persistent volume at /data before starting it on Railway.");
if (process.env.RAILWAY_ENVIRONMENT_ID && !resolve(process.env.APP_STATE).startsWith("/data/"))
  refuse("APP_STATE must be a directory under /data on Railway.");
try {
  accessSync("app/main.ts", constants.R_OK);
  const root = realpathSync(process.env.APP_WEB_DIST);
  const page = readFileSync(resolve(root, "proposals.html"), "utf8");
  const assets = [...page.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map(match => match[1]).filter(value => value.startsWith("/static/"));
  if (!assets.some(value => /\.(?:js|mjs)(?:[?#]|$)/.test(value))) refuse("Build the proposals page and its static scripts before starting the app.");
  for (const asset of assets) {
    const pathname = decodeURIComponent(new URL(asset, "https://app.invalid").pathname);
    if (!pathname.startsWith("/static/")) refuse("The proposals page contains an invalid static asset path.");
    const file = realpathSync(resolve(root, `.${pathname}`));
    if (!file.startsWith(`${root}${sep}`) || !statSync(file).isFile()) refuse("The proposals page contains an invalid static asset path.");
    accessSync(file, constants.R_OK);
  }
} catch { refuse("The app source, proposals page or a referenced static asset is missing or unreadable."); }
JS

mkdir -p "$APP_STATE"
exec node --import tsx app/main.ts
