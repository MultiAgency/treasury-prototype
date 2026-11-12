import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { RPCHandler } from "@orpc/server/node";
import { startAutopilot } from "./autopilot.js";
import { startNotifications } from "./notify.js";
import { startReconciliation } from "./recover.js";
import { router } from "./router.js";
import { executes, saveEnv } from "./env.js";
import { acquireExecutorLease } from "./executor-lease.js";
import { createExecutorLifecycle } from "./executor-lifecycle.js";
import { crossSite, serveStatic } from "../shared/http.js";
import { resumeOwnerIntents, setAgentCreationHandler } from "./owner-intents.js";
import { closeWorkOrders, resumeWorkOrders } from "./work-order-pool.js";

const PORT = Number(process.env.PORT ?? 8787);

const handler = new RPCHandler(router);
if (process.env.INVOICES_PORT && !process.env.AGENT_ID) throw new Error("Configure the payout agent before enabling invoices");
// An approve-only instance (EXECUTOR=off) is not the agent's executor: no lease, and no invoice page, which sends.
if (!executes() && process.env.INVOICES_PORT) throw new Error("EXECUTOR=off can't serve invoices: invoices send payouts");
const executor = createExecutorLifecycle({
  executes,
  acquire: acquireExecutorLease,
  configure: id => saveEnv({ AGENT_ID: id }),
  start: () => {
    try { startReconciliation(); startNotifications(); startAutopilot(); }
    catch (error) {
      console.error("Executor startup failed; stopping before accepting more work.", error);
      process.exit(1);
    }
  },
});
setAgentCreationHandler(id => executor.activate(id, true));
await executor.activate(process.env.AGENT_ID);
if (executes() && process.env.AGENT_ID) resumeWorkOrders(process.env.AGENT_ID);
const invoices = process.env.INVOICES_PORT ? (await import("./invoice-http.js")).startInvoiceServer() : undefined;

// This process holds the agent's grant: answer only same-origin requests on loopback.
const dashboard = createServer(async (req, res) => {
  // Nothing a request carries may end this process: it also runs the agent's money loops.
  try {
    await serveDashboard(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Treasury dashboard on http://localhost:${PORT}`);
  resumeOwnerIntents();
});

async function serveDashboard(req: IncomingMessage, res: ServerResponse) {
  // Loopback only, and only from this page: a malformed Origin (`null`, garbage) is refused like a foreign one.
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? "") || crossSite(req)) {
    res.writeHead(403).end();
    return;
  }
  if (["/rpc/instance", "/rpc/autopilot/log", "/rpc/owner/actions", "/rpc/paymentHistory", "/rpc/strategy/get"].includes(req.url?.split("?")[0] ?? "")) res.setHeader("cache-control", "private, no-store");
  await executor.activate(process.env.AGENT_ID);
  const { matched } = await handler.handle(req, res, { prefix: "/rpc" });
  if (matched) return;

  const url = URL.parse(req.url ?? "/", "http://localhost");
  if (!url) {
    res.writeHead(400).end();
    return;
  }
  await serveStatic(res, "web/dist", url.pathname, "Not found. Run `pnpm build:web` first, or use `pnpm web` in development.");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => {
  dashboard.close(); invoices?.close();
  await closeWorkOrders();
  await executor.close();
  process.exit(0);
});
