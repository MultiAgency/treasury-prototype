import type { IncomingMessage } from "node:http";

/** Select only an explicitly configured signing host, preserving the configured spelling. */
export function signingHost(req: Pick<IncomingMessage, "headers">, canonical: string, additional: readonly string[]) {
  return [canonical, ...additional].find(host => host.toLowerCase() === req.headers.host?.toLowerCase());
}

/** Only configured legacy hosts redirect. API calls and bodies never cross origins. */
export function canonicalHostAnswer(req: IncomingMessage, url: URL, canonical: string, aliases: readonly string[]) {
  const host = req.headers.host?.toLowerCase();
  if (!host || host === canonical.toLowerCase() || !aliases.some(alias => alias.toLowerCase() === host)) return null;
  const pageRead = req.method === "GET" || req.method === "HEAD";
  if (pageRead && url.pathname === "/health") return null;
  const api = /^\/(?:gw|rpc)(?:\/|$)/.test(url.pathname) || /^\/a\/[^/]+\/rpc(?:\/|$)/.test(url.pathname);
  if (!pageRead || api) return { status: 421 as const };
  const target = new URL(`https://${canonical}`);
  // Assign components instead of resolving an untrusted path (which could name another origin).
  target.pathname = url.pathname;
  target.search = url.search;
  return { status: 302 as const, location: target.href };
}
