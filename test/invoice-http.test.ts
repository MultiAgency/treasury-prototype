import { authorityFixture, policyView } from "./fixtures/authority.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { api } from "../src/api.js";
import { sessionToken } from "../shared/signin.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { getInvoice, invoiceId, prepareInvoice, noteRevision, claimInvoiceSubmission } from "../src/invoice-store.js";
import { mayCall } from "../src/gateway/allowlist.js";
import { freshDirectory } from "./fixtures/harness.js";
import { remoteStore } from "../src/agreements.js";

const secret = "test-only-invoice-session-secret";
process.env.INVOICES_SESSION_SECRET = secret;
process.env.INVOICES_PUBLIC_HOST = "localhost:8791";
process.env.AGREEMENTS_SECRET = "test-only-agreements-secret";
const { invoiceHandler } = await import("../src/invoice-http.js");
const server = createServer(invoiceHandler);
let origin: string;
const sent: { recipient: string; amount: string }[] = [];
const payees = ["alice.near", "bob.near"];
freshDirectory("invoice-http", { per: "suite" });
before(async () => {
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  Object.assign(api, {
    ...authorityFixture(),
    getPolicy: async () => policyView(payoutPolicy(payees)),
    forGrant: () => ({ transfer: async (_id: string, request: { recipient: string; amount: string }) => {
      sent.push(request); return { correlation_id: `invoice-http-${sent.length}` };
    } }),
    getStatus: async (correlation_id: string) => ({ correlation_id, status: "SUCCESS" }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
});

const cookie = (payee: string) => `invoices_session=${sessionToken(payee, secret)}`;
const submit = (headers: Record<string, string>, payload: unknown) => fetch(`${origin}/api/invoices`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload),
});
const draft = { submission: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", amount: "1", note: "Work" };

test("HTTP endpoints reject missing or forged identity before filing", async () => {
  assert.equal((await submit({}, draft)).status, 401);
  assert.equal((await submit({ cookie: "invoices_session=forged" }, draft)).status, 401);
  assert.equal((await fetch(`${origin}/api/invoices`)).status, 401);
  assert.equal(sent.length, 0);
});

test("cross-origin writes fail; authenticated account, not JSON recipient, controls payment", async () => {
  assert.equal((await submit({ cookie: cookie("alice.near"), origin: "https://evil.test" }, draft)).status, 403);
  const response = await submit({ cookie: cookie("alice.near"), origin: "http://localhost:8791" }, { ...draft, payee: "bob.near" });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, "paid");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.recipient, "alice.near");
  assert.equal(getInvoice(invoiceId({ payee: "alice.near", submission: draft.submission }))?.reservation, "0");
});

test("retries retain identity and another signed-in payee cannot read it", async () => {
  const response = await submit({ cookie: cookie("alice.near") }, draft);
  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  const other = await fetch(`${origin}/api/invoices`, { headers: { cookie: cookie("bob.near") } });
  assert.deepEqual(await other.json(), { invoices: [], agreements: [], agreed: true });
  const mine = await fetch(`${origin}/api/invoices`, { headers: { cookie: cookie("alice.near") } });
  const text = await mine.text();
  assert.equal((JSON.parse(text) as { invoices: unknown[] }).invoices.length, 1);
  assert.ok(!text.includes("correlation") && !text.includes("ngt_") && !text.includes("idempotency"));
});

test("members may review invoices; cancellation requires execution or management permission", () => {
  const reader = { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false };
  assert.equal(mayCall(reader, "invoices"), true);
  assert.equal(mayCall(reader, "cancelPreparedInvoice"), false);
  assert.equal(mayCall({ ...reader, canExecute: true }, "cancelPreparedInvoice"), true);
  assert.equal(mayCall({ ...reader, canManage: true }, "cancelPreparedInvoice"), true);
});

const request = { submission: "cccccccc-dddd-eeee-ffff-000000000001", amount: "2.5", note: "Bounty: docs" };

test("an account not yet agreed files an agreement request: recorded, visible only to it, never paid", async () => {
  const response = await submit({ cookie: cookie("carol.near") }, request);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, "requested");
  assert.equal(sent.length, 1, "nothing was sent");
  assert.equal(getInvoice(invoiceId({ payee: "carol.near", submission: request.submission })), undefined, "no invoice or reservation");
  const own = await (await fetch(`${origin}/api/invoices`, { headers: { cookie: cookie("carol.near") } })).json() as { agreements: { status: string; amount: string }[] };
  assert.deepEqual(own.agreements.map((a) => [a.status, a.amount]), [["requested", "2500000"]]);
  const other = await (await fetch(`${origin}/api/invoices`, { headers: { cookie: cookie("bob.near") } })).json() as { agreements: unknown[] };
  assert.deepEqual(other.agreements, [], "another payee never sees it");
});

