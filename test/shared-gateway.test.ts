import assert from "node:assert/strict";
import { test } from "node:test";
import { readGateway, treasuryReservation } from "../web/src/app/gateway-contract.js";
const location = { hostname: "treasury.test", protocol: "https:", pathname: "/" };
const shared = { agents: [], invoices: null, viewer: { account: "alice.near", access: {} }, selfService: true, setupAreas: ["treasury"] };
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
test("shared discovery enables Treasury setup and binds wallet/DAO reservations", async () => {
  const gateway = await readGateway(response(shared), location);
  assert.equal(gateway?.selfServiceTreasury, true);
  assert.deepEqual(treasuryReservation(gateway!, "wallet", "ignored.near"), { path: "/gw/agents", body: { owner: "alice.near", kind: "wallet", area: "treasury" } });
  assert.deepEqual(treasuryReservation(gateway!, "dao", " team.sputnik-dao.near "), { path: "/gw/agents", body: { owner: "team.sputnik-dao.near", kind: "dao", area: "treasury" } });
});
test("legacy standalone Treasury keeps its reservation contract", async () => {
  const legacy = { agents: [], invoices: null, viewer: null };
  assert.deepEqual(await readGateway(response(legacy), location), legacy);
  const gateway = await readGateway(response({ ...shared, selfService: undefined, setupAreas: undefined, selfServiceTreasury: true }), location);
  assert.deepEqual(treasuryReservation(gateway!, "wallet", ""), { path: "/gw/treasuries", body: { kind: "wallet" } });
  assert.deepEqual(treasuryReservation(gateway!, "dao", "team.near"), { path: "/gw/treasuries", body: { kind: "dao", dao: "team.near" } });
});
test("host area restrictions and missing sessions never enable reservation", async () => {
  for (const data of [{ ...shared, setupAreas: ["payables"], selfServiceTreasury: true }, { ...shared, selfService: false, selfServiceTreasury: true }, { ...shared, selfService: undefined, selfServiceTreasury: true }, { ...shared, setupAreas: undefined, selfServiceTreasury: true }, { ...shared, setupAreas: [], selfServiceTreasury: true }, { ...shared, viewer: null }]) {
    const gateway = await readGateway(response(data), location);
    assert.throws(() => treasuryReservation(gateway!, "wallet", ""));
  }
});
test("HTML fallback and malformed success cannot become trusted hosted mode", async () => {
  for (const loc of [location, { ...location, hostname: "localhost", pathname: "/a/example/", protocol: "http:" }]) {
    await assert.rejects(readGateway(new Response("<html>fallback</html>", { headers: { "content-type": "text/html" } }), loc), /gateway/i);
  }
  for (const body of [{}, { error: "unavailable" }, { ...shared, viewer: {} }, { ...shared, agents: [{}] }])
    await assert.rejects(readGateway(response(body), location), /gateway/i);
  assert.equal(await readGateway(new Response("<html>local</html>"), { hostname: "127.0.0.1", protocol: "http:", pathname: "/" }), null);
  await assert.rejects(readGateway(new Response("unavailable", { status: 503 }), location));
});

test("invalid JSON and malformed capability fields fail closed", async () => {
  await assert.rejects(readGateway(new Response(JSON.stringify({ error: "Gateway unavailable" }), { status: 503, headers: { "content-type": "application/json" } }), location), /Gateway unavailable/);
  await assert.rejects(readGateway(new Response("{broken", { headers: { "content-type": "application/json" } }), location));
  for (const body of [{ ...shared, selfService: "true" }, { ...shared, setupAreas: "treasury" }, { ...shared, viewer: { account: "alice.near", access: { treasury: {} } } }])
    await assert.rejects(readGateway(response(body), location), /gateway/i);
  await assert.rejects(readGateway(new Response("<html>failure</html>", { status: 503 }), { hostname: "localhost", protocol: "http:", pathname: "/" }));
  await assert.rejects(readGateway(new Response("<html>fallback</html>"), { hostname: "localhost", protocol: "https:", pathname: "/" }));
});

test("payee entries are http(s) URLs or the discovery is refused", async () => {
  for (const invoices of ["javascript:alert(1)", "ftp://invoices.example"]) {
    await assert.rejects(readGateway(response({ ...shared, invoices }), location), /gateway/i);
    await assert.rejects(readGateway(response({ ...shared, agents: [{ name: "treasury", owner: "alice.near", dao: false, invoices }] }), location), /gateway/i);
  }
  await assert.rejects(readGateway(response({ ...shared, invoices: "not a url" }), location));
  assert.equal((await readGateway(response({ ...shared, invoices: "https://invoices.example/" }), location))?.invoices, "https://invoices.example/");
});
