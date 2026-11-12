import type { LimitOrderView, ProposalView } from "@multiagency/treasury-app-sdk";

/**
 * The Treasury app server's owner routes (`app/server.ts`), on this page's own origin. Every answer says what happened
 * by `exit`, never by message text: 0 done, 2 nothing sent, 3 unknown (never resend; read again), 4 partial.
 */
export type Failure = { ok: false; kind: string; error?: string; code?: string };
export type Answer<T> = { exit: number; result: { ok: true; value: T } | Failure };
export type Signing = { recipient: string; approve: string; reject: string };
export type Where = { organization: string; agent: string };
export type Consent = { id: string; scopes: string[]; expiresAt: number; revoked: boolean };
export type PreparedConsent = { message: string; recipient: string; nonce: string; scopes: string[] };
export type OrderAccess = { capable: boolean; consented: boolean; owner: string; signer: "wallet" | "dao"; mayRead: boolean; mayPrepare: boolean; mayExecute: boolean; mayVote: boolean; mayConsent: boolean };
export type OrderTerms = { base_asset: string; quote_asset: string; side: "buy" | "sell"; quantity: string; price: string; deadline: string; confidential: true };
export type OrderRequest = OrderTerms & { requestId: string; expiresAt: string; note?: string };
export type OrderQuote = { spendAsset: string; spendAmount: string; outputAsset: string; warnings: string[] };
export type DaoOrderRequest = { id: string; dao: string; order: string; hash: string; description: string; votingUntil: number; verdict: "approve" | "reject" };
export type DaoOrderFiled = { request: DaoOrderRequest; transactions: { proposal: import("../features/owner/wallet").Transaction | null; proposalAndVote: import("../features/owner/wallet").Transaction | null } };
export type DaoOrderConsentFiled = { request: { id: string; dao: string; scopes: string[]; expiresAt: number; votingUntil: number; hash: string; description: string }; transactions: DaoOrderFiled["transactions"] };
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
  if (!response.ok && !(body && typeof body.exit === "number" && body.result && typeof body.result === "object" && typeof body.result.ok === "boolean")) throw new AppRequestError(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`, response.status);
  return body as T;
}
const query = ({ organization, agent }: Where) => `organization=${encodeURIComponent(organization)}&agent=${encodeURIComponent(agent)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const appApi = {
  daoOrderConsentFile: (where: Where, days = 30) => request<Answer<DaoOrderConsentFiled> & { message: string }>("/app/orders/consent", post({ ...where, days })),
  daoOrderConsentState: (where: Where, hash: string) => request<Answer<{ state: "pending" | "signed" }>>(`/app/orders/consent/${encodeURIComponent(hash)}?${query(where)}`),
  orderAccess: async (where: Where) => {
    const access = await request<OrderAccess>(`/app/orders/access?${query(where)}`);
    if (!access || !["capable", "consented", "mayRead", "mayPrepare", "mayExecute", "mayVote", "mayConsent"].every(key => typeof access[key as keyof OrderAccess] === "boolean")
      || typeof access.owner !== "string" || !["wallet", "dao"].includes(access.signer))
      throw new AppRequestError("The Treasury app returned unreadable order access. Check access again.", 502);
    return access;
  },
  orderList: (where: Where) => request<Answer<{ orders: LimitOrderView[] }>>(`/app/orders?${query(where)}`),
  orderQuote: (where: Where, input: OrderTerms) => request<Answer<OrderQuote>>("/app/orders/quote", post({ ...where, ...input })),
  orderCreate: (where: Where, input: OrderRequest) => request<Answer<LimitOrderView>>("/app/orders", post({ ...where, ...input })),
  orderRead: (where: Where, id: string) => request<Answer<LimitOrderView> & { sign?: Signing; attempts?: { place: boolean; cancel: boolean } }>(`/app/orders/${id}?${query(where)}`),
  orderDecide: (where: Where, id: string, verdict: "approve" | "reject", signed: { message: string; nonce: string; publicKey: string; signature: string }) =>
    request<Answer<LimitOrderView>>(`/app/orders/${id}/decide`, post({ ...where, verdict, signed })),
  orderPlace: (where: Where, id: string) => request<Answer<LimitOrderView>>(`/app/orders/${id}/place`, post(where)),
  orderCancel: (where: Where, id: string) => request<Answer<LimitOrderView>>(`/app/orders/${id}/cancel`, post(where)),
  orderContinueCancel: (where: Where, id: string) => request<Answer<LimitOrderView>>(`/app/orders/${id}/cancel/continue`, post(where)),
  orderRefresh: (where: Where, id: string) => request<Answer<LimitOrderView>>(`/app/orders/${id}/refresh`, post(where)),
  daoOrderFile: (where: Where, id: string, verdict: "approve" | "reject") => request<Answer<DaoOrderFiled>>(`/app/orders/${id}/dao`, post({ ...where, verdict })),
  daoOrderState: (where: Where, hash: string) => request<Answer<{ state: "pending" | "relayed"; request: DaoOrderRequest; orderState?: string }>>(`/app/orders/dao/${encodeURIComponent(hash)}?${query(where)}`),
  /** The signed-in account, or null. */
  me: () => request<{ account: string }>("/app/me").then(({ account }) => account, (error: AppRequestError) => {
    if (error.status === 401) return null;
    throw error;
  }),
  challenge: () => request<{ message: string; recipient: string; nonce: string }>("/app/challenge"),
  signIn: (signed: Record<string, unknown>) => request<{ account: string }>("/app/session", post(signed)),
  signOut: () => request<{ account: null }>("/app/logout", post({})),
  list: (where: Where) => request<Answer<{ proposals: ProposalView[] }>>(`/app/proposals?${query(where)}`),
  read: (where: Where, id: string) => request<Answer<ProposalView> & { sign?: Signing }>(`/app/proposals/${id}?${query(where)}`),
  decide: (where: Where, id: string, verdict: "approve" | "reject", signed: { message: string; nonce: string; publicKey: string; signature: string }) =>
    request<Answer<ProposalView>>(`/app/proposals/${id}/decide`, post({ ...where, verdict, signed })),
  execute: (where: Where, id: string) => request<Answer<ProposalView>>(`/app/proposals/${id}/execute`, post(where)),
  /** The agent's consents to this app, as the platform holds them. */
  consents: (where: Where) => request<{ consents: Consent[] }>(`/app/connect?${query(where)}`).then(({ consents }) => consents),
  /** The consent text this app built for the owner to sign: read + treasury, and treasury-execute only when asked. */
  prepareConnect: (where: Where, execute: boolean, days: number, orders = false) => request<PreparedConsent>("/app/connect/prepare", post({ ...where, execute, days, ...(orders && { orders: true }) })),
  /** Submits the owner's signature over the prepared text; the app relays only a text it prepared. */
  connect: (signed: { nonce: string; publicKey: string; signature: string }) => request<{ consent: Consent }>("/app/connect", post(signed)),
  /** Tokens the owner issued for outside agents: read and/or propose, never execute. */
  tokens: (where: Where) => request<{ tokens: AgentToken[] }>(`/app/tokens?${query(where)}`).then(({ tokens }) => tokens),
  /** Issues a token; its secret is in this answer only. */
  issueToken: (where: Where, label: string, scopes: string[], ttlSeconds: number) =>
    request<{ token: AgentToken; secret: string }>("/app/tokens", post({ ...where, label, scopes, ttlSeconds })),
  revokeToken: (id: string) => request<{ revoked: true }>(`/app/tokens/${id}`, { method: "DELETE" }),
};
