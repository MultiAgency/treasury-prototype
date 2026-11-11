import type { LimitOrderView } from "@multiagency/treasury-app-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { sendAsCurrentMember, signText } from "../features/owner/wallet";
import { Badge, Button, Card, ErrorBox, Loading, Note, type Tone } from "../shared/ui";
import { appApi, decisionKey, decisionWasAttempted, type Answer, type DaoOrderFiled, type DaoOrderConsentFiled, type OrderAccess, type OrderQuote, type OrderRequest, type OrderTerms, type PreparedConsent, type Signing, type Where } from "./app-api";

const inputClass = "min-h-11 rounded border bg-transparent px-3 py-2";
const keyFor = (where: Where, suffix: string) => `treasury-orders:${encodeURIComponent(where.organization)}:${where.agent}:${suffix}`;
const errorOf = (e: unknown) => e instanceof Error ? e.message : "The app did not answer. Read status before taking another action.";
const failureOf = (answer: Answer<unknown>) => answer.result.ok ? "" : `${answer.result.error ?? "The platform did not confirm this request."}${answer.result.code ? ` (${answer.result.code})` : ""}`;
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const closed = new Set(["filled", "canceled", "expired"]);
/** Completion needs the provider's final payout evidence, even if a malformed view says completed. */
export function orderStatus(view: LimitOrderView) {
  if (view.state === "completed" && !(closed.has(view.fillStatus ?? "") && view.isPayoutStatusFinal === true && view.payoutStatus === "completed")) return "unknown";
  return view.state;
}
const stateTone = (state: string): Tone => state === "completed" ? "success" : ["unknown", "payout_failed"].includes(state) ? "destructive"
  : ["resting", "partially_filled", "cancel_requested", "placing", "approved"].includes(state) ? "warning" : "neutral";
function useOrderRead<T>(read: () => Promise<T>) {
  const [answer, setAnswer] = useState<T>(), [error, setError] = useState<string>();
  const revision = useRef(0);
  const again = useCallback(() => {
    const current = ++revision.current; setError(undefined);
    read().then(value => { if (current === revision.current && value !== undefined) setAnswer(value); },
      e => { if (current === revision.current) setError(errorOf(e)); });
  }, [read]);
  useEffect(again, [again]);
  return { answer, setAnswer, error, again, setError };
}

/** Order authority is checked by our server against the current host, consent, owner and DAO roles. */
export function LimitOrders({ where, account }: { where: Where; account: string }) {
  const read = useCallback(() => appApi.orderAccess(where), [where]);
  const { answer: access, error, again } = useOrderRead(read);
  const [id, setId] = useState<string>();
  return <section aria-label="Limit orders" className="flex flex-col gap-4">
    <h2 className="text-xl font-semibold">Limit orders</h2>
    {error ? <><ErrorBox error={error} /><Button variant="outline" className="self-start" onClick={again}>Check order access</Button></>
      : !access ? <Loading label="Checking limit-order access" />
      : !access.capable ? <Note>This host does not offer limit orders.</Note>
      : !access.consented ? <OrderConsent where={where} account={account} access={access} onConnected={again} />
      : !access.mayRead ? <Note>Your current role does not allow reading this Treasury agent's orders.</Note>
      : id ? <OrderReview key={`${where.organization}:${where.agent}:${id}`} where={where} id={id} account={account} access={access} back={() => setId(undefined)} />
      : <OrderList where={where} access={access} select={setId} />}
  </section>;
}

