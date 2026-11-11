import { PROPOSAL_TOKENS, type ProposalView } from "@multiagency/sdk";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { signChallenge, signText } from "../features/owner/wallet";
import { Badge, Button, Card, ErrorBox, Loading, Note, type Tone } from "../shared/ui";
import { type AgentToken, type Answer, appApi, AppRequestError, decisionKey, decisionWasAttempted, type Consent, type PreparedConsent, type Signing, type Where } from "./app-api";

/**
 * The owner's Treasury proposals (coordination/treasury-app-move.md, stage 4): sign in, review a proposal an outside
 * agent made, sign its exact terms in the wallet, then execute it. The step flow (connect, review the full action,
 * sign, then say what happens next) follows the pattern of Trezu's wallet flow (github.com/NEAR-DevHub/trezu,
 * nt-fe/app/wallet); no code is taken from it.
 *
 * What the wallet signs is the platform's own text for the proposal, shown here verbatim, for the platform's host.
 * Nothing on this page builds or changes it, and the app server relays no other text.
 */
const STATE_TONE: Record<ProposalView["state"], Tone> = {
  proposed: "info", approved: "warning", executing: "warning", executed: "success", stopped: "destructive", unknown: "destructive",
  rejected: "neutral", withdrawn: "neutral", expired: "neutral", invalidated: "neutral",
};

/** A raw amount in the token's units, for reading; the signed text and the platform keep the raw value. */
export function amountOf(asset: string, raw: string) {
  const token = PROPOSAL_TOKENS[asset];
  if (!token) return `${raw} (raw units of ${asset})`;
  const digits = raw.padStart(token.decimals + 1, "0");
  const whole = digits.slice(0, -token.decimals || undefined), fraction = token.decimals ? digits.slice(-token.decimals).replace(/0+$/, "") : "";
  return `${BigInt(whole).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} ${token.symbol}`;
}

/** What an answer's exit code means for the owner, and what to do next: an unknown decision moves nothing. */
export function outcome(exit: number, failure?: { error?: string; code?: string }, action: "decide" | "execute" | "read" = "read") {
  if (exit === 0) return { tone: "success" as Tone, text: "Done." };
  const reason = `${failure?.error ? ` ${failure.error}` : ""}${failure?.code ? ` (${failure.code})` : ""}`;
  if (exit === 2) return { tone: "warning" as Tone, text: action === "decide" ? `Nothing was recorded.${reason}` : `Nothing was sent.${reason}` };
  if (exit === 4) return { tone: "destructive" as Tone, text: "Partly executed: at least one swap was sent and not every one succeeded. Read the operations below before anything else." };
  if (action === "decide") return { tone: "warning" as Tone, text: "No answer: your decision may have been recorded. Nothing moves at a decision. Follow this proposal with reads only." };
  return { tone: "destructive" as Tone, text: "The outcome is unknown: something may have moved, or the execution may still be running. Don't execute again; read this proposal again in a minute." };
}

const whereFromUrl = (): Where => {
  const params = new URLSearchParams(location.search);
  return { organization: params.get("organization") ?? "", agent: params.get("agent") ?? "" };
};
const setUrl = (values: Record<string, string | null>) => {
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value); else params.delete(key);
  history.pushState(null, "", `${location.pathname}?${params}`);
  dispatchEvent(new PopStateEvent("popstate"));
};
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

