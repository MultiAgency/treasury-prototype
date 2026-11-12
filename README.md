# Agentic Treasury Management

This repo focuses on idea 2 — Agentic Treasury Management. It retains compatible Payables
(idea 1) and Invoicing & Purchase-Order Management (idea 3) code for future sibling experiences.
The evolving sibling Proto checkout provides context for shared infrastructure and the umbrella showcase.
See the [domain-to-responsibility mapping](docs/scope.md#domain-to-responsibility-mapping)
for audiences, flows, agents, executors, state and implementation gaps. Proto must not redirect
to Treasury. Destination architecture is intended; current defaults still present Treasury.

**Create a Treasury agent, sign its spending envelope, and delegate quoted rebalancing with
inspectable outcomes.** The policy includes allowed assets,
per-asset monthly caps and a cross-asset USD budget. The agent reads balances, quotes swaps
before execution, rebalances toward target allocations and shields managed public balances.

The product target is an agent that cannot exceed its signed spending envelope. **That complete
guarantee is not established today.** Mainnet observations cover scheduled rebalancing, quoted
swaps, cap and budget refusals, budget headroom changes and shielding. Provider counter concurrency,
atomic USD-budget accounting and custody-level output-asset enforcement remain open. Spending caps
do not cap portfolio market exposure. See [requirements and evidence](docs/treasury.md) and the
[enforcement assessment](docs/enforcement.md).

## Run locally

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Set the backend Agent API key and owner configuration described in .env.example.
pnpm demo
```

The dashboard runs at http://localhost:8787. `pnpm web` starts the frontend development server,
with RPC proxied to the local backend. Ordinary frontend builds and development now use the
Treasury interface; no presentation flag is needed.

Creating an agent, signing its policy and issuing its grant require explicit owner actions.
Saving a strategy leaves scheduling off. The owner authorizes the saved strategy, then explicitly
enables its schedule. Opening a page or preparing a quote moves no funds.

## Focused Treasury demo

The existing DAO Treasury is the reference demonstration. Wallet and DAO owners can create
their own Treasury through optional self-service registration and the existing owner-action flow.
Registration signs nothing; offline fixtures do not establish a new hosted creation lifecycle.

The Treasury overview puts allocations, signed monthly caps, budget headroom, quoted rebalancing,
schedule status and confidential sweep together. A confirmed manual plan’s outcomes stay on that
screen, beside before-confirmation and latest observed budget headroom. Signed limits show each
USD budget window; recorded refusal codes load on request. These observations do not establish
atomic charging or attribute every budget change to that plan. This presentation is offline-tested,
not a new hosted or mainnet observation. Supporting views cover targets and schedule,
policy and grants, balances and funding, run details and operation history.

The [60-second walkthrough](DEMO.md) follows one plan from balances through quotes to recorded
operation outcomes and budget changes. The guided run at `/a/<agent-name>/demo` takes the same story
as three numbered steps, for rehearsal; see [Rehearse with the guided run](DEMO.md#rehearse-with-the-guided-run). The current strategy manages USDC, wNEAR and ETH; a
three-asset rebalance needs at most two swap legs. Do not invent a third swap to match the catalog's
example. Exact unshielding for a public payout is a missing part of the brief, not a reason to add
an invoice or agreement demo.

Payables retains existing payout and invoice intake code for a future sibling experience; idea 3
has partial isolated-order backend support and missing payee settlement. These belong to
their own demonstrations, not the focused Treasury minute. The default Treasury frontend
redirects payment routes; use the shared build for the implemented Payables interface. Steward remains available as a hidden experiment at
`/a/<agent-name>/steward` (or `/steward` on a standalone server): it proposes plans for explicit
review and execution, and is absent from navigation. Shared backend modules and regression fixtures remain where they support authorization,
owner actions, journal recovery or historical compatibility; their evidence and current limits are described in the scope mapping.
See [repository scope](docs/scope.md).

## Verification

```sh
pnpm typecheck
pnpm test
pnpm test:browser          # Treasury UI, registration and scope fixtures; no real provider
pnpm check:frontend       # Focused build: no shared Payables modules; calls only declared capabilities
pnpm review:treasury       # Isolated UI review; retain screenshots, traces and axe reports
pnpm evidence:check
```

The web app builds against the platform's owner contract, `@multiagency/sdk`, not the copied backend
router. It is pinned to the published 0.4.0 from the npm registry (lockfile integrity
`sha512-5Z90i0ru…`), so every image builds from this repository alone. A packaged frontend's
`manifest.json` records the SDK contents it was built against.
- **Calls:** every call goes through its `ownerClient`, which validates answers against the published
  output schemas and never retries.
- **Recovery:** the client's typed failure kinds decide what the UI does. A lost or unverifiable
  money-moving call is shown as an unknown outcome and is not resent. A lost plan preview re-reads
  the observations.
- **Manifest:** the default build ships `contract.json` (P2 owner-app manifest v1), naming the
  platform capabilities it needs.
- **`pnpm check:frontend`** checks the build's actual module graph. That graph
  must contain no shared Payables or Portfolio module and no file from `src/`. The check also
  type-checks the graph against only the declared procedures.
- **Browser fixtures** pass through the same published schemas and oRPC's encoder. Runtime compatibility grants no
authority: the gateway and agent still authorize every call. The check covers typed client calls,
not untyped HTTP. No release has been published or deployed; local release notes are in
[treasury releases](docs/treasury-releases.md).

`pnpm verify` also runs the inherited browser and application regressions. Those explicitly select
the shared presentation; their invoice and payout cases protect idea-1 flows and shared code.
`pnpm verify:candidate` captures the Git-visible working files and runs `pnpm verify` in that
snapshot, recording its source hash and whether the working tree still matches afterward. Finish
concurrent edits before capturing a candidate. Review artifacts under `.test-artifacts/` are local
and ignored by Git. Automated accessibility scans cover selected Treasury fixture states in both
themes; they supplement keyboard and visual checks and do not establish full WCAG conformance.
`pnpm test:live` touches real funds and runs only when explicitly requested.

Requirements and supporting observations live in [evidence/inventory.ts](evidence/inventory.ts).
Update the inventory, then run `pnpm evidence:write`; generated sections are never hand-edited.
[Mainnet observations](docs/mainnet-log.md) retain their original agent, date and deployment scope.
They do not establish behavior of a new source build or every registered treasury.

## Hosting and state

The checkout baseline was copied from the Treasury release recorded on 2026-10-15:
`07c31669-3ebe-4cc2-ba93-a87009e16c51`, Railway service `treasury`,
https://treasury.multiagency.ai. This cleanup has not been deployed or checked on that host.
The gateway configuration is [deploy/treasury.json](deploy/treasury.json). Self-service registration
is optional and requires `TREASURY_SELF_SERVICE=true`; registration signs nothing and starts with
scheduling off. See [operations](docs/operations.md). The [reference frontend integration](docs/treasury-reference-integration.md) prepares focused access to the existing DAO executor while retaining the wallet installation.

Deploys, restarts and live money actions are the owner's. There must be exactly one executor per
agent. The executor lease and money lock coordinate one host; they are not distributed fencing.
Preserve all agent state before any executor move, including inherited record directories.

The **Treasury app** (`app/`, `pnpm app`; candidate, offline-tested, not deployed) replaces it for outside agents: the
owner connects Treasury to the platform's `/apps/v1` under a signed consent, issues agents read/propose tokens, and
approves each proposal's exact terms in their wallet before executing it on the app's proposals page. See
`CONTEXT.md` ("Treasury app") and `coordination/treasury-app-move.md`.

Treasury's own [machine interface v1](docs/machine-api.md) was removed from this repository on 2026-11-03.
Production still serves an earlier version of it (deployment `95451b7a`, observed 2026-11-03) until the owner
redeploys; preserve and archive `.machine-auth/`. Outside agents move to the platform's app scope
(`coordination/treasury-app-move.md`). Until then the [Treasury skill](skills/treasury/SKILL.md) targets the
platform's machine route; its helper is tested against an offline simulated provider.
On the platform's machine route (the `@multiagency/sdk` 0.4.0 server, not deployed), executing a plan also needs the
owner's [strategy-bound grant](docs/machine-api.md#strategy-bound-grant-before-plan-execution): the owner signs a grant
for the saved strategy before any machine-route execution, and again after saving a different strategy.

## Not done yet

- Resting limit orders: the [app consumer](docs/limit-orders-consumer.md) uses a verified unpublished SDK 0.5.8 build with fresh platform proof for explicit pre-submission cancellation continuation. Offline/browser/container checks do not verify production provider routes, live placement/cancellation, fills, payout or policy enforcement; deployment remains gated on the compatible platform and separate staging intake.

- Outside-agent access has no replacement in this repository yet: the Treasury app over the platform's
  `/apps/v1` is a proposal (`coordination/treasury-app-move.md`). Until production is redeployed, it still serves
  the removed machine route, which doesn't require the strategy-bound grant; the platform's 0.4.0 server does.

- The Proto/domain release still requires its own review and authorization. Treasury's standalone
  fallback sign-in/private-access gate passed on 2026-10-16 UTC, deployment
  `e2c237bf-7d8b-4c4e-9e5d-b43030e14117`; see [release acceptance](docs/treasury-release-acceptance.md).

- Dedicated Payables hosting, a complete three-idea Proto showcase, idea-3 frontend and full
  order lifecycle acceptance, and payee settlement remain gaps. Gateway/session topology
  and the DAO Treasury host assignment need explicit architectural decisions; see [scope](docs/scope.md).

- Atomic USD-budget charging under all concurrent dispatches is not independently established.
  One simultaneous-swap trial is supporting evidence, not a proof.
- Strict cumulative per-asset enforcement under concurrency remains unverified. The application
  checks output assets; the provider's asset restriction has been observed to check inputs only.
- Exact public-payout unshielding and a calculated idle-surplus reserve are not implemented.
  Sweep shields the managed public USDC, wNEAR and ETH balances.
- Confidential balances reduce public balance visibility; universal untraceability is not established.
- Multi-day unattended operation is not demonstrated. Scheduling is not settlement evidence.
- The catalog's API example uses a different policy shape from the pinned SDK in this repo.
  Its address-whitelist conflict and budget-charging semantics must be verified against the actual
  provider before changing the money path; see [scope and compatibility](docs/scope.md).

The [architecture](docs/architecture.md) describes the one send site, durable journal, reconciliation,
owner intents and trust boundaries. Historical two-area instructions are retained under
[docs/legacy](docs/legacy/README.md), outside the focused Treasury demo; their evidence remains applicable to Payables.
