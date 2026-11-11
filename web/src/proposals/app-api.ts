import type { ProposalView } from "@multiagency/sdk";

/**
 * The Treasury app server's owner routes (`app/server.ts`), on this page's own origin. Every answer says what happened
 * by `exit`, never by message text: 0 done, 2 nothing sent, 3 unknown (never resend; read again), 4 partial.
 */
export type Failure = { ok: false; kind: string; error?: string; code?: string };
export type Answer<T> = { exit: number; result: { ok: true; value: T } | Failure };
/** App-owned durable decision-attempt evidence; missing evidence never permits signing. */
export type DecisionAnswer<T> = Answer<T> & { decisionHeld: boolean };
/** A local pre-relay hold also covers a request still in transit before the server records its claim. */
export const decisionKey = (where: Where, kind: "proposal" | "order", id: string) =>
  `treasury-decisions:${encodeURIComponent(where.organization)}:${encodeURIComponent(where.agent)}:${kind}:${id}`;
export const decisionWasAttempted = (key: string) => {
  try { return Object.keys(localStorage).some(candidate => candidate === key || candidate.startsWith(`${key}:`)); }
  catch { return true; }
};
export type Signing = { recipient: string; approve: string; reject: string };
export type Where = { organization: string; agent: string };
export type Consent = { id: string; scopes: string[]; expiresAt: number; revoked: boolean };
export type PreparedConsent = { message: string; recipient: string; nonce: string; scopes: string[] };
export type AgentToken = { id: string; label: string; scopes: string[]; expiresAt: number; revoked: boolean };

/** A request that couldn't be completed: whether it may have taken effect is the caller's question to answer. */
export class AppRequestError extends Error {
  constructor(message: string, readonly status: number | null) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "same-origin", headers: { ...(init.body && { "content-type": "application/json" }), ...init.headers } });
  } catch { throw new AppRequestError("The Treasury app didn't answer.", null); }
  const body = await response.json().catch(() => null);
  if (!response.ok && !(body && typeof body.exit === "number")) throw new AppRequestError(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`, response.status);
  return body as T;
}
const query = ({ organization, agent }: Where) => `organization=${encodeURIComponent(organization)}&agent=${encodeURIComponent(agent)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const appApi = {
  /** The signed-in account, or null. */
  me: () => request<{ account: string }>("/app/me").then(({ account }) => account, (error: AppRequestError) => {
    if (error.status === 401) return null;
    throw error;
  }),
  challenge: () => request<{ message: string; recipient: string; nonce: string }>("/app/challenge"),
  signIn: (signed: Record<string, unknown>) => request<{ account: string }>("/app/session", post(signed)),
  signOut: () => request<{ account: null }>("/app/logout", post({})),
  list: (where: Where) => request<Answer<{ proposals: ProposalView[] }>>(`/app/proposals?${query(where)}`),
  read: (where: Where, id: string) => request<DecisionAnswer<ProposalView> & { sign?: Signing }>(`/app/proposals/${id}?${query(where)}`),
  decide: (where: Where, id: string, verdict: "approve" | "reject", signed: { message: string; nonce: string; publicKey: string; signature: string }) =>
    request<DecisionAnswer<ProposalView>>(`/app/proposals/${id}/decide`, post({ ...where, verdict, signed })),
  execute: (where: Where, id: string) => request<Answer<ProposalView>>(`/app/proposals/${id}/execute`, post(where)),
  /** The agent's consents to this app, as the platform holds them. */
  consents: (where: Where) => request<{ consents: Consent[] }>(`/app/connect?${query(where)}`).then(({ consents }) => consents),
  /** The consent text this app built for the owner to sign: read + treasury, and treasury-execute only when asked. */
  prepareConnect: (where: Where, execute: boolean, days: number) => request<PreparedConsent>("/app/connect/prepare", post({ ...where, execute, days })),
  /** Submits the owner's signature over the prepared text; the app relays only a text it prepared. */
  connect: (signed: { nonce: string; publicKey: string; signature: string }) => request<{ consent: Consent }>("/app/connect", post(signed)),
  /** Tokens the owner issued for outside agents: read and/or propose, never execute. */
  tokens: (where: Where) => request<{ tokens: AgentToken[] }>(`/app/tokens?${query(where)}`).then(({ tokens }) => tokens),
  /** Issues a token; its secret is in this answer only. */
  issueToken: (where: Where, label: string, scopes: string[], ttlSeconds: number) =>
    request<{ token: AgentToken; secret: string }>("/app/tokens", post({ ...where, label, scopes, ttlSeconds })),
  revokeToken: (id: string) => request<{ revoked: true }>(`/app/tokens/${id}`, { method: "DELETE" }),
};