export function ProposalsApp() {
  const [account, setAccount] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [where, setWhere] = useState(whereFromUrl);
  const [selected, setSelected] = useState(() => new URLSearchParams(location.search).get("proposal"));
  useEffect(() => {
    const sync = () => { setWhere(whereFromUrl()); setSelected(new URLSearchParams(location.search).get("proposal")); };
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  useEffect(() => { appApi.me().then(setAccount, (e: Error) => { setAccount(null); setError(e.message); }); }, []);

  async function signIn() {
    setError(undefined);
    try { setAccount((await appApi.signIn(await signChallenge(await appApi.challenge()))).account); }
    catch (e) { setError(e instanceof Error ? e.message : "Sign-in failed"); }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Treasury proposals</h1>
        {account && <Button variant="outline" size="sm" onClick={() => void appApi.signOut().then(() => setAccount(null))}>Sign out {account}</Button>}
      </header>
      {error && <ErrorBox error={error} />}
      {account === undefined ? <Loading label="Checking your session" />
        : account === null ? (
          <Card>
            <p>Sign in with the wallet that owns the Treasury agent. Your wallet signs a sign-in text for this site only.</p>
            <Button className="self-start" onClick={() => void signIn()}>Connect wallet and sign in</Button>
          </Card>
        ) : !where.organization || !where.agent ? <Choose />
        : selected ? <Review key={`${where.organization}:${where.agent}:${selected}`} where={where} id={selected} account={account} />
        : <Connected where={where} account={account}><List where={where} /></Connected>}
    </main>
  );
}

const fromBase64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
/** A consent that lets the app relay proposals now. */
const liveTreasury = (consents: Consent[]) => consents.find(c => !c.revoked && c.expiresAt > Date.now() && c.scopes.includes("treasury"));

/**
 * The agent's connection to the app. Until the owner signs a consent covering `treasury`, no proposal can be made or
 * read through the app: the owner reviews the app's prepared text, then signs exactly that in the wallet, for the
 * platform's host. Unattended execution (`treasury-execute`) is an explicit opt-in.
 */
function Connected({ where, account, children }: { where: Where; account: string; children: React.ReactNode }) {
  const read = useCallback(() => appApi.consents(where), [where]);
  const { answer: consents, error, again } = useRead(read);
  const [execute, setExecute] = useState(false);
  const [days, setDays] = useState(30);
  const [prepared, setPrepared] = useState<PreparedConsent>();
  const [signed, setSigned] = useState<{ nonce: string; publicKey: string; signature: string }>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  async function submit(body: { nonce: string; publicKey: string; signature: string }) {
    try { await appApi.connect(body); setPrepared(undefined); setSigned(undefined); again(); }
    // No answer: the platform may have stored it. The same signature can be sent again; it is the same consent.
    catch (e) { setProblem(e instanceof AppRequestError && e.status === 503 ? `${e.message}` : e instanceof Error ? e.message : "Connecting failed."); }
  }
  async function sign() {
    if (!prepared) return;
    setBusy(true); setProblem(undefined);
    try {
      const wallet = await signText({ message: prepared.message, recipient: prepared.recipient, nonce: fromBase64(prepared.nonce), account });
      const body = { nonce: prepared.nonce, ...wallet };
      setSigned(body);
      await submit(body);
    } catch (e) { setProblem(e instanceof Error ? e.message : "Signing failed. Nothing was submitted."); }
    finally { setBusy(false); }
  }

  if (error) return <Card><ErrorBox error={`${error} Reading again is safe.`} /><Button variant="outline" className="self-start" onClick={again}>Read again</Button></Card>;
  if (!consents) return <Loading label="Reading the agent's connection" />;
  const live = liveTreasury(consents);
  if (live) return (
    <>
      <section aria-label="Connection"><p className="text-sm text-muted-foreground">Connected: {live.scopes.join(", ")} · until {new Date(live.expiresAt).toLocaleDateString()}</p></section>
      <Tokens where={where} />
      {children}
    </>
  );
  return (
    <section aria-label="Connect" className="flex flex-col gap-4">
      <Card>
        <h2 className="text-lg font-semibold">Connect {where.agent} to the Treasury app</h2>
        <p className="text-sm">Outside agents can then propose swaps here. {execute
          ? "With unattended execution, the app can also make and execute plans within your signed policy without your signature on each swap."
          : "No swap runs unless you sign that proposal's exact terms and execute it."}</p>
        {!prepared ? (
          <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); setProblem(undefined);
            appApi.prepareConnect(where, execute, days).then(setPrepared, (e: Error) => setProblem(e.message)); }}>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={execute} onChange={e => setExecute(e.target.checked)} />
              <span>Also allow unattended execution (treasury-execute): the app could then swap within your policy without your signature on each swap.</span>
            </label>
            <label className="flex flex-col gap-1 text-sm">Days the connection lasts (1 to 90)
              <input type="number" min={1} max={90} className="w-24 rounded border bg-transparent px-2 py-1" value={days} onChange={e => setDays(Number(e.target.value))} />
            </label>
            <Button type="submit" className="self-start">Review the consent</Button>
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm">Your wallet will show exactly this text, for {prepared.recipient}. Scopes: {prepared.scopes.join(", ")}.</p>
            <figure className="flex flex-col gap-1">
              <figcaption className="text-sm font-medium">Consent you sign</figcaption>
              <pre className="whitespace-pre-wrap break-all rounded border p-3 text-xs">{prepared.message}</pre>
            </figure>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => void sign()}>Sign and connect</Button>
              {signed && <Button variant="outline" disabled={busy} onClick={() => void submit(signed)}>Submit the same signature again</Button>}
              <Button variant="outline" disabled={busy} onClick={() => { setPrepared(undefined); setSigned(undefined); }}>Cancel</Button>
            </div>
          </div>
        )}
      </Card>
      {problem && <ErrorBox error={problem} />}
    </section>
  );
}

