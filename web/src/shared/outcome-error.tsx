import { Link } from "@tanstack/react-router";
import type { OwnerFailure } from "@multiagency/sdk";
import { ErrorBox } from "./ui";

/** Refusals before anything was sent: the platform's typed kind decides the guidance, never the server's wording. */
const BLOCKED = {
  unresolved: { text: "Unresolved operations block new sends. Nothing was sent. Follow their outcomes before another action.", link: "Review unresolved operations" },
  busy: { text: "Another money action is running on this Treasury. Nothing was sent. Check its outcome before another action.", link: "Review recent operations" },
} as const;

/** A typed refusal the platform answered before sending anything. */
export const refusedBeforeSending = (kind?: OwnerFailure["kind"]): kind is keyof typeof BLOCKED => kind === "unresolved" || kind === "busy";

/** A money action's failure: guidance for a typed refusal, otherwise the error as reported. */
export function OutcomeError({ error, kind }: { error?: string; kind?: OwnerFailure["kind"] }) {
  if (error && refusedBeforeSending(kind)) return <div role="status" className="flex flex-col gap-2 rounded-lg border p-4 text-sm">
    <p>{BLOCKED[kind].text}</p>
    <Link to="/activity" className="self-start underline">{BLOCKED[kind].link}</Link>
  </div>;
  return <ErrorBox error={error} />;
}
