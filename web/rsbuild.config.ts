import { readFileSync } from "node:fs";
import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

/**
 * The mark: a pixel vault robot with a vault turning wheel, drawn to read at 16px. Treasury yellow or shared-workspace blue, no tile;
 * the door's tint strengthens on dark tab bars.
 */
const treasuryOnly = process.env.PUBLIC_TREASURY_ONLY !== "false";
const logoColor = treasuryOnly ? "oklch(0.795 0.184 86.047)" : "#0091fd";
const logoTint = treasuryOnly ? ".t{opacity:.28}" : ".t{opacity:.28}@media (prefers-color-scheme:dark){.t{opacity:.5}}";
const VAULT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -6 38 38"><style>${logoTint}</style><g fill="${logoColor}"><rect x="6" y="6" width="20" height="18" class="t"/><path fill-rule="evenodd" d="M7 3h18v2h3v20h-3v2H7v-2H4V5h3zM7 6v18h18V6z"/><path d="M7 27h4v3H7zm14 0h4v3h-4zM11-1h2v4h-2zm8 0h2v4h-2zM10-4h4v3h-4zm8 0h4v3h-4z"/><g transform="rotate(20 16 15)"><circle cx="16" cy="15" r="5.3" fill="none" stroke="${logoColor}" stroke-width="1.1" /><path d="M16 8v7m0 0 6.06 3.5M16 15l-6.06 3.5" fill="none" stroke="${logoColor}" stroke-width="1.1" /><rect x="15" y="7.3" width="2" height="3" rx="0.4" /><rect x="15" y="7.3" width="2" height="3" rx="0.4" transform="rotate(120 16 15)" /><rect x="15" y="7.3" width="2" height="3" rx="0.4" transform="rotate(240 16 15)" /><circle cx="16" cy="15" r="1.8" /><circle cx="16" cy="15" r="1.1" fill="none" stroke="#15171b" stroke-width="0.3" opacity="0.5" /></g><path fill-rule="evenodd" d="M2 8h6v4H2zm1 1v2h1V9zm-1 10h6v4H2zm1 1v2h1v-2z" /><path d="M23.5 14h2v3h-2z" /></g></svg>`;

/**
 * The Treasury skill served at /skill.md: its SKILL.md with the input contract inlined, since the
 * page has no directory to resolve `references/` against. The helper itself ships with the skill package.
 */
const skillPage = {
  from: "../skills/treasury/SKILL.md", to: "skill.md",
  transform: (content: Buffer) => {
    const reference = readFileSync(new URL("../skills/treasury/references/api.md", import.meta.url), "utf8");
    const served = "> Served by this Treasury's frontend release. The helper (`scripts/treasury.mjs` with its `package.json`) ships with the Treasury skill package (`skills/treasury`); resolve `/path/to/treasury` to that package's directory.\n\n";
    const body = content.toString().replaceAll("](references/api.md)", "](#machine-contract)").replace(/^(---\n[\s\S]*?\n---\n)/, `$1\n${served}`);
    return `${body.trimEnd()}\n\n${reference.trim()}\n`;
  },
};

export default defineConfig({
  plugins: [pluginReact()],
  // `proposals`: the Treasury app's owner page, served by app/server.ts on its own host (no gateway Shell).
  source: { entry: { index: "./src/main.tsx", proposals: "./src/proposals/main.tsx" }, define: { "process.env.PUBLIC_TREASURY_ONLY": JSON.stringify(process.env.PUBLIC_TREASURY_ONLY ?? "true") } },
  // The one build seam: only the shared build bundles the inherited Payables/Portfolio surface.
  resolve: { alias: { "@legacy": treasuryOnly ? "./src/legacy/absent.ts" : "./src/legacy/surface.ts" } },
  html: {
    template: "./index.html",
    title: "Agentic Treasury",
    // The Vault mark inline: no image file to ship.
    tags: [{ tag: "link", attrs: { rel: "icon", type: "image/svg+xml", href: `data:image/svg+xml,${encodeURIComponent(VAULT)}` } }],
  },
  // Only the focused Treasury build is a release that declares the platform capabilities it calls (P2 manifest v1).
  output: { distPath: { root: "dist" }, copy: treasuryOnly ? [{ from: "./contract.json" }, skillPage] : [] },
  // `pnpm server` answers the RPC calls; the dev server only serves the UI.
  server: { port: 3000, proxy: { "/rpc": "http://127.0.0.1:8787" } },
});
