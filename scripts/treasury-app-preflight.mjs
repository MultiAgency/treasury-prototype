import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appClient } from "@multiagency/treasury-app-sdk";

export const PREFLIGHT_TIMEOUT_MS = 15_000;
export const PREFLIGHT_HELP = `Usage: node scripts/treasury-app-preflight.mjs [--organization <organization> --agent <agent>]

Required environment: PLATFORM_URL (HTTPS origin), TREASURY_APP_CREDENTIAL.
With no tuple, checks the host's treasury-limit-orders-v1 capability.
With a tuple, also checks the current identity and a matching live order consent.
Reads only SDK capabilities, identity and consents; creates no state or orders.
`;

const passed = kind => ({ status: "passed", kind });
const blocked = kind => ({ status: "blocked", kind });
const skipped = kind => ({ status: "not_checked", kind });
const resultKind = answer => ["session", "forbidden", "refused", "rate_limited", "unavailable"].includes(answer.kind) ? answer.kind : "unavailable";

/**
 * Read-only deployment evidence. Results contain fixed statuses/kinds, never upstream bodies, error strings or secrets.
 * `fetch`, `env`, `now` and a shorter timeout may be injected by offline tests; the CLI uses the 15-second bound.
 * @param {{args?: string[], env?: Record<string, string | undefined>, fetch?: typeof globalThis.fetch,
 *   now?: () => number, timeoutMs?: number}} [options]
 */
export async function preflight({ args = [], env = process.env, fetch = globalThis.fetch, now = Date.now, timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  if (args.includes("--help") || args.includes("-h")) return { exit: 0, help: PREFLIGHT_HELP };
  const checks = { configuration: passed("valid"), capabilities: skipped("not_checked"), identity: skipped("not_requested"), consent: skipped("not_requested") };
  const finish = exit => ({ exit, summary: { ok: exit === 0, readOnly: true, checks } });
  const invalid = kind => { checks.configuration = blocked(kind); return finish(2); };
  let organization, agent;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!value || value.startsWith("--")) return invalid("arguments_invalid");
    if (flag === "--organization" && organization === undefined) organization = value;
    else if (flag === "--agent" && agent === undefined) agent = value;
    else return invalid("arguments_invalid");
  }
  if ((organization === undefined) !== (agent === undefined)) return invalid("tuple_incomplete");
  if (organization !== undefined && (!/^[A-Za-z0-9_-]{1,128}$/.test(organization) || !/^[a-z0-9-]{1,32}$/.test(agent)))
    return invalid("tuple_invalid");
  let base;
  try {
    const value = env.PLATFORM_URL;
    if (!value || /[\u0000-\u0020]/.test(value) || !/^https:\/\/[^/\\?#@]+\/?$/i.test(value)) return invalid("platform_url_invalid");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || !url.hostname)
      return invalid("platform_url_invalid");
    base = url.origin;
  } catch { return invalid("platform_url_invalid"); }
  if (!env.TREASURY_APP_CREDENTIAL?.trim() || /[\r\n]/.test(env.TREASURY_APP_CREDENTIAL)) return invalid("app_credential_missing");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return invalid("timeout_invalid");

  const allowed = new Set([`${base}/apps/v1/capabilities`]);
  if (organization !== undefined) {
    allowed.add(`${base}/apps/v1/agents/${encodeURIComponent(agent)}`);
    allowed.add(`${base}/apps/v1/consents?organization=${encodeURIComponent(organization)}`);
    checks.identity = skipped("not_checked"); checks.consent = skipped("not_checked");
  }
  const bounded = (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    // A future SDK change cannot turn this preflight into a mutation, a relay poll, or an alternate-host request.
    if ((init.method ?? "GET").toUpperCase() !== "GET" || !allowed.has(url)) throw new Error("Preflight permits only its exact SDK read routes");
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    return fetch(input, { ...init, signal, redirect: "error" });
  };
  const app = appClient({ base, credential: env.TREASURY_APP_CREDENTIAL, fetch: bounded });
  const capabilities = await app.capabilities();
  if (!capabilities.ok) { checks.capabilities = blocked(resultKind(capabilities)); return finish(2); }
  if (!capabilities.value.capabilities.includes("treasury-limit-orders-v1")) {
    checks.capabilities = blocked("missing_capability"); return finish(2);
  }
  checks.capabilities = passed("supported");
  if (organization === undefined) return finish(0);

  const [identity, consents] = await Promise.all([app.identity(agent), app.consents.list(organization)]);
  if (!identity.ok) checks.identity = blocked(resultKind(identity));
  else if (identity.value.agent !== agent || !identity.value.owner || !identity.value.host || !identity.value.deployment)
    checks.identity = blocked("identity_mismatch");
  else if (!identity.value.created || !identity.value.agentId) checks.identity = blocked("not_created");
  else checks.identity = passed("current");
  if (!consents.ok) { checks.consent = blocked(resultKind(consents)); return finish(2); }
  if (checks.identity.status !== "passed") { checks.consent = blocked("identity_unverified"); return finish(2); }
  const who = identity.value, signer = who.signer ?? "wallet", time = now();
  const live = consents.value.consents.some(consent => consent.organization === organization && consent.agent === agent
    && consent.owner === who.owner && consent.agentId === who.agentId && consent.host === who.host && consent.deployment === who.deployment
    && (consent.signer ?? "wallet") === signer && !consent.revoked && consent.revokedAt === null && consent.expiresAt > time
    && consent.scopes.includes("treasury") && consent.scopes.includes("treasury-orders"));
  checks.consent = live ? passed("live_order_consent") : blocked("missing_live_order_consent");
  return finish(live ? 0 : 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const answer = await preflight({ args: process.argv.slice(2) });
  process.stdout.write(answer.help ?? `${JSON.stringify(answer.summary)}\n`);
  process.exitCode = answer.exit;
}