/**
 * Tokens for outside agents: each reads and/or proposes for this agent only, expires within 24 hours, and can be revoked
 * here at once. No token can execute; the owner executes approved proposals. The secret is shown once and kept nowhere.
 */
function Tokens({ where }: { where: Where }) {
  const read = useCallback(() => appApi.tokens(where), [where]);
  const { answer: tokens, error, again } = useRead(read);
  const [label, setLabel] = useState("");
  const [propose, setPropose] = useState(true);
  const [hours, setHours] = useState(1);
  const [issued, setIssued] = useState<{ token: AgentToken; secret: string }>();
  const [problem, setProblem] = useState<string>();
  const live = (tokens ?? []).filter(t => !t.revoked && t.expiresAt > Date.now());

  async function issue() {
    setProblem(undefined);
    try { setIssued(await appApi.issueToken(where, label.trim(), propose ? ["read", "propose"] : ["read"], hours * 3_600)); setLabel(""); again(); }
    catch (e) { setProblem(e instanceof Error ? e.message : "The token wasn't issued."); }
  }
  async function revoke(id: string) {
    setProblem(undefined);
    try { await appApi.revokeToken(id); if (issued?.token.id === id) setIssued(undefined); again(); }
    catch (e) { setProblem(e instanceof Error ? `${e.message} Check the list again: it may already be revoked.` : "Revoking failed."); }
  }

  return (
    <section aria-labelledby="tokens-heading" className="flex flex-col gap-3">
      <Card>
        <h2 id="tokens-heading" className="text-lg font-semibold">Agent tokens</h2>
        <p className="text-sm">A token lets one outside agent read and propose for {where.agent}. It can't execute or approve anything.</p>
        {error && <ErrorBox error={`${error} Reading again is safe.`} />}
        {live.length > 0 && (
          <ul aria-label="Live tokens" className="flex flex-col gap-1 text-sm">
            {live.map(t => (
              <li key={t.id} className="flex items-center justify-between gap-2">
                <span>{t.label} · {t.scopes.join(", ")} · until {new Date(t.expiresAt).toLocaleTimeString()}</span>
                <Button variant="outline" size="sm" onClick={() => void revoke(t.id)}>Revoke {t.label}</Button>
              </li>
            ))}
          </ul>
        )}
        {issued && (
          <figure className="flex flex-col gap-1">
            <figcaption className="text-sm font-medium">Token for {issued.token.label}: shown once. Put it in your agent's secret store, never in a prompt or file.</figcaption>
            <pre className="whitespace-pre-wrap break-all rounded border p-3 text-xs">{issued.secret}</pre>
          </figure>
        )}
        <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void issue(); }}>
          <label className="flex flex-col gap-1 text-sm">Label
            <input className="rounded border bg-transparent px-2 py-1" value={label} onChange={e => setLabel(e.target.value)} required maxLength={80} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={propose} onChange={e => setPropose(e.target.checked)} /> Can propose swaps (otherwise read only)
          </label>
          <label className="flex flex-col gap-1 text-sm">Hours it lasts (1 to 24)
            <input type="number" min={1} max={24} className="w-24 rounded border bg-transparent px-2 py-1" value={hours} onChange={e => setHours(Number(e.target.value))} />
          </label>
          <Button type="submit" variant="outline" className="self-start">Issue token</Button>
        </form>
      </Card>
      {problem && <ErrorBox error={problem} />}
    </section>
  );
}

