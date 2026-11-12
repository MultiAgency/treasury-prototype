import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useAgent } from "../../app/agent-context";
import { queries } from "../../shared/queries";
import { type Overview, usd } from "../../shared/lib";
import { PERIOD } from "../../shared/budget";
import { Button, Details, QueryError } from "../../shared/ui";
import { Activity } from "../activity/activity";

/** A saved plan's identifier, as `executePlan` accepts it. */
export const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Confirmed in this page session, or reopened from the page address with no pre-confirmation observation. */
export type ConfirmedPlan = {
  planId: string;
  /** When following started: confirmation, or the reload that reopened it. */
  confirmedAt: number;
  observedAt: number;
  policyDigest: Overview["digest"];
  budget: Overview["policy"]["usage"]["budget"] | null;
  reopened?: true;
};

/** The page address's `plan` search parameter, as a route validates it. */
export const planSearch = (search: Record<string, unknown>): { plan?: string } => ({
  plan: typeof search.plan === "string" && PLAN_ID.test(search.plan) ? search.plan : undefined,
});

/**
 * The plan this page follows: confirmed here, or named in the page address after a reload. The address
 * keeps only the plan's identity; following never replays execution.
 */
export function useFollowedPlan() {
  const { data } = useAgent();
  const observation = useQuery({ ...queries.overview, enabled: false });
  const cache = useQueryClient();
  const [selected, setSelected] = useState<ConfirmedPlan>();
  const { plan } = useSearch({ strict: false }) as { plan?: string };
  const navigate = useNavigate();
  // A reload keeps only the plan's identity; the confirming session's budget observation is gone.
  const [openedAt] = useState(Date.now);
  const followed: ConfirmedPlan | undefined = selected?.planId === plan ? selected
    : plan ? { planId: plan, confirmedAt: openedAt, observedAt: 0, policyDigest: null, budget: null, reopened: true } : undefined;
  const refreshResult = useCallback(() => { void Promise.all([queries.overview, queries.activity, queries.unresolved].map(query => cache.invalidateQueries({ queryKey: query.queryKey, exact: true }))); }, [cache]);
  const followPlan = (planId: string) => {
    setSelected({ planId, confirmedAt: Date.now(), observedAt: observation.dataUpdatedAt,
      policyDigest: data.digest, budget: observation.error ? null : structuredClone(data.policy.usage.budget) });
    void navigate({ to: ".", search: { plan: planId }, replace: true });
  };
  // Closing the view changes only the page address; it never cancels or replays an operation.
  const stopFollowing = useCallback(() => {
    setSelected(undefined);
    void navigate({ to: ".", search: {}, replace: true });
  }, [navigate]);
  return { followed, followPlan, stopFollowing, refreshResult };
}

/** Follows only the exact plan selected. Observation changes never authorize or replay a send. */
export function PlanOutcome({ selected, onStop }: { selected: ConfirmedPlan; onStop: () => void }) {
  const cache = useQueryClient();
  const interval = () => Date.now() - selected.confirmedAt < 10 * 60_000 ? 5_000 : false;
  const overview = useQuery({ ...queries.overview, retry: false, refetchInterval: interval });
  const activity = useQuery({ ...queries.activity, retry: false, refetchInterval: interval });
  const policyKnown = Boolean(selected.policyDigest && overview.data?.digest);
  const policyChanged = policyKnown && overview.data?.digest !== selected.policyDigest;
  const refresh = () => { void Promise.all([queries.overview, queries.activity, queries.unresolved].map(query => cache.invalidateQueries({ queryKey: query.queryKey, exact: true }))); };
  // A reopened plan has no baseline to compare, so its latest read stands alone.
  const latest = !overview.error && (selected.reopened || (policyKnown && !policyChanged)) ? overview.data?.policy.usage.budget : undefined;
  const headroom = (window: NonNullable<ConfirmedPlan["budget"]>[keyof typeof PERIOD] | undefined) =>
    !window ? "Unavailable" : window.limit_usd === null ? "No limit" : window.remaining_usd == null ? "Unavailable" : usd(window.remaining_usd);
  return <section aria-label="Confirmed plan outcome" className="flex min-w-0 flex-col gap-5 border-t pt-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-2"><h2 className="text-xl font-semibold">Follow the outcome</h2>
        <p className="max-w-prose text-sm text-muted-foreground">{selected.reopened
          ? "Following the exact plan named in this page’s address. Reopening it reads retained records and sends nothing."
          : "Following the exact plan you confirmed."} A returned execution stream does not prove every operation settled.</p></div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={overview.isFetching || activity.isFetching} onClick={refresh}>Refresh observations</Button>
        <Button variant="outline" size="sm" onClick={onStop}>Stop following this plan</Button>
      </div>
    </div>
    <div className="overflow-x-auto">
      <table aria-label="Budget observations for the confirmed plan" className="w-full text-left text-sm tabular-nums">
        <thead><tr className="border-b text-muted-foreground"><th scope="col" className="pb-3 pr-4 font-medium">Budget left</th><th scope="col" className="pb-3 pr-4 text-right font-medium">Before confirmation</th><th scope="col" className="pb-3 text-right font-medium">Latest observation</th></tr></thead>
        <tbody>{(Object.keys(PERIOD) as (keyof typeof PERIOD)[]).map(period => <tr key={period} className="border-b last:border-0">
          <th scope="row" className="py-3 pr-4 font-medium">{PERIOD[period]}</th><td className="py-3 pr-4 text-right">{headroom(selected.budget?.[period])}</td><td className="py-3 text-right">{headroom(latest?.[period])}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className="flex max-w-prose flex-col gap-2 text-sm text-muted-foreground">
      <p>Before confirmation: {selected.reopened ? "not retained after reload" : selected.observedAt && selected.budget ? new Date(selected.observedAt).toLocaleString() : "observation unavailable"}. Latest successful read: {overview.dataUpdatedAt ? new Date(overview.dataUpdatedAt).toLocaleString() : "not available"}{overview.isFetching ? " · refreshing" : ""}.</p>
      <p>Provider observations may include other activity. Their difference is not proof of this plan’s charges or atomic budget accounting. Reads refresh for ten minutes after {selected.reopened ? "reopening" : "confirmation"} while this view is visible.</p>
    </div>
    {overview.error && <><p className="text-sm text-warning-muted-foreground">Current budget observation unavailable.</p><QueryError error={overview.error} retry={() => overview.refetch()} /></>}
    {policyChanged && <p className="text-sm text-warning-muted-foreground">The reported policy changed. Its current budget is not compared with the earlier policy’s headroom.</p>}
    {!overview.error && !policyKnown && !selected.reopened && <p className="text-sm text-warning-muted-foreground">Policy identity is unavailable. Budget headroom is not compared across unconfirmed policies.</p>}
    <Activity planId={selected.planId} />
    <p className="text-sm text-muted-foreground">Operations last read: {activity.dataUpdatedAt ? new Date(activity.dataUpdatedAt).toLocaleString() : "not yet"}{activity.isFetching ? " · refreshing" : ""}. A read time shows when records were checked, not that an operation settled.</p>
    <Details summary="Confirmed plan reference"><code className="break-all text-xs">{selected.planId}</code></Details>
    <p className="max-w-prose text-sm text-muted-foreground">Stopping only closes this view. It cancels nothing, and the plan’s operations stay in Activity.</p>
    <Link to="/activity" className="inline-flex min-h-11 items-center self-start text-sm underline">Review all operations and recovery</Link>
  </section>;
}
