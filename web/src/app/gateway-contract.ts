import { gatewayDiscovery } from "@multiagency/sdk";
import { z } from "zod";

/** Proto's `GET /gw/me` contract, plus the flag Treasury's retained standalone gateway still sends. */
const gatewaySchema = gatewayDiscovery.extend({ selfServiceTreasury: z.boolean().optional() });
export type Gateway = z.output<typeof gatewaySchema>;
export type GatewayAgent = Gateway["agents"][number];

/** A missing/malformed hosted gateway never grants the trusted local-server view. */
export async function readGateway(response: Response, location: Pick<Location, "hostname" | "protocol" | "pathname">): Promise<Gateway | null> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    const local = location.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) && !location.pathname.startsWith("/a/");
    if (response.ok && local) return null;
    throw new Error(`The hosted gateway returned an unexpected response (${response.status}).`);
  }
  const body: unknown = await response.json();
  if (!response.ok) {
    const failure = z.object({ error: z.string() }).safeParse(body);
    throw new Error(failure.success ? failure.data.error : `The gateway answered ${response.status}.`);
  }
  const parsed = gatewaySchema.safeParse(body);
  if (!parsed.success) throw new Error("The gateway returned invalid discovery data.");
  const gateway = parsed.data;
  // Explicit shared-host area restrictions take precedence over legacy presentation flags.
  const shared = gateway.setupAreas !== undefined || gateway.selfService !== undefined;
  if (!shared) return gateway;
  return { ...gateway, selfServiceTreasury: gateway.selfService === true && gateway.setupAreas?.includes("treasury") === true };
}

/** Preserve standalone setup while using the shared service's owner/area contract when advertised. */
export function treasuryReservation(gateway: Gateway, kind: "wallet" | "dao", dao: string): { path: `/gw/${string}`; body: Record<string, string> } {
  if (!gateway.viewer || !gateway.selfServiceTreasury) throw new Error("Treasury setup is not available on this host.");
  if (gateway.selfService === true && gateway.setupAreas?.includes("treasury"))
    return { path: "/gw/agents", body: { owner: kind === "wallet" ? gateway.viewer.account : dao.trim(), kind, area: "treasury" } };
  return { path: "/gw/treasuries", body: kind === "wallet" ? { kind } : { kind, dao: dao.trim() } };
}