test("the internal endpoint answers only the shared secret, and the dashboard's store works through it", async () => {
  for (const authorization of [undefined, "Bearer wrong", "Bearer test-only-agreements-secre"])
    assert.equal((await fetch(`${origin}/internal/agreements`, { headers: authorization ? { authorization } : {} })).status, 404);
  const store = remoteStore(origin, "test-only-agreements-secret");
  const [carol] = (await store.list()).filter((a) => a.payee === "carol.near");
  assert.equal(carol?.status, "requested");
  await store.propose(carol!.id, new Date(Date.now() + 86_400_000));
  assert.equal((await store.list()).find((a) => a.id === carol!.id)?.status, "proposed");
  await assert.rejects(store.offer({ payee: "not an account!", amount: "1", note: "", until: new Date(Date.now() + 1000) }), /payee/);
  await assert.rejects(store.offer({ payee: "dana.near", amount: "1", note: "", until: new Date(Date.now() - 1000) }), /future/);
  const offered = await store.offer({ payee: "dana.near", amount: "5", note: "Award", until: new Date(Date.now() + 86_400_000) });
  await store.decline(offered);
  assert.equal((await store.list()).find((a) => a.id === offered)?.status, "declined");
});

test("once agreed, the payee files the request as an invoice: same identity, paid through the one send path", async () => {
  payees.push("carol.near");
  const response = await submit({ cookie: cookie("carol.near") }, request);
  assert.equal((await response.json() as { status: string }).status, "paid");
  assert.equal(sent.at(-1)?.recipient, "carol.near");
  assert.equal(sent.at(-1)?.amount, "2500000");
  const own = await (await fetch(`${origin}/api/invoices`, { headers: { cookie: cookie("carol.near") } })).json() as { agreements: unknown[]; invoices: unknown[] };
  assert.deepEqual(own.agreements, [], "a filed agreement shows as its invoice");
  assert.equal(own.invoices.length, 1);
});

test("invoice refresh reports current eligibility without reauthentication or sending", async () => {
  const read = async () => (await (await fetch(`${origin}/api/invoices`, { headers: { cookie: cookie("refresh.near") } })).json()) as { agreed: boolean };
  const before = sent.length;
  assert.equal((await read()).agreed, false);
  payees.push("refresh.near");
  try { assert.equal((await read()).agreed, true); }
  finally { payees.splice(payees.indexOf("refresh.near"), 1); }
  assert.equal((await read()).agreed, false);
  assert.equal(sent.length, before);
});





test("prepared invoice continuation uses stored terms, preserves identity, and sends once", async () => {
  const stored = prepareInvoice({ payee: "alice.near", submission: "abcdefab-cdef-abcd-efab-cdefabcdef01", amount: "1234567", note: "Original terms" }, ASSETS.USDC);
  const url = `${origin}/api/invoices/${stored.id}/continue`;
  const start = sent.length;
  assert.equal((await fetch(url, { method: "POST", headers: { cookie: cookie("bob.near") } })).status, 404);
  assert.equal(sent.length, start);
  const replies = await Promise.all([0, 1].map(() => fetch(url, { method: "POST", headers: { cookie: cookie("alice.near"), "content-type": "application/json" }, body: JSON.stringify({ amount: "999", recipient: "bob.near" }) })));
  assert.ok(replies.some((r) => r.status === 200));
  assert.equal(sent.length, start + 1);
  assert.deepEqual(sent.at(-1)?.amount, "1234567");
  assert.equal(getInvoice(stored.id)?.operation.idempotencyKey, stored.operation.idempotencyKey);
  assert.equal((await fetch(url, { method: "POST", headers: { cookie: cookie("alice.near") } })).status, 409);
  assert.equal(sent.length, start + 1);
});

test("continuation refuses revised or submission-attempted invoices without a new send", async () => {
  for (const changed of [false, true]) {
    const input = { payee: "alice.near", submission: changed ? "abcdefab-cdef-abcd-efab-cdefabcdef02" : "abcdefab-cdef-abcd-efab-cdefabcdef03", amount: "1000000", note: "Original" };
    const stored = prepareInvoice(input, ASSETS.USDC);
    if (changed) noteRevision({ ...input, amount: "2000000" });
    else claimInvoiceSubmission(stored.operation.idempotencyKey, stored.operation.request);
    const start = sent.length;
    assert.equal((await fetch(`${origin}/api/invoices/${stored.id}/continue`, { method: "POST", headers: { cookie: cookie("alice.near") } })).status, 409);
    assert.equal(sent.length, start);
  }
});





test("invoice page serves its checked browser module from the same origin", async () => {
  const html = await (await fetch(origin)).text();
  assert.match(html, /import \{ mountInvoicePage \} from "\/invoice-browser.js"/);
  assert.doesNotMatch(html, /function syncRows|async function refresh/);
  const response = await fetch(`${origin}/invoice-browser.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /javascript/);
  assert.match(await response.text(), /export async function mountInvoicePage/);
});