/** This remains reachable after ordinary Treasury connection and never adds unattended execution. */
function OrderConsent({ where, account, access, onConnected }: { where: Where; account: string; access: OrderAccess; onConnected: () => void }) {
  const [prepared, setPrepared] = useState<PreparedConsent>(), [signed, setSigned] = useState<{ nonce: string; publicKey: string; signature: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  async function submit(body: { nonce: string; publicKey: string; signature: string }) {
    setBusy(true); setError(undefined);
    try { await appApi.connect(body); onConnected(); }
    catch (e) { setError(errorOf(e)); }
    finally { setBusy(false); }
  }
  async function sign() {
    if (!prepared) return;
    setBusy(true); setError(undefined);
    try {
      const wallet = await signText({ message: prepared.message, recipient: prepared.recipient, nonce: Uint8Array.from(atob(prepared.nonce), c => c.charCodeAt(0)), account });
      const body = { nonce: prepared.nonce, ...wallet }; setSigned(body); await submit(body);
    } catch (e) { setError(errorOf(e)); } finally { setBusy(false); }
  }
  return <Card>
    <h3 className="text-lg font-semibold">Allow individually signed limit orders</h3>
    <p className="text-sm">Orders need a separate consent containing treasury and treasury-orders. Treasury access and unattended execution consent alone do not permit orders. You approve each order's exact terms before one placement attempt.</p>
    {!access.mayConsent ? <Note>An owner or DAO member with proposal permission must approve a consent containing treasury and treasury-orders.</Note>
      : access.signer === "dao" ? <DaoOrderConsent where={where} account={account} access={access} onConnected={onConnected} />
      : !prepared ? <Button className="self-start" disabled={busy} onClick={() => {
        setBusy(true); setError(undefined); appApi.prepareConnect(where, false, 30, true).then(setPrepared, e => setError(errorOf(e))).finally(() => setBusy(false));
      }}>Review order consent</Button>
      : <>
        <figure aria-label="Order consent you sign"><figcaption className="text-sm font-medium">Order consent you sign · recipient {prepared.recipient}</figcaption>
          <pre className="whitespace-pre-wrap break-all rounded border p-3 text-xs">{prepared.message}</pre></figure>
        <div className="flex flex-wrap gap-2"><Button disabled={busy || !!signed} onClick={() => void sign()}>Sign order consent</Button>
          {signed && <Button variant="outline" disabled={busy} onClick={() => void submit(signed)}>Submit the same order consent signature</Button>}
        </div>
      </>}
    {error && <ErrorBox error={error} />}
  </Card>;
}

function OrderList({ where, access, select }: { where: Where; access: OrderAccess; select: (id: string) => void }) {
  const read = useCallback(() => appApi.orderList(where), [where]);
  const { answer, error, again } = useOrderRead(read);
  return <>
    <p className="text-sm text-muted-foreground">Placement funds a resting order. Fills and final payouts are followed separately.</p>
    {error && <ErrorBox error={error} />}
    <Button variant="outline" className="self-start" onClick={again}>Read orders</Button>
    {answer && !answer.result.ok && <ErrorBox error={failureOf(answer)} />}
    {answer?.result.ok && (answer.result.value.orders.length ? <ul className="flex flex-col gap-3">{answer.result.value.orders.map(order => <li key={order.id}>
      <Card><div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all">{order.order.side} {order.order.quantity} atomic {order.order.base_asset} at {order.order.price}</span>
        <Badge tone={stateTone(orderStatus(order))}>{orderStatus(order)}</Badge></div>
        <Button variant="outline" className="self-start" onClick={() => select(order.id)}>Review order {order.id.slice(0, 8)}</Button>
      </Card></li>)}</ul> : <p className="text-sm">No limit orders yet.</p>)}
    {access.mayPrepare && answer?.result.ok && (answer.result.value.orders.some(order => ["unknown", "placing"].includes(order.state) || (order.state === "approved" && localStorage.getItem(keyFor(where, `${order.id}:place`)) !== null))
      ? <Note>Resolve the uncertain order using its reads and refresh before preparing another order.</Note> : <NewOrder where={where} onCreated={select} />)}
  </>;
}

/** The saved request survives a lost HTTP reply and is the only body a retry can send. */
function NewOrder({ where, onCreated }: { where: Where; onCreated: (id: string) => void }) {
  const storageKey = keyFor(where, "draft");
  const empty = (): OrderTerms => ({ base_asset: "", quote_asset: "", side: "sell", quantity: "", price: "", deadline: new Date(Date.now() + 3_600_000).toISOString(), confidential: true });
  const [saved, setSaved] = useState<OrderRequest | undefined>(() => { try { return JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? undefined; } catch { return undefined; } });
  const [receipt, setReceipt] = useState(() => localStorage.getItem(`${storageKey}:order`));
  const [canCorrect, setCanCorrect] = useState(() => localStorage.getItem(`${storageKey}:refused`) !== null);
  const [terms, setTerms] = useState<OrderTerms>(() => saved ?? empty());
  const [quote, setQuote] = useState<OrderQuote>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key?.startsWith(storageKey)) {
      const pending = JSON.parse(localStorage.getItem(storageKey) ?? "null") as OrderRequest | null;
      setSaved(pending ?? undefined); if (pending) setTerms(pending);
      setReceipt(localStorage.getItem(`${storageKey}:order`)); setCanCorrect(localStorage.getItem(`${storageKey}:refused`) !== null);
    } };
    addEventListener("storage", sync); return () => removeEventListener("storage", sync);
  }, [storageKey]);
  const change = (values: Partial<OrderTerms>) => { setTerms(current => ({ ...current, ...values })); setQuote(undefined); };
  async function preview() {
    setBusy(true); setError(undefined);
    try { const answer = await appApi.orderQuote(where, terms); if (answer.result.ok) setQuote(answer.result.value); else setError(failureOf(answer)); }
    catch (e) { setError(errorOf(e)); } finally { setBusy(false); }
  }
  async function locked<T>(work: () => T | Promise<T>): Promise<T> {
    if (!navigator.locks) throw new Error("This browser cannot coordinate saved order requests. Open this app in a browser with Web Locks on a secure connection. Nothing was sent.");
    return navigator.locks.request(storageKey, work);
  }
  async function create() {
    setBusy(true); setError(undefined);
    try {
      // All tabs acquire the same saved body. Keep it and the receipt until an explicit next request.
      const pending = await locked(() => {
        const body = JSON.parse(localStorage.getItem(storageKey) ?? "null") as OrderRequest | null;
        const id = localStorage.getItem(`${storageKey}:order`);
        if (id) return { body: body!, id };
        const request = body ?? { ...terms, requestId: crypto.randomUUID(), expiresAt: terms.deadline };
        localStorage.setItem(storageKey, JSON.stringify(request)); return { body: request, id: null };
      });
      setSaved(pending.body); setTerms(pending.body);
      if (pending.id) { onCreated(pending.id); return; }
      const answer = await appApi.orderCreate(where, pending.body);
      if (answer.result.ok) {
        const id = answer.result.value.id;
        await locked(() => { localStorage.setItem(`${storageKey}:order`, id); localStorage.removeItem(`${storageKey}:refused`); });
        setReceipt(id); onCreated(id);
      } else {
        if (answer.exit === 2 && !["unknown", "unavailable"].includes(answer.result.kind)) {
          const code = answer.result.code ?? "refused";
          await locked(() => localStorage.setItem(`${storageKey}:refused`, code)); setCanCorrect(true);
        }
        setError(`${failureOf(answer)} Keep this saved request; a retry uses exactly these terms.`);
      }
    } catch (e) { setError(`${errorOf(e)} Keep the saved request and its exact terms for a retry.`); }
    finally { setBusy(false); }
  }
  async function another() {
    setBusy(true); setError(undefined);
    try {
      await locked(() => {
        if (!localStorage.getItem(`${storageKey}:order`) && !localStorage.getItem(`${storageKey}:refused`)) throw new Error("The existing request is still uncertain; retry only its saved terms.");
        const previous = localStorage.getItem(storageKey);
        if (previous) localStorage.setItem(`${storageKey}:archive:${JSON.parse(previous).requestId}`, previous);
        for (const key of [storageKey, `${storageKey}:order`, `${storageKey}:refused`]) localStorage.removeItem(key);
      });
      setSaved(undefined); setReceipt(null); setCanCorrect(false); setQuote(undefined); setTerms(empty());
    } catch (e) { setError(errorOf(e)); } finally { setBusy(false); }
  }
  return <Card>
    <h3 className="text-lg font-semibold">Prepare an exact order</h3>
    <p className="text-sm">Quantity is atomic base units. Price is quote units per whole base unit. Funding is confidential. Approval expires at the order deadline.</p>
    {receipt ? <><Note>The saved request returned order {receipt}. Review it before preparing another order.</Note><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => onCreated(receipt)}>Review saved order</Button><Button variant="outline" disabled={busy} onClick={() => void another()}>Prepare another order</Button></div></> : <>
    <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void preview(); }}>
      <fieldset disabled={busy || !!saved} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">Base asset<input className={inputClass} required value={terms.base_asset} onChange={e => change({ base_asset: e.target.value })} /></label>
        <label className="flex flex-col gap-1 text-sm">Quote asset<input className={inputClass} required value={terms.quote_asset} onChange={e => change({ quote_asset: e.target.value })} /></label>
        <label className="flex flex-col gap-1 text-sm">Side<select className={inputClass} value={terms.side} onChange={e => change({ side: e.target.value as "buy" | "sell" })}><option value="sell">Sell</option><option value="buy">Buy</option></select></label>
        <label className="flex flex-col gap-1 text-sm">Quantity (atomic base units)<input className={inputClass} required inputMode="numeric" pattern="[0-9]+" value={terms.quantity} onChange={e => change({ quantity: e.target.value })} /></label>
        <label className="flex flex-col gap-1 text-sm">Price (quote per base unit)<input className={inputClass} required inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" value={terms.price} onChange={e => change({ price: e.target.value })} /></label>
        <label className="flex flex-col gap-1 text-sm">Deadline (ISO UTC; more than one minute, at most seven days)<input className={inputClass} required value={terms.deadline} onChange={e => change({ deadline: e.target.value })} /></label>
        <Button type="submit" variant="outline" className="self-start">Preview exact spend</Button>
      </fieldset>
    </form>
    {quote && <div className="flex flex-col gap-2 text-sm"><p className="break-all">Gross spend: {quote.spendAmount} atomic {quote.spendAsset}. Output: {quote.outputAsset}.</p>
      {quote.warnings.length > 0 && <ErrorBox error={`Preview warnings: ${quote.warnings.join(", ")}`} />}
      <p>A preview moves no funds. The platform rechecks policy, grant and exact spend before placement.</p></div>}
    {saved && <Note>Saved request {saved.requestId}. These terms stay locked until the same request returns its order.</Note>}
    {(saved || (quote && quote.warnings.length === 0)) && <Button className="self-start" disabled={busy} onClick={() => void create()}>{saved ? "Retry the same saved order request" : "Save and create order"}</Button>}
    {canCorrect && <Button variant="outline" className="self-start" disabled={busy} onClick={() => void another()}>Correct refused terms with a new request</Button>}
    </>}
    {error && <ErrorBox error={error} />}
  </Card>;
}

