import { useQuery } from "@tanstack/react-query";
import { useCanCall } from "../../app/viewer";
import { queries } from "../../shared/queries";
import { client, useAttempt } from "../../shared/lib";
import { Button, Details, ErrorBox, QueryError } from "../../shared/ui";
import { PROTOTYPES } from "../evidence/beats";
import { WhatThisShows } from "../evidence/showcase";
import { SCHEDULE_STOP_SCOPE, SCHEDULE_STOPPED } from "../../shared/schedule-copy";
import { Link } from "@tanstack/react-router";
import { useAgent } from "../../app/agent-context";
import { Section } from "../../shared/ui";
import { swaps } from "../../shared/lib";
import { useValuedBook } from "../../shared/valuation";
import { Unresolved } from "../activity/activity";
import { Sweep } from "../funding/sweep";
import { Rebalance } from "./automations";
import { Allocation, Figures } from "./book";
import { TreasuryLimits } from "./treasury-limits";
import { PlanOutcome, useFollowedPlan } from "./plan-outcome";

/** Brief 02 only. Existing controls retain provider checks and explicit confirmations. */
export function TreasuryDesk() {
  const { data: raw } = useAgent();
  const data = useValuedBook(raw);
  const { followed, followPlan, stopFollowing, refreshResult } = useFollowedPlan();
  return <>
    <h1 className="text-2xl font-semibold">Treasury overview</h1>
    <Unresolved />
    <ScheduleStatus />
    <Figures data={data} />
    <Allocation data={data} />
    <TreasuryLimits />
    <section id="rebalance" aria-label="Quoted rebalance" className="scroll-mt-8">
      {swaps(data) ? <Rebalance onExecute={followPlan} onResult={refreshResult} onRefused={stopFollowing} /> : <p>The reported policy does not allow swaps. <Button asChild variant="outline"><Link to="/policy">Review policy</Link></Button>.</p>}
    </section>
    {followed && <PlanOutcome key={followed.planId} selected={followed} onStop={stopFollowing} />}
    <nav aria-label="Treasury tools" className="flex flex-wrap gap-3">
      <Button asChild variant="outline"><Link to="/automations">Set targets and schedule</Link></Button>
      <Button asChild variant="outline"><Link to="/follow/run">View treasury runs</Link></Button>
      <Button asChild variant="outline"><Link to="/funding">Balances and funding</Link></Button>
    </nav>
    <section id="sweep" aria-label="Confidential sweep" className="scroll-mt-8"><Sweep /></section>
    <Button asChild variant="outline" className="self-start"><Link to="/activity">View activity</Link></Button>
    <Section title="Known limitations">
      <ul className="flex max-w-prose flex-col gap-2 text-sm text-muted-foreground">
        {PROTOTYPES.treasury.briefs[0].limitations?.map(limitation => <li key={limitation}>{limitation}</li>)}
      </ul>
      <Details summary="Requirements and evidence"><WhatThisShows kind="treasury" openRunning /></Details>
    </Section>
  </>;
}

function ScheduleStatus() {
  const { setup } = useAgent();
  const canStop = useCanCall("autopilot/stop");
  const status = useQuery({ ...queries.autopilot, retry: false, refetchInterval: 30_000 });
  const stop = useAttempt([queries.orpc.autopilot.key(), queries.orpc.strategy.key()]);
  const known = !status.error && status.data;
  return <section aria-label="Schedule status" className="flex flex-col gap-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status">Schedule: <strong>{known ? status.data.on ? `on · every ${status.data.everyMin} minutes` : "off" : status.isPending ? "checking…" : "unavailable"}</strong></p>
      {(!known || status.data.on) && <Button variant="outline" disabled={!canStop || setup.executor !== true || stop.busy}
        onClick={() => stop.attempt(async () => { await client.autopilot.stop(); return SCHEDULE_STOPPED; })}>Turn off schedule</Button>}
    </div>
    {(!known || status.data.on) && <p className="text-muted-foreground">{SCHEDULE_STOP_SCOPE}</p>}
    {status.error && <QueryError error={status.error} retry={() => status.refetch()} />}
    <ErrorBox error={stop.error} />{stop.message && <p role="status">{stop.message}</p>}
  </section>;
}
