import { Link } from "@tanstack/react-router";
import { Badge, Button } from "../../shared/ui";
import { Rebalance } from "../portfolio/automations";
import { PlanOutcome, useFollowedPlan } from "../portfolio/plan-outcome";
import { AgentChecks, RunStep, useRunChecks } from "./run-checks";

/**
 * The guided Treasury run on this agent: check readiness, preview and explicitly execute a rebalance,
 * then follow that exact plan. The real controls own every signature, preview and execution; the plan
 * followed is the one confirmed or named in the page address. Opening or reloading submits nothing.
 * Stable deep links: `#check`, `#preview`, `#outcome`, and `?plan=<id>` for one plan's outcome.
 */
export function TreasuryRun() {
  const run = useRunChecks();
  const { followed, followPlan, stopFollowing, refreshResult } = useFollowedPlan();
  return <section aria-label="Guided Treasury run" className="flex min-w-0 flex-col gap-6">
    <div className="flex flex-col gap-3">
      <h1 className="font-heading text-2xl font-semibold">Run it with your treasury</h1>
      <div className="flex flex-wrap items-center gap-3"><Badge tone="warning">Real actions · mainnet</Badge><p className="text-sm">You choose and confirm each action.</p></div>
      <p className="max-w-prose text-sm text-muted-foreground">Each step uses this agent’s real controls. Steps mark nothing complete; your wallet or the DAO’s voting flow authorizes each exact prepared request.</p>
    </div>
    <nav aria-label="Owner reviews" className="flex flex-wrap gap-3">
      <Button asChild variant="outline"><Link to="/automations">Review strategy and grant</Link></Button>
      <Button asChild variant="outline"><Link to="/policy">Review policy and owner signing</Link></Button>
      <Button asChild variant="outline"><Link to="/activity" hash="owner-actions">Follow owner signatures and proposals</Link></Button>
    </nav>
    <ol className="flex min-w-0 flex-col gap-8">
      <RunStep id="check" number={1} title="Check this agent"><AgentChecks run={run} open /></RunStep>
      <RunStep id="preview" number={2} title="Preview and execute a rebalance">
        <Link to="/automations" className="self-start text-sm underline">Review the allocation and strategy limits</Link>
        <Rebalance disabledReason={run.firstBlocker?.detail} onExecute={followPlan} onResult={refreshResult} onRefused={stopFollowing} />
      </RunStep>
      <RunStep id="outcome" number={3} title="Check the outcome">
        {followed ? <PlanOutcome key={followed.planId} selected={followed} onStop={stopFollowing} />
          : <p className="max-w-prose text-sm text-muted-foreground">No plan selected. Confirming execution selects that plan’s recorded operations here and keeps it in the page address; opening or reloading this page submits nothing.</p>}
        <p className="max-w-prose text-sm text-muted-foreground">An unresolved outcome needs review before another send. This run does not mark a plan complete.</p>
        {!followed && <Link to="/activity" className="inline-flex min-h-11 items-center self-start text-sm underline">Review all operations and recovery</Link>}
      </RunStep>
    </ol>
  </section>;
}