function OrderReview({ where, id, account, access, back }: { where: Where; id: string; account: string; access: OrderAccess; back: () => void }) {
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(true);
  const [problem, setProblem] = useState<string>(), [notice, setNotice] = useState<string>();
  const [answer, setAnswer] = useState<Awaited<ReturnType<typeof appApi.orderRead>>>(), [error, setReadError] = useState<string>();
  const [confirm, setConfirm] = useState<"place" | "cancel" | "continue-cancel">();
  const [attempts, setAttempts] = useState(() => ({ place: localStorage.getItem(keyFor(where, `${id}:place`)) !== null, cancel: localStorage.getItem(keyFor(where, `${id}:cancel`)) !== null }));
  const [resumeAllowed, setResumeAllowed] = useState(false), [freshRead, setFreshRead] = useState(false);
  const resumeEvidence = useRef(false), readRevision = useRef(0), readPending = useRef(true);
  const readEvidence = useRef<{ id: string; state: LimitOrderView["state"] } | null>(null);
  const storageKey = decisionKey(where, "order", id);
  const [decisionUnknown, setDecisionUnknown] = useState(() => decisionWasAttempted(storageKey));
  const decisionAttempt = useRef(decisionUnknown), deciding = useRef(false);
  // Cached order/list/action replies never grant permission to continue. Every fresh read replaces the proof.
  const clearResume = useCallback(() => {
    const revision = ++readRevision.current;
    resumeEvidence.current = false; setResumeAllowed(false); readPending.current = false; setReading(false);
    readEvidence.current = null; setFreshRead(false); setConfirm(undefined);
    return revision;
  }, []);
  const read = useCallback(async () => {
    const revision = clearResume(); readPending.current = true; setReading(true);
    try {
      const current = await appApi.orderRead(where, id);
      if (!current || typeof current.result?.ok !== "boolean" || (current.result.ok && current.result.value?.id !== id))
        throw new Error("The app did not return this exact order. Read status again; no cancellation can be continued.");
      if (revision !== readRevision.current) return undefined;
      const fresh = current.exit === 0 && current.result.ok && typeof current.decisionHeld === "boolean";
      readEvidence.current = fresh && current.result.ok ? { id, state: current.result.value.state } : null; setFreshRead(fresh);
      const allowed = fresh && current.result.ok && current.result.value.cancelMayResume === true;
      resumeEvidence.current = allowed; setResumeAllowed(allowed);
      if (allowed) setAttempts(previous => ({ ...previous, cancel: true }));
      setAnswer(current); setReadError(undefined);
      return current;
    } catch (e) {
      if (revision === readRevision.current) setReadError(errorOf(e));
      return undefined;
    } finally { if (revision === readRevision.current) { readPending.current = false; setReading(false); } }
  }, [where, id, clearResume]);
  const again = useCallback(() => { void read(); }, [read]);
  useEffect(again, [again]);
  const held = { place: attempts.place || answer?.attempts?.place === true,
    cancel: attempts.cancel || answer?.attempts?.cancel === true || (answer?.result.ok && answer.result.value.cancelRequestedAt != null) };
  const canContinueCancel = resumeAllowed && !busy && !reading && !error && answer?.result.ok && answer.result.value.id === id
    && answer.result.value.cancelMayResume === true && typeof answer.result.value.orderId === "string"
    && ["cancel_requested", "unknown", "resting", "partially_filled"].includes(answer.result.value.state);
  async function refresh() {
    const revision = clearResume(); readPending.current = true; setReading(true); setProblem(undefined); setReadError(undefined);
    try {
      const current = await appApi.orderRefresh(where, id);
      if (!current || typeof current.result?.ok !== "boolean" || (current.result.ok && current.result.value?.id !== id))
        throw new Error("The app did not return this exact order. Read status again; no cancellation can be continued.");
      if (revision !== readRevision.current) return;
      const fresh = current.exit === 0 && current.result.ok && typeof current.decisionHeld === "boolean";
      readEvidence.current = fresh && current.result.ok ? { id, state: current.result.value.state } : null; setFreshRead(fresh);
      const allowed = fresh && current.result.ok && current.result.value.cancelMayResume === true;
      resumeEvidence.current = allowed; setResumeAllowed(allowed);
      if (allowed) setAttempts(previous => ({ ...previous, cancel: true }));
      if (current.result.ok) setAnswer(previous => ({ ...previous, ...current })); else setProblem(failureOf(current));
    } catch (e) { if (revision === readRevision.current) setReadError(errorOf(e)); }
    finally { if (revision === readRevision.current) { readPending.current = false; setReading(false); } }
  }
  async function decide(verdict: "approve" | "reject", sign: Signing) {
    if (deciding.current || readPending.current || busy || error || readEvidence.current?.state !== "proposed" || answer?.decisionHeld !== false
      || decisionAttempt.current || decisionWasAttempted(storageKey)) return;
    deciding.current = true; clearResume(); setBusy(true); setProblem(undefined); setNotice(undefined);
    let relaying = false;
    try {
      const message = sign[verdict], nonce = crypto.getRandomValues(new Uint8Array(32));
      const signed = await signText({ message, recipient: sign.recipient, nonce, account });
      const attemptKey = `${storageKey}:${base64(nonce)}`;
      localStorage.setItem(attemptKey, "attempted"); decisionAttempt.current = true; setDecisionUnknown(true);
      relaying = true;
      const result = await appApi.orderDecide(where, id, verdict, { message, nonce: base64(nonce), ...signed });
      const refused = result.exit === 2 && result.result.ok === false && result.decisionHeld === false;
      if (refused) {
        localStorage.removeItem(attemptKey);
        const stillHeld = decisionWasAttempted(storageKey); decisionAttempt.current = stillHeld; setDecisionUnknown(stillHeld);
      }
      if (!result.result.ok) setProblem(failureOf(result));
      if (result.exit === 3 || (!result.result.ok && !refused))
        setNotice("Your decision may have been recorded. Follow this order with reads only.");
      else if (result.result.ok) setNotice("Decision recorded. Approval alone places no order.");
      else setNotice("No owner decision was recorded.");
      again();
    } catch (e) {
      if (relaying) setNotice("Your decision may have been recorded. Follow this order with reads only.");
      setProblem(errorOf(e));
    }
    finally { deciding.current = false; setBusy(false); }
  }
  async function act(action: "place" | "cancel") {
    if (busy || readPending.current || error || !readEvidence.current || readEvidence.current.id !== id
      || (action === "place" && readEvidence.current.state !== "approved")
      || held[action] || localStorage.getItem(keyFor(where, `${id}:${action}`)) !== null) return;
    clearResume(); setBusy(true); setConfirm(undefined); setProblem(undefined);
    try {
      localStorage.setItem(keyFor(where, `${id}:${action}`), new Date().toISOString());
      setAttempts(previous => ({ ...previous, [action]: true }));
      const result = await (action === "place" ? appApi.orderPlace(where, id) : appApi.orderCancel(where, id));
      if (result.result.ok) setAnswer(previous => previous && ({ ...previous, ...result })); else setProblem(failureOf(result));
      setNotice(action === "place" ? "Placement attempted once. A resting order still needs fills and final payouts." : "Cancellation attempted once. Continue following fills and final payouts.");
      if (result.exit === 3 || !result.result.ok) { await read(); await refresh(); }
    } catch (e) {
      setNotice(action === "place" ? "Placement reply was lost. Follow this same order using reads and refresh only."
        : "Cancellation reply was lost. Read this same order for the platform's cancellation state.");
      setProblem(`${errorOf(e)} ${action === "place" ? "Placement may have been accepted. Only read or refresh this order; do not submit a replacement."
        : "Cancellation may have been accepted. Read status; continue only when fresh platform evidence explicitly permits it."}`);
      await read(); await refresh();
    } finally { setBusy(false); }
  }
  async function continueCancel() {
    if (!canContinueCancel || !resumeEvidence.current) return;
    clearResume(); setBusy(true); setConfirm(undefined); setProblem(undefined); setNotice(undefined);
    try {
      // Retain the original cancel marker. This action continues its saved claim, never an initial cancel.
      if (localStorage.getItem(keyFor(where, `${id}:cancel`)) === null)
        localStorage.setItem(keyFor(where, `${id}:cancel`), "existing-platform-claim");
      setAttempts(previous => ({ ...previous, cancel: true }));
      const result = await appApi.orderContinueCancel(where, id);
      if (result.result.ok) setAnswer(previous => previous && ({ ...previous, ...result })); else setProblem(failureOf(result));
      setNotice(result.exit === 3 ? "The pending cancellation reply was lost. Read this same order; submission may have begun."
        : result.result.ok ? "Pending cancellation continued for this order. Follow fills and final payout." : "The pending cancellation was not confirmed. Read this same order again.");
      if (result.exit === 3 || !result.result.ok) { await read(); await refresh(); }
    } catch (e) {
      setNotice("The pending cancellation reply was lost. Read this same order; submission may have begun.");
      setProblem(errorOf(e));
      await read(); await refresh();
    } finally { setBusy(false); }
  }
  const view = answer?.result.ok ? answer.result.value : undefined;
  const actionReadReady = freshRead && !busy && !reading && !error && !readPending.current && readEvidence.current?.id === id;
  const canPlace = actionReadReady && access.mayExecute && view?.state === "approved" && readEvidence.current?.state === "approved" && !held.place;
  return <section aria-label="Order review" className="flex flex-col gap-4">
    <Button variant="outline" className="self-start" onClick={back}>Back to orders</Button>
    {error && <ErrorBox error={error} />}
    {!answer ? <Loading label="Reading exact order terms" /> : !view ? <ErrorBox error={failureOf(answer)} /> : <>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="break-all text-lg font-semibold">Order {view.id}</h3><Badge tone={stateTone(orderStatus(view))}>{orderStatus(view)}</Badge></div>
      <p className="break-all text-sm">{view.order.side} {view.order.quantity} atomic {view.order.base_asset} at {view.order.price} {view.order.quote_asset} per base unit. Deadline {view.order.deadline}.</p>
      <p className="break-all text-sm">Gross spend {view.spendAmount} atomic {view.spendAsset}. Output {view.outputAsset}. Provider order: {view.orderId ?? "not confirmed"}.</p>
      {view.reason && <Note>{view.reason}</Note>}
      {orderStatus(view) === "completed" ? <Note>Completed: the provider reports a closed fill and final completed payouts.</Note>
        : <p className="text-sm">Fill: {view.fillStatus ?? "unknown"}. Payout: {view.payoutStatus ?? "unknown"}; final: {view.isPayoutStatusFinal === true ? "yes" : "not proven"}. {orderStatus(view) === "payout_failed" ? "Payout failed; review is required." : "The trade is not complete until final payouts are proven."}</p>}
      {view.partialFills && <details><summary className="min-h-11 cursor-pointer py-3">Partial fill evidence ({view.partialFills.length})</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(view.partialFills, null, 2)}</pre></details>}
      {view.payouts && <details><summary className="min-h-11 cursor-pointer py-3">Payout evidence</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(view.payouts, null, 2)}</pre></details>}
      {answer?.sign && view.state === "proposed" && <>
        <figure aria-label="Exact order approval text"><figcaption className="text-sm font-medium">Exact order approval text · recipient {answer.sign.recipient}</figcaption><pre className="whitespace-pre-wrap break-all rounded border p-3 text-xs">{answer.sign.approve}</pre></figure>
        <details><summary className="min-h-11 cursor-pointer py-3">Exact order rejection text</summary><pre className="whitespace-pre-wrap break-all rounded border p-3 text-xs">{answer.sign.reject}</pre></details>
        {access.signer === "wallet" && access.owner === account && access.mayPrepare && actionReadReady && !decisionUnknown && answer.decisionHeld === false && <div className="flex flex-wrap gap-2">
          <Button disabled={busy || reading} onClick={() => void decide("approve", answer.sign!)}>Sign exact order and approve</Button><Button variant="outline" disabled={busy || reading} onClick={() => void decide("reject", answer.sign!)}>Sign exact order and reject</Button>
        </div>}
        {access.signer === "dao" && actionReadReady && answer.decisionHeld === false && <DaoOrder where={where} id={id} account={account} access={access} onRelayed={again} />}
      </>}
      {view.state === "proposed" && (decisionUnknown || answer.decisionHeld !== false) && <Note>Decision signing is closed. Continue polling this order; a proposed view cannot rule out an in-flight decision. If a definitive refusal reply was lost, manual review of retained decision-attempt evidence is required.</Note>}
      {held.place && view.state === "approved" && <Note>Placement was already attempted. An approved view does not prove the attempt stopped. Follow this order with reads only.</Note>}
      {canPlace && <Button className="self-start" onClick={() => { if (!readPending.current && readEvidence.current?.state === "approved") setConfirm("place"); }}>Place approved order</Button>}
      {actionReadReady && access.mayExecute && view.orderId && ["resting", "partially_filled", "unknown"].includes(view.state) && !held.cancel && <Button variant="outline" disabled={busy || reading} className="self-start" onClick={() => setConfirm("cancel")}>Request cancellation</Button>}
      {access.mayExecute && canContinueCancel && <div className="flex flex-col gap-2"><Note>The platform confirms this pending cancellation has not been submitted. You can explicitly continue the saved cancellation for this exact order.</Note>
        <Button variant="outline" className="self-start" onClick={() => setConfirm("continue-cancel")}>Continue pending cancellation</Button></div>}
      {confirm && (confirm !== "continue-cancel" || canContinueCancel) && (confirm !== "place" || canPlace) && <div className="flex flex-col gap-2"><p className="text-sm">{confirm === "place" ? "Place this exact approved order once? Funds may remain in the resting order until fills and final payout."
        : confirm === "continue-cancel" ? "Continue the saved cancellation for this same order? The platform checks again that it has not been submitted. Partial fills and payouts still need tracking."
        : "Request cancellation once? Partial fills may continue and still require payout tracking."}</p>
        <div className="flex flex-wrap gap-2"><Button disabled={busy || reading} onClick={() => void (confirm === "continue-cancel" ? continueCancel() : act(confirm))}>{confirm === "place" ? "Confirm one placement attempt" : confirm === "continue-cancel" ? "Confirm pending cancellation continuation" : "Confirm one cancellation attempt"}</Button><Button variant="outline" disabled={busy} onClick={() => setConfirm(undefined)}>Keep reviewing</Button></div></div>}
    </>}
    <div role="status" aria-label="Order outcome" className="text-sm">{notice}</div>
    {problem && <ErrorBox error={problem} />}
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || reading} onClick={() => { setProblem(undefined); again(); }}>Read this order</Button><Button variant="outline" disabled={busy || reading} onClick={() => void refresh()}>Refresh fills and payout</Button></div>
  </section>;
}

