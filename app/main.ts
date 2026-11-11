import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chainKeyLookup } from "../shared/signin.js";
import { RuntimeTokens } from "./runtime-tokens.js";
import { createAppServer } from "./server.js";
import { treasuryApp } from "./treasury-app.js";

/**
 * Starts the Treasury app's server. `APP_HOST`: the host owners sign in to. `SESSION_SECRET`: signs their sessions.
 * `PLATFORM_URL` and `TREASURY_APP_CREDENTIAL` (`tap_…`, a server secret): the platform's `/apps/v1` and this
 * deployment's credential. `APP_STATE`: this app's private records (requests and agent tokens).
 */
const required = (name: string) => process.env[name] || (() => { throw new Error(`Set ${name} (see app/main.ts)`); })();
const host = required("APP_HOST"), state = process.env.APP_STATE ?? ".app";
const platformUrl = required("PLATFORM_URL");
if (!/^https:\/\//.test(platformUrl)) throw new Error("PLATFORM_URL must be an https:// origin");
const port = Number(process.env.PORT ?? 8900);
createAppServer({ host, secret: process.env.SESSION_SECRET ?? "", keyLookup: chainKeyLookup,
  platform: treasuryApp({ platform: platformUrl as `https://${string}`, credential: required("TREASURY_APP_CREDENTIAL"), state }),
  tokens: new RuntimeTokens(join(state, "tokens")),
  // The owner's page: web/'s `proposals` entry, built by `pnpm build:web`.
  web: process.env.APP_WEB_DIST ?? fileURLToPath(new URL("../web/dist", import.meta.url)) })
  .listen(port, () => console.log(`Treasury app on port ${port}, signing in to ${host}`));
