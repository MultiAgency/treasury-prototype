import { TREASURY_ONLY } from "../../treasury-surface";
import { TaskEvidence } from "../evidence/task-evidence";
import { ConfirmButton } from "../owner/confirm-button";
import { SCHEDULE_STOPPED, SCHEDULE_STOP_SCOPE } from "../../shared/schedule-copy";
import { queries } from "../../shared/queries";
import { ArrowRight, ArrowsLeftRight, CheckCircle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useLocation } from "@tanstack/react-router";

import { StrategyWorkflow } from "./strategy-workflow";
import { OutcomeError, refusedBeforeSending } from "../../shared/outcome-error";
import { useSendBlock } from "../../shared/send-block";
import { amount, client, kindOf, swaps, useAttempt, useRun, usd } from "../../shared/lib";
import { useCanCall } from "../../app/viewer";
import { useAgent } from "../../app/agent-context";
import { Badge, Button, Card, CardHeader, Details, Dot, Empty, ErrorBox, Loading, QueryError, Note, NotExecuted, Section, Spinner, StatusBadge, statusTone } from "../../shared/ui";

export function Rebalance({ disabledReason, onExecute, onResult, onRefused }: { disabledReason?: string; onExecute?: (planId: string) => void; onResult?: () => void; onRefused?: () => void }) {
  const canPreview = useCanCall("rebalance");
  const canExecute = useCanCall("executePlan");
  const executor = useAgent().setup.executor !== false;
  const hasGrant = Boolean(useAgent().setup.grant);
  const { data } = useAgent();
  const split = data.book.map((h) => `${Math.round((data.target[h.asset] ?? 0) * 100)}% ${h.symbol}`).join(" / ");
  const preview = useRun(client.rebalance, []);
  const execution = useRun(client.executePlan);
  const lastResult = execution.events.at(-1);
  useEffect(() => { if (lastResult) onResult?.(); }, [lastResult, onResult]);
  // Refused before anything was sent: no confirmed plan remains to follow.
  const refused = execution.state === "error" && refusedBeforeSending(execution.kind) && execution.events.length === 0;
  useEffect(() => { if (refused) onRefused?.(); }, [refused, onRefused]);
  const sendBlock = useSendBlock();
  const busy = preview.state === "running" || execution.state === "running";
  const plan = preview.events.find((e) => e.type === "plan");
  const saved = preview.events.find((e) => e.type === "saved");
  const executed = !!saved && execution.input?.planId === saved.plan.id && execution.state !== "idle";
  const rejected = execution.events.find((e) => e.type === "rejected");
  const blocked = Boolean(disabledReason) || !executor || !hasGrant;
  const blockReason = disabledReason ?? (!executor ? "Preview and execution are available on this treasury’s executor."
    : !hasGrant ? "Authorize the saved strategy before previewing a rebalance."
      : !canPreview ? "Your account does not have permission to prepare a rebalance." : undefined);

  return (
    <Card className="lg:col-span-2 lg:row-span-2">
      <CardHeader
        icon={<ArrowsLeftRight size={20} weight="bold" />}
        title="Rebalance"
        description={`Swap toward ${split}. Swaps below ${usd(data.rebalance.minLegUsd)} or above the ${data.rebalance.maxCostBps / 100}% cost limit are skipped.`}
      />

      <div className="flex min-h-40 flex-1 flex-col gap-3">
        {!plan && preview.state === "idle" && (
          <Empty icon={<ArrowsLeftRight size={24} />}>
            Preview the swaps and their estimated costs. Execute only after reviewing the saved plan.
          </Empty>
        )}
        {!plan && preview.state === "running" && <Empty icon={<Spinner />}>Checking balances…</Empty>}
        {plan && plan.legs.length === 0 && (
          <Empty icon={<CheckCircle size={24} className="text-success" />}>
            No swaps are needed at the current targets and minimum swap size.
          </Empty>
        )}
        {plan?.legs.map((leg, i) => {
          const quote = preview.events.find((e) => e.type === "quote" && e.leg === i);
          const step = saved?.steps[i];
          const done = execution.events.find((e) => e.type === "action" && e.index === step);
          return (
            <div key={`${leg.from.asset}-${leg.to.asset}`} className="flex flex-col gap-3 rounded-xl bg-muted/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 font-medium">
                  <Dot symbol={leg.from.symbol} />
                  {amount(leg.amount, leg.from)}
                  <ArrowRight size={14} className="text-muted-foreground" />
                  <Dot symbol={leg.to.symbol} />
                  {leg.to.symbol}
                </div>
                <span className="text-sm text-muted-foreground tabular-nums">≈ {usd(leg.usd)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {!quote && preview.state === "running" && (
                  <span className="inline-flex items-center gap-2 text-muted-foreground">
                    <Spinner /> Quoting…
                  </span>
                )}
                {quote?.type === "quote" && (
                  <>
                    <span className="text-muted-foreground">
                      Estimated received {amount(quote.amountOut, leg.to)} · Minimum received {amount(quote.minAmountOut, leg.to)}
                    </span>
                    <span className="text-muted-foreground">
                      Estimated cost {quote.costBps / 100}% · Maximum cost {quote.worstCostBps / 100}%
                    </span>
                    {quote.skipped && <Badge tone="warning">Skipped: cost limit exceeded</Badge>}
                  </>
                )}
                {done?.type === "action" && done.shield && (
                  <Badge tone={statusTone(done.shield.status)}>Shield {amount(done.shield.amount, leg.from)}</Badge>
                )}
                {done?.type === "action" && (
                  <StatusBadge status={done.status} failureCode={done.failureCode}>
                    Swap{" "}
                  </StatusBadge>
                )}
                {done?.type === "action" && done.correlationId && (
                  <Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to="/activity" hash={`operation-${done.correlationId}`}>Follow this swap</Link></Button>
                )}
                {step !== undefined && !done && execution.state === "running" && <Spinner />}
              </div>
            </div>
          );
        })}
        {rejected?.type === "rejected" && <NotExecuted problems={rejected.problems} again="Preview" />}
        <OutcomeError error={preview.error ?? execution.error} kind={preview.error ? preview.kind : execution.kind} />
        {blockReason && <p className="text-sm text-muted-foreground">{blockReason} {!hasGrant && executor && <Link to="/automations" className="underline">Review strategy authorization</Link>}</p>}
        {!blockReason && sendBlock && <p className="text-sm text-muted-foreground">{sendBlock}</p>}
        {(executed || execution.error) && <Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to="/activity">Review operation outcomes before another preview</Link></Button>}
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {saved
            ? `Valid until ${new Date(saved.plan.expiresAt).toLocaleTimeString()} · budget remaining ${usd(plan?.budget)}`
            : plan && plan.legs.length > 0 && preview.state === "done"
              ? "No swaps meet the cost limit. Nothing to execute."
              : plan && `Budget remaining ${usd(plan.budget)}`}
        </span>
        <div className="flex gap-3">
          <Button variant="outline" disabled={busy || blocked || !canPreview} onClick={() => { if (!busy && !blocked && canPreview) void preview.run(undefined); }}>
            {preview.state === "running" ? <Spinner /> : null}
            Preview
          </Button>
          <ConfirmButton
            path="executePlan"
            label={execution.state === "running" ? <><Spinner /> Executing</> : "Execute"}
            disabled={busy || !saved || executed || blocked || Boolean(sendBlock)}
            title="Execute the previewed rebalance on mainnet?"
            description="Runs the previewed swaps under the agent's grant, each requiring at least the minimum received shown. Swaps run in sequence with checks before each action. If execution stops, earlier completed actions remain."
            confirm="Execute swaps"
            reviewKey={saved?.plan.id}
            summary={saved && plan && <section aria-label="Saved plan summary" className="flex min-w-0 flex-col gap-3 border-t pt-4 text-sm">
              <h4 className="font-medium">Swaps in this saved plan</h4>
              <ul className="flex flex-col gap-3">{plan.legs.map((leg, i) => {
                if (saved.steps[i] === undefined) return null;
                const quote = preview.events.find(e => e.type === "quote" && e.leg === i);
                return <li key={i} className="flex flex-col gap-1">
                  <p className="font-medium">{amount(leg.amount, leg.from)} → {leg.to.symbol}</p>
                  {quote?.type === "quote" && <>
                    <p>Estimated received {amount(quote.amountOut, leg.to)}</p>
                    <p>Minimum received {amount(quote.minAmountOut, leg.to)}</p>
                    <p className="text-muted-foreground">Estimated cost {quote.costBps / 100}% · Maximum cost {quote.worstCostBps / 100}%</p>
                  </>}
                </li>;
              })}</ul>
              <p>Valid until <time dateTime={saved.plan.expiresAt}>{new Date(saved.plan.expiresAt).toLocaleString()}</time></p>
            </section>}
            onConfirm={() => {
              if (saved && !busy && !executed && !blocked && !sendBlock && canExecute) {
                // Selection follows explicit confirmation; it never establishes an operation outcome.
                onExecute?.(saved.plan.id);
                void execution.run({ planId: saved.plan.id });
              }
            }}
          />
        </div>
      </div>
    </Card>
  );
}

/** Existing Payables schedules can be stopped without offering Treasury configuration. */
export function PayablesSchedule() {
  const canStop = useCanCall("autopilot/stop");
  const executor = useAgent().setup.executor !== false;
  const status = useQuery({ ...queries.autopilot, retry: false });
  const { busy, error, message, attempt } = useAttempt();
  if (status.error) return <QueryError error={status.error} retry={() => status.refetch()} />;
  if (status.isPending) return <Loading label="Checking for an existing schedule…" />;
  if (!status.data.on && !message) return null;
  return <Card>
    {status.data.on && <><p>An existing schedule is on. Portfolio strategy configuration is not available for Payables.</p><p>{SCHEDULE_STOP_SCOPE}</p>
      <Button variant="outline" disabled={busy || !canStop || !executor} onClick={() => attempt(async () => {
        await client.autopilot.stop();
        return SCHEDULE_STOPPED;
      })}>Turn off</Button></>}
    {message && <p role="status">{message}</p>}
    <ErrorBox error={error} />
  </Card>;
}

/** The fixed strategies, each run on demand, and the autopilot that runs them unattended. */
export function Automations() {
  const executor = useAgent().setup.executor !== false;
  const hasGrant = Boolean(useAgent().setup.grant);
  const { data } = useAgent();
  const treasury = kindOf(data) === "treasury";
  const hash = useLocation({ select: location => location.hash });
  return (
    <Section title={treasury ? "Strategy" : "Shield public funds"} description={treasury ? "Configure, authorize and schedule the strategy." : "Preview a sweep to shield public balances."}>
      {treasury && TREASURY_ONLY && <Button asChild variant="outline" className="self-start"><Link to="/" hash="rebalance">Preview a manual rebalance on the overview</Link></Button>}
      {treasury && !TREASURY_ONLY && <TaskEvidence task="strategy" />}
      {!treasury && <Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to="/policy" hash="grants">Review or renew the grant</Link></Button>}
      {!executor && <Note>Preview, execution and automation settings are available on the executor with the corresponding account permissions.</Note>}
      {!hasGrant && <Note>A grant is required for new automation actions. <Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to="/policy" hash="grants">Review grants and permissions</Link></Button>.</Note>}
      {treasury ? <StrategyWorkflow /> : <PayablesSchedule />}
      {treasury && !swaps(data) && <Note>The current policy does not allow swaps. Rebalance previews are unavailable; recorded runs and strategy settings remain accessible.</Note>}
      {treasury && <Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to="/follow/run">Run autopilot once or review recorded runs →</Link></Button>}
      {!TREASURY_ONLY && <Section title="Manual actions" description="Preview a saved rebalance before choosing whether to execute it.">
        {swaps(data) && <div id="rebalance" className="scroll-mt-48 lg:col-span-2"><Details summary="Preview a rebalance" open={hash === "rebalance"}><Rebalance /></Details></div>}
        <div id="sweep" className="scroll-mt-48 text-sm"><Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to="/funding" hash="sweep">Shield public funds in Balances &amp; funding</Link></Button></div>
      </Section>}
    </Section>
  );
}