/** Members file the platform's exact transaction, then poll the one request for its one-time owner-signature relay. */
function DaoOrder({ where, id, account, access, onRelayed }: { where: Where; id: string; account: string; access: OrderAccess; onRelayed: () => void }) {
  const storageKey = keyFor(where, `${id}:dao`);
  const [filed, setFiled] = useState<DaoOrderFiled | undefined>(() => { try { return JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? undefined; } catch { return undefined; } });
  const [voting, setVoting] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [state, setState] = useState<string>();
  const [sent, setSent] = useState(() => localStorage.getItem(`${storageKey}:sent`) !== null);
  const [attempted, setAttempted] = useState(() => localStorage.getItem(`${storageKey}:filed`) !== null);
  async function file(verdict: "approve" | "reject") {
    setBusy(true); setError(undefined);
    try {
      localStorage.setItem(`${storageKey}:filed`, verdict); setAttempted(true);
      const answer = await appApi.daoOrderFile(where, id, verdict);
      if (answer.result.ok) { localStorage.setItem(storageKey, JSON.stringify(answer.result.value)); setFiled(answer.result.value); }
      else setError(failureOf(answer));
    } catch (e) { setError(`${errorOf(e)} The filing needs review; no replacement vote is filed automatically.`); } finally { setBusy(false); }
  }
  async function send() {
    if (!filed || sent) return;
    const transaction = voting && access.mayVote && filed.transactions.proposalAndVote ? filed.transactions.proposalAndVote : filed.transactions.proposal;
    if (!transaction) return;
    setBusy(true); setError(undefined);
    try {
      localStorage.setItem(`${storageKey}:sent`, "attempted"); setSent(true);
      await sendAsCurrentMember(transaction, account); setState("Vote submitted. Follow this same request until the DAO signature is relayed.");
    } catch (e) { setError(`${errorOf(e)} Follow this request before submitting another transaction.`); } finally { setBusy(false); }
  }
  async function poll() {
    if (!filed) return;
    setBusy(true); setError(undefined);
    try { const answer = await appApi.daoOrderState(where, filed.request.id); if (!answer.result.ok) setError(failureOf(answer)); else { setState(answer.result.value.state); if (answer.result.value.state === "relayed") onRelayed(); } }
    catch (e) { setError(errorOf(e)); } finally { setBusy(false); }
  }
  return <div className="flex flex-col gap-3">
    <h4 className="font-semibold">DAO order decision</h4>
    <p className="text-sm">Only admitted members with FunctionCall proposal permission can file. Voting also requires the DAO's approval permission. Approval by vote does not place the order.</p>
    {!filed && !attempted && access.mayPrepare && <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void file("approve")}>Prepare DAO approval vote</Button><Button disabled={busy} variant="outline" onClick={() => void file("reject")}>Prepare DAO rejection vote</Button></div>}
    {!filed && attempted && <Note>A DAO filing was already attempted. Review its receipt before preparing another vote.</Note>}
    {filed && <><p className="break-all text-sm">Request {filed.request.id} · hash {filed.request.hash} · voting until {new Date(filed.request.votingUntil).toLocaleString()}</p>
      <pre className="whitespace-pre-wrap break-all rounded border p-3 text-xs">{filed.request.description}</pre>
      {access.mayVote && !sent && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={voting} onChange={e => setVoting(e.target.checked)} />Also cast my approval vote</label>}
      {!sent && access.mayPrepare && <Button disabled={busy} className="self-start" onClick={() => void send()}>Submit DAO proposal{voting ? " and vote" : ""}</Button>}
      <Button variant="outline" disabled={busy} className="self-start" onClick={() => void poll()}>Read DAO order vote</Button>
    </>}
    <div role="status">{state}</div>{error && <ErrorBox error={error} />}
  </div>;
}