function Choose() {
  const [values, setValues] = useState(whereFromUrl);
  return (
    <Card>
      <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); setUrl({ organization: values.organization.trim(), agent: values.agent.trim() }); }}>
        <p>Which Treasury agent? Use the Organization and agent you connected the Treasury app to.</p>
        <label className="flex flex-col gap-1 text-sm">Organization
          <input className="rounded border bg-transparent px-2 py-1" value={values.organization} onChange={e => setValues({ ...values, organization: e.target.value })} required />
        </label>
        <label className="flex flex-col gap-1 text-sm">Agent
          <input className="rounded border bg-transparent px-2 py-1" value={values.agent} onChange={e => setValues({ ...values, agent: e.target.value })} required />
        </label>
        <Button type="submit" className="self-start">Show proposals</Button>
      </form>
    </Card>
  );
}

/** Reads an answer; a failed read can be retried safely. */
function useRead<T>(read: () => Promise<T>) {
  const [answer, setAnswer] = useState<T>();
  const [error, setError] = useState<string>(), [reading, setReading] = useState(true);
  const readPending = useRef(true), revision = useRef(0);
  const again = useCallback(() => {
    const current = ++revision.current;
    readPending.current = true; setReading(true); setError(undefined);
    read().then(value => { if (current === revision.current) setAnswer(value); },
      (e: Error) => { if (current === revision.current) setError(e.message); })
      .finally(() => { if (current === revision.current) { readPending.current = false; setReading(false); } });
  }, [read]);
  useEffect(again, [again]);
  return { answer, error, again, setAnswer, reading, readPending };
}

function List({ where }: { where: Where }) {
  const read = useCallback(() => appApi.list(where), [where]);
  const { answer, error, again } = useRead(read);
  if (error) return <Card><ErrorBox error={`${error} Reading again is safe.`} /><Button variant="outline" className="self-start" onClick={again}>Read again</Button></Card>;
  if (!answer) return <Loading label="Reading proposals" />;
  if (!answer.result.ok) return <Card><Note>{outcome(answer.exit, answer.result).text}</Note></Card>;
  const proposals = answer.result.value.proposals;
  return (
    <section aria-label="Proposals" className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{where.agent} · {where.organization}</p>
      {proposals.length === 0 && <Card><p>No proposals yet. An outside agent proposes swaps with a token you issue.</p></Card>}
      {proposals.map(p => (
        <Card key={p.id}>
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">{p.legs.map(leg => `${amountOf(leg.from, leg.amount)} → ${PROPOSAL_TOKENS[leg.to]?.symbol ?? leg.to}`).join(", ")}</span>
            <Badge tone={STATE_TONE[p.state]}>{p.state}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">Valid until {new Date(p.expiresAt).toLocaleString()}</p>
          {p.note && <p className="text-sm text-muted-foreground">Proposer's note (the agent's words, not checked): {p.note}</p>}
          <Button variant="outline" size="sm" className="self-start" onClick={() => setUrl({ proposal: p.id })}>Review proposal</Button>
        </Card>
      ))}
    </section>
  );
}

