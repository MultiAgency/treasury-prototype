import type { Client as RpcClient, FriendlyClientOptions } from "@orpc/client";
import { gatewayDenialScope, ownerClient, ownerStreams, type OwnerCallOptions, type OwnerFailure, type OwnerInputs, type OwnerOutput, type OwnerProcedure, type RefusalDetails } from "@multiagency/sdk";
import { reportAccessDenial } from "./access";

/**
 * Where this agent's pages live: "" when a local agent server serves them, "/a/<agent>" behind the
 * hosted gateway, which forwards that prefix's calls to the agent's own server.
 */
export const BASE = (location.pathname.match(/^\/a\/[a-z0-9-]+/)?.[0] ?? "") as "" | `/${string}`;

/** The procedures this build may call. `pnpm check:frontend` narrows it to the release's declared capabilities. */
export type ClientProcedure = OwnerProcedure;

type Stream = (typeof ownerStreams)[number];
type Answer<P extends OwnerProcedure> = P extends Stream ? AsyncIterable<OwnerOutput<P>> : OwnerOutput<P>;
/** An oRPC client procedure, so `@orpc/tanstack-query` derives keys, inputs, outputs and errors from it. */
type Call<P extends OwnerProcedure> = RpcClient<Record<never, never>, OwnerInputs[P], Answer<P>, OwnerCallError>;
type Group<P> = P extends `${infer G}/${string}` ? G : never;
/** The published owner procedures as `client.group.name(input)`, the shape the app's views already use. */
export type Client = { [P in Exclude<ClientProcedure, `${string}/${string}`>]: Call<P> }
  & { [G in Group<ClientProcedure>]: { [P in ClientProcedure as P extends `${G}/${infer N}` ? N : never]: Call<P> } };

/** A failed owner call. `failure.kind` decides recovery; the message is only for people. */
export class OwnerCallError extends Error {
  readonly code?: "UNAUTHORIZED" | "FORBIDDEN";
  readonly status?: 401 | 403;
  /** Provider-reported refusal metadata; an observation, never permission to repeat an action. */
  readonly data?: RefusalDetails;
  constructor(readonly failure: OwnerFailure) {
    super(failure.kind === "unknown" ? unknownOutcome(failure.procedure)
      : failure.kind === "unavailable" ? "This read failed or returned an answer that could not be verified. Reading again is safe."
        : failure.error);
    if (failure.kind === "provider" && failure.details) this.data = failure.details;
    if (failure.kind === "session" || failure.kind === "forbidden") {
      this.status = failure.status;
      this.code = failure.kind === "session" ? "UNAUTHORIZED" : "FORBIDDEN";
    }
  }
}

/** Plan previews save a plan and move nothing; every other unknown outcome may have sent something. */
const PREVIEWS = new Set<string>(["rebalance", "steward/propose"]);
function unknownOutcome(procedure: string) {
  return PREVIEWS.has(procedure)
    ? "The preview was interrupted, so a plan may have been saved. Nothing was sent. Observations are read again; preview again for a fresh plan, and any earlier plan expires unused."
    : `The outcome is unknown: this ${procedure} request may have taken effect. Check the recorded operations before any other action; nothing is sent again automatically.`;
}

/** The recovery kind of a failed owner call, if it was one. */
export const failureKind = (error: unknown) => error instanceof OwnerCallError ? error.failure.kind : undefined;

const streams = new Set<string>(ownerStreams);

/** A client for the agent server whose pages live at `base` (see BASE). It never retries. */
export function clientFor(base: "" | `/${string}`): Client {
  const owner = ownerClient({ base, async fetch(request, init) {
    const response = await fetch(request, init);
    // Gateway denials are plain HTTP responses, not encoded RPC errors; report their scope before ownerClient classifies them.
    if (response.status === 401 || response.status === 403) {
      const body = await response.clone().json().catch(() => null);
      if (typeof body?.json?.code !== "string") {
        // Older gateways declare no scope. Their procedure denial must not revoke agent reads.
        const scope = gatewayDenialScope(body) ?? (body?.error === "Operators only" ? "procedure" : response.status === 401 ? "session" : "agent");
        reportAccessDenial({ base, scope, message: typeof body?.error === "string" ? body.error : "Access is no longer available." });
      }
    }
    return response;
  } });
  const call = async (path: string, input: unknown, options?: OwnerCallOptions) => {
    const answer = await (owner.call as (path: string, input: unknown, options?: OwnerCallOptions) => ReturnType<typeof owner.call>)(path, input, options);
    if (!answer.ok) throw new OwnerCallError(answer);
    return answer.value;
  };
  const stream = async (path: string, input: unknown, options?: OwnerCallOptions): Promise<AsyncIterable<unknown>> => {
    const events = (owner.stream as (path: string, input: unknown, options?: OwnerCallOptions) => ReturnType<typeof owner.stream>)(path, input, options);
    return { async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = await events.next();
        if (!next.done) { yield next.value; continue; }
        if (next.value) throw new OwnerCallError(next.value);
        return;
      }
    } };
  };
  const node = (path: string): unknown => new Proxy(() => undefined, {
    // A client is never a thenable: awaiting one must not issue a request.
    get: (_target, key) => typeof key === "string" && key !== "then" ? node(path ? `${path}/${key}` : key) : undefined,
    // Only cancellation crosses into ownerClient; query-library context never changes a call.
    apply: (_target, _this, [input, options]: [unknown, FriendlyClientOptions<Record<never, never>>?]) => {
      const forwarded: OwnerCallOptions = { signal: options?.signal };
      return streams.has(path) ? stream(path, input, forwarded) : call(path, input, forwarded);
    },
  });
  return node("") as Client;
}

export const client = clientFor(BASE);

/** One call to the hosted gateway's own API (`/gw/...`); its `{ error }` answer is thrown. */
export async function gw<T>(path: `/gw/${string}`, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    const message = body.error ?? `${path}: ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      reportAccessDenial({ base: "", scope: response.status === 401 ? "session" : "procedure", message });
      throw new OwnerCallError(response.status === 401 ? { ok: false, kind: "session", status: 401, error: message } : { ok: false, kind: "forbidden", status: 403, error: message });
    }
    throw new Error(message);
  }
  return body;
}
