# Treasury operations

This runbook covers the Treasury gateway and executors. Deployment, restarts and live money actions
are performed by the owner. Local validation is not a deployment observation.

## Dashboard

Both the default `Dockerfile` and compatibility `Dockerfile.dashboard` build the Treasury interface.
`railway.json` selects `Dockerfile.dashboard`. The default gateway configuration is
`deploy/treasury.json`, with host `treasury.multiagency.ai` and no preconfigured agents.

For self-service registration, configure the backend Agent API key, `SESSION_SECRET` (at least
32 characters), `TREASURY_SELF_SERVICE=true`, and the correct sign-in host. Set `TRUST_PROXY=true`
behind Railway. With self-service off, configure explicit Treasury agent entries and their separate
settings files instead; an empty configuration intentionally refuses startup. `deploy/dashboard.json`
is also Treasury-only. `deploy/legacy-dashboard.json` is historical regression input. Proto executes
for the agents on production hosts, so no tracked configuration or image starts an executor there:
both preset DAO configurations run their agents approve-only (`"executor": false`), and
`test/deploy-executors.test.ts` rejects a production host with an executing agent, including the
schema's default. Self-service registrations are new agents with their own settings, so they don't
duplicate an agent Proto executes. Host variables and start-command overrides are outside the
repository and that test.

Use one replica and a persistent `/data` volume. The entrypoint runs the gateway from `/data/state`;
registered treasury state is under its `.treasuries/` directory. Never populate a new service with
another running executor's agent ID or grant. A frontend build does not establish executor ownership.

The copied Treasury release record is `07c31669-3ebe-4cc2-ba93-a87009e16c51`, service `treasury`,
2026-10-15. This cleanup has not been deployed or observed on that host. Earlier `dao` and `invoices`
deployment records describe the historical shared workspace; see [the mainnet log](mainnet-log.md)
and [legacy operations](legacy/operations.md).

A separate minimal standalone signing backport was released as
`e2c237bf-7d8b-4c4e-9e5d-b43030e14117`, 2026-10-16 UTC, preserving the original frontend, volume,
settings and executor assignment. Both-host owner sign-in and existing private records passed
[release acceptance](treasury-release-acceptance.md). This is not a deployment of the mutable
checkout or Proto's shared-infrastructure candidate.

## Owner release handoff

For the DAO reference, review the [release gates](treasury-rollout.md) and candidate
`deploy/dao-treasury-demo.json`. The candidate keeps the historical agent settings, runs both the
Treasury and payout agents approve-only, and contains no Proto redirect. It is not a live topology record
or permission to replace either existing service's configuration.

Before deployment, finish concurrent edits, identify the exact candidate and run `pnpm verify`.
Include required untracked files; a tracked-only diff is incomplete. Verify project, services,
domains, volumes, host-bound sign-in and executor assignments read-only. Resolve the DAO reference
and separate wallet installation's access destinations before any domain reassignment. Proto stays
the umbrella showcase; do not deploy the focused Treasury image over it or the invoice executor.

Keep one executor per agent, one replica and the existing state. The default gateway configuration
has no preset agents, so preserve explicit settings or the existing self-service setting rather
than accidentally starting with an empty configuration. Use the stopped-writer preservation
procedure below for backups or executor movement. Historical mappings in
`deploy/legacy-dashboard.json` require verification against the actual services.

After the owner's deployment:

1. Record the source revision, deployment ID and UTC time privately. Check `/health` and run the
   read-only `pnpm smoke` command below against the intended host.
2. Sign in normally and inspect the Treasury overview, policy, targets and schedule, balances,
   Activity and one selected retained run. Verify the intended schedule state without changing it.
3. Confirm Payables and Steward are absent from navigation. Steward remains available by its
   direct experimental route; opening it is separate from proposing or executing a plan.
