import { accessDenied, ReadFailure } from "../../shared/read-failure";
import { TREASURY_ONLY } from "../../treasury-surface";
import { OwnerActions } from "../owner/owner-actions";
import { DownloadSimple } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ago, amountOf, client, describeRequest, kindOf, type Overview, queries, swaps, useAttempt } from "../../shared/lib";
import { blockedBy } from "../../shared/send-block";
import { useNameOf } from "../../shared/names";
import { useCanCall } from "../../app/viewer";
import { refusalText } from "../../shared/words";
import { useAgent } from "../../app/agent-context";
import { Badge, Button, Card, CopyButton, Details, ErrorBox, Loading, QueryError, Section, Spinner, StatusBadge, statusTone } from "../../shared/ui";
import type { QuerySource } from "../../shared/query-source";
import { BASE } from "../../shared/client";

/** Preserve scoped recovery URLs while returning history browsing to the workspace. */
export function ActivityReturn() {
  return BASE && !TREASURY_ONLY ? <a href="/#activity" className="inline-flex min-h-11 items-center self-start text-sm underline">Back to Activity</a> : null;
}

type OperationCheck = Awaited<ReturnType<typeof client.recover>>[number];

/** A status read describes existing work; it never establishes that a replacement is safe. */
function OperationCheckResult({ check, replacement }: { check: OperationCheck; replacement: string }) {
  const label = check.outcome === "unknown" ? "Outcome still unknown"
    : check.outcome === "refused" ? "Refusal recorded"
      : check.outcome === "open" ? "Operation still open" : "Provider outcome reported";
  const next = check.outcome === "unknown" ? `Review the provider record before creating a replacement ${replacement}.`
    : check.outcome === "refused" ? "This operation was refused before submission. Review the refusal before preparing a new action."
      : check.status === "FAILED" ? `A failed status alone does not establish that a replacement ${replacement} is safe. Review the provider record.`
        : check.status === "PENDING_APPROVAL" ? "Held for owner approval. Review the held payout and its owner decision."
          : check.status === "PREPARED" ? "No submission was attempted. Review the original invoice to continue."
            : check.outcome === "open" ? "The operation is still open. Check its outcome again later."
              : check.status === "REFUNDED" ? "The provider reports a refund. Review the operation record for details."
                : check.status === "SUCCESS" ? "The provider reports that this operation succeeded." : "Review the reported outcome in the operation record.";
  return <li className="flex min-w-0 flex-col gap-2 py-4 first:pt-0 last:pb-0">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-medium">{label}</p>
      {check.status && (check.outcome === "unknown" ? <Badge>Last recorded: {check.status.toLowerCase()}</Badge> : <StatusBadge status={check.status} />)}
    </div>
    <p className="text-muted-foreground">{next}</p>
    <Details summary="Outcome details">
      <span className="flex flex-wrap items-center gap-2"><span className="break-all font-mono text-xs">{check.key}</span><CopyButton text={check.key} /></span>
      {check.detail && <p className="break-words">{check.detail}</p>}
    </Details>
  </li>;
}

/** Why new sends are blocked, what stays safe and what comes next. Resolution is never offered here. */
function BlockedSummary({ operations }: { operations: Awaited<ReturnType<typeof client.unresolved>> }) {
  const one = operations.length === 1, them = one ? "it" : "them";
  const attempted = operations.filter(op => !op.sent && op.status !== "PREPARED").length;
  return <div className="flex flex-col gap-2 text-sm">
    <p role="status" className="font-medium text-warning-muted-foreground">{blockedBy(operations.length)}</p>
    {attempted > 0 && <p>{one ? "Its submission was attempted and no provider reference was returned, so whether it executed is unknown."
      : `${attempted} ${attempted === 1 ? "was" : "were"} attempted with no provider reference returned, so whether ${attempted === 1 ? "it" : "they"} executed is unknown.`}</p>}
    <p>Safe now: reading balances and records, previewing, and checking outcomes, which reads only and retries nothing.</p>
    <p>Resolving {them} is a separate step that needs the owner’s authorization. This page cannot clear, retry or replay {them}.</p>
  </div>;
}

/**
 * Money actions without a proven outcome. Each blocks every new one, so the agent waits until they
 * are resolved. Recovery only reads statuses; ambiguous replay is blocked.
 */