/** A new DAO consent is itself an exact member-filed vote, reachable alongside an existing connection. */
function DaoOrderConsent({ where, account, access, onConnected }: { where: Where; account: string; access: OrderAccess; onConnected: () => void }) {
  const storageKey = keyFor(where, "dao-consent");
  const [filed, setFiled] = useState<(DaoOrderConsentFiled & { message: string }) | undefined>(() => { try { return JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? undefined; } catch { return undefined; } });
  const [voting, setVoting] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [status, setStatus] = useState<string>();
  const [attempted, setAttempted] = useState(() => localStorage.getItem(`${storageKey}:file`) !== null);
  const [sent, setSent] = useState(() => localStorage.getItem(`${storageKey}:send`) !== null);
  async function file() {
    if (localStorage.getItem(`${storageKey}:file`)) return;
    setBusy(true); setError(undefined);
    try {
      localStorage.setItem(`${storageKey}:file`, "attempted"); setAttempted(true);
      const answer = await appApi.daoOrderConsentFile(where);
      if (answer.result.ok) { const saved = { ...answer.result.value, message: answer.message }; localStorage.setItem(storageKey, JSON.stringify(saved)); setFiled(saved); }
      else setError(failureOf(answer));
    } catch (e) { setError(`${errorOf(e)} Review this consent filing before preparing another vote.`); }
    finally { setBusy(false); }
  }
  async function send() {
    if (!filed || localStorage.getItem(`${storageKey}:send`)) return;
    const transaction = voting && access.mayVote && filed.transactions.proposalAndVote ? filed.transactions.proposalAndVote : filed.transactions.proposal;
    if (!transaction) return;
    setBusy(true); setError(undefined);
    try {
      localStorage.setItem(`${storageKey}:send`, "attempted"); setSent(true);
      await sendAsCurrentMember(transaction, account); setStatus("Consent vote submitted. Read this same request until the DAO signs it.");
    } catch (e) { setError(`${errorOf(e)} Follow this consent request before submitting another transaction.`); }
    finally { setBusy(false); }
  }
  async function poll() {
    if (!filed) return;
    setBusy(true); setError(undefined);
    try {
      const answer = await appApi.daoOrderConsentState(where, filed.request.id);
      if (!answer.result.ok) setError(failureOf(answer));
      else { setStatus(answer.result.value.state); if (answer.result.value.state === "signed") {
        // Retain an archive while allowing a later expired/revoked consent to be renewed.
        localStorage.setItem(`${storageKey}:archive:${filed.request.id}`, JSON.stringify(filed));
        for (const key of [storageKey, `${storageKey}:file`, `${storageKey}:send`]) localStorage.removeItem(key);
        onConnected();
      } }
    } catch (e) { setError(errorOf(e)); }
    finally { setBusy(false); }
  }
  return <div className="flex flex-col gap-3">
    <p className="text-sm">The DAO votes on this additional order consent. Members need FunctionCall proposal permission; also casting a vote requires approval permission.</p>
    {!filed && !attempted && <Button className="self-start" disabled={busy} onClick={() => void file()}>Prepare DAO order consent vote</Button>}
    {!filed && attempted && <Note>An order consent filing was already attempted. Review its receipt before preparing another vote.</Note>}
    {filed && <>
      <p className="break-all text-sm">Request {filed.request.id} · check hash {filed.request.hash} · voting until {new Date(filed.request.votingUntil).toLocaleString()}</p>
      <figure aria-label="DAO order consent text"><figcaption className="text-sm font-medium">Exact DAO order consent</figcaption><pre className="whitespace-pre-wrap break-all rounded border p-3 text-xs">{filed.message}</pre></figure>
      <pre className="whitespace-pre-wrap break-all rounded border p-3 text-xs">{filed.request.description}</pre>
      {!sent && access.mayVote && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={voting} onChange={e => setVoting(e.target.checked)} />Also vote for this order consent</label>}
      {!sent && <Button className="self-start" disabled={busy} onClick={() => void send()}>Submit DAO order consent{voting ? " and vote" : ""}</Button>}
      <Button className="self-start" variant="outline" disabled={busy} onClick={() => void poll()}>Read DAO order consent</Button>
    </>}
    <div role="status">{status}</div>{error && <ErrorBox error={error} />}
  </div>;
}