4. Rehearse the presenter fallback in [DEMO.md](../DEMO.md#presenter-fallback). Keep this hosted
   inspection read-only; quotes, confirmations and any low-value mainnet demonstration are separate
   owner actions.

If startup or private reads fail, retain state and investigate the configuration or access evidence.
Rollback changes the application image while preserving all operation and owner-action records;
it must not create a second executor. A successful health check alone does not establish a safe
executor assignment or a settled operation.

## Optional self-service Treasury registration

A signed-in NEAR account can register a workspace for itself. A Sputnik DAO additionally requires
current group proposal permission. Registration creates local state, signs no provider intent and
moves no funds. Agent creation, policy updates, strategy authorization and schedule enablement retain
separate explicit actions. Unavailable ownership or permission evidence refuses access.

The current prototype permits one workspace per owner and at most 16 per host. It has no workspace
deletion, ownership transfer, distributed provisioning or cross-host executor fencing. Each registered
owner gets an isolated working directory and settings file. Shared provider and RPC credentials remain
server-side; child processes do not receive parent agent grants, owner private keys or invoice ports.

Registration and access isolation have offline tests. Those tests do not establish that a real owner
created an agent through the current hosted build.

## Executor migration and state preservation

Stop the gateway, every child executor and all CLI writers before backup, copying, upgrade or moving
an executor. Start the destination only after the source is stopped. `EXECUTOR=off` is required on
every other instance of the same agent. The lease and money lock coordinate a single host only.

Preserve the entire state directory and all settings, including:

- `.treasuries/registry.json` and every registered child's `.env.instance` and complete working directory.
- `.ops/`, `.invoices/` including SQLite journals, `.owner-intents/`, `.strategy/`, `.plans/`,
  `.evidence/`, `.inbox/`, `.agreements/`, `.notify/`, `.work-orders/` and legacy `.intake/` state.
- Existing grant tokens, staged grant settings, journal identities and owner-action records.
- `.machine-auth/` at the gateway root: credential hashes, expiry/revocation flags and access attribution from the
  removed machine interface. Nothing reads it any more; archive it rather than delete it
  ([machine interface](machine-api.md#state-archive-machine-auth-dont-delete-it)).

Do not discard inherited directories because the Treasury UI no longer exposes their workflows.
Never initialize a fresh registry over retained child state. A corrupt registry or missing registered
settings must be investigated; do not replace them merely to resume execution.

This cleanup changes product defaults, routing, documentation and read-only tools. It changes no stored
money records, policy schema, dispatch authorization or executor locking, and requires no state-format
migration. Changing defaults is still a reviewed rollout: preserve explicit existing environment and
executor settings. Rollback must retain all records and avoid starting another executor.

## Settings and record-read hardening

Settings writers lock the canonical settings-file target. Symlink aliases share that lock; contention
returns a retry error without replacing settings. A CLI edit does not refresh another process's
environment. Do not remove a live writer's lock. Unreadable journal, owner-intent, inbox and agreement
records require investigation against verified evidence; never erase them to unblock sending.
Detailed historical upgrade notes remain in [legacy operations](legacy/operations.md#settings-and-record-read-hardening).

## Scheduling cadence and local refactoring

Saving a strategy persists scheduling off. The owner authorizes its exact digest-bound grant, then
explicitly enables the schedule. Stop prevents future scheduled ticks; an already started tick can
submit further operations and submitted operations may finish.

Cadence is counted from the latest recorded inbox `run` summary. That summary precedes the final
after-observation and evidence end. A missing end can mean an interrupted or unknown run; it does
not independently pause cadence. Unresolved operations still block new sends. A separate durable
scheduler checkpoint is not implemented.

## Unattended run: observing the Treasury autopilot

Use the existing `pnpm run-report` with its configured dashboard URL, session file and agent name.
Keep reports and real recordings outside the repo. A scheduled run, provider acceptance, operation
settlement and an absence of dashboard interventions are separate observations. The report's
historical intervention classification is retained. Multi-day unattended operation remains a gap.
See [the detailed report procedure](legacy/operations.md#unattended-run-observing-the-treasury-autopilot).

## Read-only checks

```sh
DASHBOARD_URL=https://treasury.multiagency.ai pnpm smoke
DASHBOARD_URL=https://treasury.multiagency.ai REPORT_COOKIE_FILE=/private/session pnpm demo-check
```

Smoke checks health, headers, host-bound sign-in and signed-out access refusal. With a private session
and `SMOKE_SNAPSHOT`, it checks preservation for the actual accessible agent names, including registered
Treasuries. An old two-agent snapshot is not silently rewritten; identity differences fail the check.
`INVOICES_URL` is optional and only enables historical invoice-host checks.

Demo preflight discovers the accessible Treasury. Set `REPORT_AGENT` when more than one is accessible.
It reads valuations, budget headroom, unresolved operations and schedule state. A manual preview does
not require scheduling on; set `REPORT_REQUIRE_SCHEDULE=true` for a scheduled-run demonstration.
`REPORT_EXPECTED_USD` is a rehearsal estimate, default 5, not authorization or a spendable-balance
claim. A missing USD budget fails the check rather than proving an unlimited budget is acceptable.
These commands do not create a quote, recover an operation, sign or send funds.

## Historical compatibility

`PUBLIC_TREASURY_ONLY=false` selects the inherited UI for regression tests only. Payables execution
requires `pnpm legacy:invoices`; it is outside the Treasury product. `Dockerfile.legacy-invoices` forces
`EXECUTOR=off`, which the invoice server refuses, so the image can't start the payout executor;
Proto's payout executor replaces it. Its state and recovery obligations remain documented in
[legacy operations](legacy/operations.md#payout-executor).