export function Unresolved() {
  const canRecover = useCanCall("recover");
  const { data: overview } = useAgent();
  const unresolved = useQuery(queries.unresolved);
  const data = accessDenied(unresolved.error) ? [] : unresolved.data ?? [];
  // Treasury operations are swaps and shields; Payables keeps its payment wording.
  const replacement = kindOf(overview) === "treasury" ? "operation" : "payment";
  const { busy, message, error, attempt } = useAttempt();
  const [checks, setChecks] = useState<Awaited<ReturnType<typeof client.recover>>>([]);
  // A failed read can't show that nothing is unresolved: say so instead of hiding the section.
  if (unresolved.error)
    return (
      <Section title="Unresolved operations" description="New sends are blocked while these outcomes remain unknown.">
        <ReadFailure label="Unresolved operations" error={unresolved.error} retry={() => unresolved.refetch()} retained={unresolved.data !== undefined} updatedAt={unresolved.dataUpdatedAt} />
        {data.length > 0 && <ul className="space-y-2 text-sm">{data.map(op => <li key={op.key} className="break-all">{op.kind} · {op.status ?? "outcome unknown"} · {op.key}</li>)}</ul>}
        <p className="text-sm">Refresh these records before checking operation outcomes. Missing current evidence does not make a replacement {replacement} safe.</p>
      </Section>
    );
  if (unresolved.isPending) return <Section title="Unresolved operations"><Loading label="Checking unresolved operations…" /></Section>;
  if (data.length === 0 && !message && !error) return null;

  const run = () =>
    attempt(async () => {
      const results = await client.recover();
      setChecks(results);
      return results.length ? `Checked ${results.length} operation${results.length === 1 ? "" : "s"}. Review the reported outcomes below.` : "No open operations were returned by this check.";
    });

  return (
    <Section title="Unresolved operations">
      <Card>
        {data.length > 0 && <BlockedSummary operations={data} />}
        <ul className="flex flex-col divide-y">
          {data.map((op) => (
            <li key={op.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm first:pt-0 last:pb-0">
              <span className="whitespace-nowrap text-muted-foreground sm:w-32">{ago(op.at)}</span>
              <span className="w-20 font-medium capitalize">{op.kind}</span>
              <span className="flex-1" />
              <Badge tone="warning">{op.sent ? (op.status?.toLowerCase() ?? "sent") : op.status === "PREPARED" ? "prepared, never submitted" : "submission outcome unknown"}</Badge>
              <Details summary="Idempotency key" className="basis-full">
                <span className="break-all font-mono text-xs text-muted-foreground">{op.key}</span>
              </Details>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-end gap-3 pt-4">
          <span role="status" aria-atomic="true" className="mr-auto text-sm text-muted-foreground">
            {busy ? "Checking operation outcomes…" : message ? `Status check complete: ${message}` : ""}
          </span>
          <Button variant="outline" size="sm" disabled={busy || !canRecover} onClick={() => run()}>
            {busy && <Spinner />} Check operation outcomes
          </Button>
        </div>
        {data.length > 0 && <div className="flex flex-col gap-2 text-sm">
          <p>{canRecover ? "" : "Your account cannot check these operations. Ask someone with execution or management permission. "}These references contain private agent information.</p>
          <div><CopyButton text={JSON.stringify({ agent: overview.agentId, unresolved: data.map(({ key, status, at }) => ({ key, status, at })) }, null, 2)} /> Copy review references</div>
        </div>}
        {checks.length > 0 && <div className="flex flex-col gap-3 text-sm"><h3 className="font-medium">Last outcome check</h3><ul aria-label="Operation status results" className="divide-y">{checks.map(check => <OperationCheckResult key={check.key} check={check} replacement={replacement} />)}</ul></div>}
        <Details summary="When an outcome stays unknown">
          <p className="text-muted-foreground">A missing operation ID does not prove that nothing was sent. Investigate the original operation; this check does not retry it.</p>
        </Details>
        <ErrorBox error={error} />
      </Card>
    </Section>
  );
}

/**
 * A probe sent on purpose to show the policy refusing it; older logs call it `verify-refusal` or
 * `probe`. The live probes are retired, so these rows are history: kept,
 * and listed apart from what the agent did.
 */
const PROBE_KINDS = new Set(["refusal", "verify-refusal", "probe"]);
export const isProbe = (op: { kind: string }) => PROBE_KINDS.has(op.kind);

type ActivityRow = Awaited<ReturnType<typeof client.activity>>[number];

export function Row({ op, book, nameOf, idPrefix = "", showRefusalCode = false }: { op: ActivityRow; book: Overview["book"]; nameOf: (account: string) => string; idPrefix?: string; showRefusalCode?: boolean }) {
  const probe = isProbe(op);
  return (
    <li id={op.correlationId ? `${idPrefix}operation-${op.correlationId}` : undefined} className="scroll-mt-48 flex flex-wrap items-center gap-x-4 gap-y-1 border-b py-3 text-sm last:border-0">
      <span className="whitespace-nowrap text-muted-foreground sm:w-32">{ago(op.at)}</span>
      <span className="w-20 font-medium capitalize">{probe ? "Policy test" : op.kind}</span>
      <span className="order-last basis-full tabular-nums sm:order-none sm:basis-0 sm:flex-1">{describeRequest(op.request, book, nameOf)}</span>
      <span className="ml-auto">
        {op.refused ? (
          // A probe exists to be refused; any other refusal means the policy stopped the agent.
          // A probe refused for want of funds never reached the policy: it proves nothing.
          <Badge tone={!probe ? "warning" : op.refused === "insufficient_balance" ? "neutral" : "success"}>
            <span title={op.refused}>refused · {refusalText(op.refused)}</span>
          </Badge>
        ) : probe ? (
          <Badge tone="destructive">passed · {op.status?.toLowerCase() ?? "unsettled"}</Badge>
        ) : (
          <Badge tone={statusTone(op.status)}>{op.status?.toLowerCase() ?? "unsettled"}</Badge>
        )}
      </span>
      {op.correlationId && (
        <Details summary="Operation reference" className="order-last basis-full">
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-xs text-muted-foreground">{op.correlationId}</span>
            <CopyButton text={op.correlationId} />
          </span>
        </Details>
      )}
      {op.policyDigest && (
        <Details summary={`Recorded policy revision ${op.policyRevision ?? "–"}`} className="order-last basis-full">
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-xs text-muted-foreground">{op.policyDigest}</span>
            <CopyButton text={op.policyDigest} />
          </span>
          {op.planId && <span className="font-mono text-xs text-muted-foreground">plan {op.planId}</span>}
        </Details>
      )}
      {showRefusalCode && op.refused && <p className="order-last basis-full break-all text-xs text-muted-foreground">Refusal code: <code>{op.refused}</code></p>}
    </li>
  );
}

/** Recorded operations, including refusals; `limit` shows the latest few with a link to the rest. */
export function Activity({ limit, planId }: { limit?: number; planId?: string }) {
  const { data: overview } = useAgent();
  const nameOf = useNameOf();
  return <ActivityRecords limit={limit} planId={planId} overview={overview} nameOf={nameOf} />;
}

/** Local records remain reviewable without inventing balances or policy observations. */
export function RecoveryActivity() {
  const unresolved = useQuery({ ...queries.unresolved, retry: false });
  return <>
    <ActivityReturn />
    <p role="status" className="text-sm">Retained records remain available. Current provider outcomes are not confirmed here.</p>
    <Section title="Unresolved operations" description="Recorded operations without a proven outcome. New sends remain blocked while they are unresolved.">
      {unresolved.isPending && <Loading label="Checking unresolved records…" />}
      {unresolved.error && <ReadFailure label="Unresolved operations" error={unresolved.error} retry={() => unresolved.refetch()} retained={unresolved.data !== undefined} updatedAt={unresolved.dataUpdatedAt} />}
      {unresolved.isSuccess && !unresolved.data.length && <p>No unresolved operations are recorded on this instance.</p>}
      {(accessDenied(unresolved.error) ? [] : unresolved.data ?? []).map(op => <p key={op.key} className="break-all text-sm">{op.kind} · {op.status ?? "outcome unknown"} · <span className="font-mono">{op.key}</span></p>)}
    </Section>
    <ActivityRecords />
  </>;
}

function ActivityRecords({ limit, planId, overview, nameOf = (account: string) => account }: {
  limit?: number; planId?: string; overview?: Overview; nameOf?: (account: string) => string;
}) {
  const activity = useQuery({ ...queries.activity, retry: false });
  const data = accessDenied(activity.error) ? [] : activity.data ?? [];
  const hash = useLocation({ select: (location) => location.hash });
  // The query may finish after router navigation; scroll only once its target row exists.
  useEffect(() => {
    if (!limit && hash.startsWith("operation-") && activity.data) document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, [hash, activity.data, limit]);
  const actions = data.filter((op) => !isProbe(op) && (planId === undefined || op.planId === planId));
  const probes = data.filter(isProbe);

  return (
    <>
    {!limit && planId === undefined && <div id="owner-actions" className="scroll-mt-24"><OwnerActions /></div>}
    <Section
      title={planId !== undefined ? "This plan’s operations" : limit ? "Recent activity" : "Operation history"}
      description={planId !== undefined ? "Retained operations linked to this exact plan, including its shields and refusals." : "Operations recorded on this instance, including refusals, newest first."}
      action={
        limit &&
        actions.length > limit && (
          <Link to="/activity" className="text-sm text-muted-foreground hover:text-foreground">
            View all {actions.length}
          </Link>
        )
      }
    >
      {activity.error && <ReadFailure label="Activity" error={activity.error} retry={() => activity.refetch()} retained={activity.data !== undefined} updatedAt={activity.dataUpdatedAt} />}
      {activity.isPending && <Loading label="Loading activity…" />}
      {!activity.error && activity.data && actions.length === 0 && (
        <p className="text-sm text-muted-foreground">{planId !== undefined
          ? "No operations for this plan are recorded here yet. This does not establish that nothing was sent; review Activity if execution was interrupted."
          : <>No actions recorded on this instance.{overview && swaps(overview) && " Preview a rebalance to get started."}</>}</p>
      )}
      {actions.length > 0 && (
        <ol className="flex flex-col">
          {actions.slice(0, limit).map((op) => (
            <Row key={`${op.at}-${op.kind}`} op={op} book={overview?.book ?? []} nameOf={nameOf} />
          ))}
        </ol>
      )}
      {!limit && planId === undefined && probes.length > 0 && (
        <Details summary={`Earlier policy tests (${probes.length}): requests sent to be refused, from retired probes`}>
          <ol className="flex flex-col">
            {probes.map((op) => (
              <Row key={`${op.at}-${op.kind}`} op={op} book={overview?.book ?? []} nameOf={nameOf} />
            ))}
          </ol>
        </Details>
      )}
    </Section>
    </>
  );
}

/** Saves the ledger the server builds (src/ledger.ts) as a CSV file. */
export async function downloadLedger(api: QuerySource = client, name = "ledger", signal?: AbortSignal) {
  const csv = await api.ledgerCsv(undefined, { signal });
  // A response already in flight may arrive after its agent's access has been revoked.
  signal?.throwIfAborted();
  const link = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
    download: `${name}-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * Public balances against indexed chain transfers, confidential balances against API executions.
 * A difference is unexplained: it can reflect outside credits or incomplete records.
 */
export function BooksDisclosure() {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)} className="text-sm">
    <summary className="cursor-pointer text-muted-foreground">Compare balances with records</summary>
    {open && <div className="mt-4"><Books /></div>}
  </details>;
}

export function Books() {
  const { data } = useAgent();
  const books = useQuery({ ...queries.books });

  return (
    <Section
      title="Books"
      description="Public balances checked against the chain, confidential ones against the API's recorded executions."
    >
      {books.error ? (
        <QueryError error={books.error} retry={() => books.refetch()} />
      ) : !books.data ? (
        <Loading label="Reconciling the books…" />
      ) : <BooksTable rows={books.data} book={data.book} onExport={() => downloadLedger()} />}
    </Section>
  );
}

/** Read-only comparison display shared by scoped area and workspace queries. */
export function BooksTable({ rows, book, onExport }: {
  rows: Awaited<ReturnType<QuerySource["reconcileBooks"]>>; book: Overview["book"]; onExport: () => void;
}) {
  const value = (raw: string, asset: string) => amountOf(raw, asset, book);
  return <Card>
          <ul className="flex flex-col divide-y text-sm">
            {rows.map((r) => (
              <li key={r.asset} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <span className="font-medium">{r.symbol}</span>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground">Public {value(r.public.api, r.asset)}</span>
                  <Badge tone={r.public.drift === "0" ? "success" : "destructive"}>
                    {r.public.drift === "0" ? "matches the chain" : `differs from the chain by ${value(r.public.drift, r.asset)}`}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground">Confidential {value(r.confidential.api, r.asset)}</span>
                  <Badge tone={r.confidential.unattributed === "0" ? "success" : "warning"}>
                    {r.confidential.unattributed === "0"
                      ? "matches recorded executions"
                      : `${value(r.confidential.unattributed, r.asset)} unexplained difference`}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
          <Details summary="Export" className="border-t pt-3">
            <div>
              <Button variant="outline" size="sm" onClick={onExport}>
                <DownloadSimple size={16} /> Ledger CSV
              </Button>
            </div>
          </Details>
        </Card>;
}