function Review({ where, id, account }: { where: Where; id: string; account: string }) {
  const read = useCallback(() => appApi.read(where, id), [where, id]);
  const { answer, error, again, setAnswer, reading, readPending } = useRead(read);
  const [busy, setBusy] = useState(false);
  const storageKey = decisionKey(where, "proposal", id);
  const [decisionUnknown, setDecisionUnknown] = useState(() => decisionWasAttempted(storageKey));
  const decisionAttempt = useRef(decisionUnknown), deciding = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [last, setLast] = useState<{ exit: number; failure?: { error?: string; code?: string }; action: "decide" | "execute" }>();
  // After an unknown outcome, no button may invite the same action again until a read shows the proposal moved on.
  const [unknownAction, setUnknownAction] = useState<"decide" | "execute">();
  // The outcome region is always there, so its text is announced; after an action, focus moves to it.
  const outcomeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (last) outcomeRef.current?.focus(); }, [last]);
  const [actionError, setActionError] = useState<string>();

  async function decide(verdict: "approve" | "reject", sign: Signing) {
    if (deciding.current || readPending.current || busy || answer?.decisionHeld !== false
      || decisionAttempt.current || decisionWasAttempted(storageKey)) return;
    deciding.current = true; setBusy(true); setActionError(undefined);
    let relaying = false;
    try {
      const message = verdict === "approve" ? sign.approve : sign.reject;
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const signed = await signText({ message, recipient: sign.recipient, nonce, account });
      // Persist before the HTTP relay: even a read that began before the app claims cannot reopen signing.
      const attemptKey = `${storageKey}:${base64(nonce)}`;
      localStorage.setItem(attemptKey, "attempted"); decisionAttempt.current = true; setDecisionUnknown(true);
      relaying = true;
      const decided = await appApi.decide(where, id, verdict, { message, nonce: base64(nonce), ...signed });
      const refused = decided.exit === 2 && decided.result.ok === false && decided.decisionHeld === false;
      if (refused) {
        // Remove only this exact attempt. A delayed refusal must never erase another tab's newer hold.
        localStorage.removeItem(attemptKey);
        const stillHeld = decisionWasAttempted(storageKey); decisionAttempt.current = stillHeld; setDecisionUnknown(stillHeld);
      }
      const unresolved = decided.exit === 3 || (!decided.result.ok && !refused);
      setLast({ exit: unresolved ? 3 : decided.exit, failure: decided.result.ok ? undefined : decided.result, action: "decide" });
      if (unresolved) setUnknownAction("decide");
      again();
    } catch (e) {
      if (relaying) { setLast({ exit: 3, action: "decide" }); setUnknownAction("decide"); }
      setActionError(e instanceof Error ? e.message : "Signing failed. Nothing was relayed.");
    }
    finally { deciding.current = false; setBusy(false); }
  }
  async function execute() {
    if (busy || readPending.current || !answer?.result.ok || answer.result.value.state !== "approved") return;
    setBusy(true); setConfirming(false); setActionError(undefined);
    try {
      const ran: Answer<ProposalView> = await appApi.execute(where, id);
      setLast({ exit: ran.exit, failure: ran.result.ok ? undefined : ran.result, action: "execute" });
      if (ran.exit === 3) setUnknownAction("execute");
      if (ran.result.ok) setAnswer(current => current && { ...current, result: ran.result });
    } catch (e) {
      // No answer to an execution: it may have run, or may still be running. Read, never press Execute again.
      setLast({ exit: 3, action: "execute" });
      setUnknownAction("execute");
      setActionError(e instanceof AppRequestError ? e.message : "No answer.");
    } finally { setBusy(false); }
  }

  if (error) return <Card><ErrorBox error={`${error} Reading again is safe.`} /><Button variant="outline" className="self-start" onClick={again}>Read again</Button></Card>;
  if (!answer) return <Loading label="Reading the proposal" />;
  if (!answer.result.ok) return <Card><Note>{outcome(answer.exit, answer.result).text}</Note></Card>;
  const p = answer.result.value, sign = answer.sign;
  const result = last && outcome(last.exit, last.failure, last.action);
  // A proposed read cannot rule out an approval still in flight. Only this attempt's definite refusal releases its local hold.
  const signingHeld = decisionUnknown || answer.decisionHeld !== false;
  const held = unknownAction === "execute" && p.state === "approved";
  return (
    <section aria-label="Proposal" className="flex flex-col gap-4">
      <Button variant="outline" size="sm" className="self-start" onClick={() => setUrl({ proposal: null })}>All proposals</Button>
      <Card>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Proposal</h2>
          <Badge tone={STATE_TONE[p.state]}>{p.state}</Badge>
        </div>
        <ol aria-label="Swaps" className="flex flex-col gap-2">
          {p.legs.map((leg, i) => (
            <li key={i} className="rounded border p-3 text-sm">
              <p className="font-medium">{i + 1}. Swap {amountOf(leg.from, leg.amount)} for at least {amountOf(leg.to, leg.minAmountOut)}</p>
              {p.quoted[i] && <p className="text-muted-foreground">Quoted when proposed: {amountOf(leg.to, p.quoted[i]!.amountOut)}, cost {p.quoted[i]!.costBps / 100}%</p>}
            </li>
          ))}
        </ol>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Valid until</dt><dd>{new Date(p.expiresAt).toLocaleString()}</dd>
          <dt className="text-muted-foreground">Proposed by</dt><dd>{p.deployment} for {p.organization}</dd>
          {p.note && <><dt className="text-muted-foreground">Proposer's note</dt><dd>{p.note}</dd></>}
        </dl>
        {p.state === "proposed" && sign && !signingHeld && (
          <div className="flex flex-col gap-2">
            <p className="text-sm">Your wallet will show exactly one of these texts, for {sign.recipient}. Approving sends nothing; you execute afterwards.</p>
            <figure className="flex flex-col gap-1">
              <figcaption className="text-sm font-medium">If you approve, you sign</figcaption>
              <pre className="whitespace-pre-wrap rounded border p-3 text-xs">{sign.approve}</pre>
            </figure>
            <figure className="flex flex-col gap-1">
              <figcaption className="text-sm font-medium">If you reject, you sign</figcaption>
              <pre className="whitespace-pre-wrap rounded border p-3 text-xs">{sign.reject}</pre>
            </figure>
            <div className="flex gap-2">
              <Button disabled={busy || reading} onClick={() => void decide("approve", sign)}>Sign and approve</Button>
              <Button variant="outline" disabled={busy || reading} onClick={() => void decide("reject", sign)}>Sign and reject</Button>
            </div>
          </div>
        )}
        {p.state === "proposed" && signingHeld && <p className="text-sm">Decision signing is closed. Continue polling this proposal; a proposed view cannot rule out an in-flight decision. If a definitive refusal reply was lost, manual review of retained decision-attempt evidence is required.</p>}
        {held && <p className="text-sm">This proposal still reads approved, but your execution got no answer and may still be running. Don't execute again; read again in a minute. The platform runs a proposal at most once.</p>}
        {p.state === "approved" && !held && (
          <div className="flex flex-col gap-2">
            <p className="text-sm">Approved. Executing re-quotes each swap and sends it only at or above your signed minimum, within your signed policy.</p>
            {!confirming ? <Button className="self-start" disabled={busy || reading} onClick={() => { if (!readPending.current) setConfirming(true); }}>Execute</Button> : (
              <div className="flex gap-2">
                <Button disabled={busy || reading} onClick={() => void execute()}>Execute on mainnet now</Button>
                <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
              </div>
            )}
          </div>
        )}
        {p.operations.length > 0 && (
          <ul aria-label="Operations" className="flex flex-col gap-1 text-sm">
            {p.operations.map((op, i) => <li key={i}>{op.method ?? "swap"}: {op.status ?? (op.refused ? `refused (${op.refused})` : "outcome unknown")}{op.correlationId ? ` · ${op.correlationId}` : ""}</li>)}
          </ul>
        )}
      </Card>
      <div ref={outcomeRef} tabIndex={-1} role="status" aria-label="Outcome" className="outline-none">{result && <Note>{result.text}</Note>}</div>
      {actionError && <ErrorBox error={actionError} />}
      {/* Reads only follow an attempted decision; they never authorize another signature. */}
      <Button variant="outline" size="sm" className="self-start" disabled={busy || reading} onClick={() => { setConfirming(false); again(); }}>Read again</Button>
    </section>
  );
}
