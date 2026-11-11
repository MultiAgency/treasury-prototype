# Agentic Treasury

An AI agent moves an owner's funds on NEAR Intents, only inside a policy the owner signed. This glossary
names the concepts that the code, tests and reviews share.

## Product scope

This standalone repo focuses on **Agentic Treasury Management**: allowed assets, per-asset monthly
caps, a cross-asset USD budget, quoted rebalancing, a strategy-bound schedule, confidential sweep and
private operation evidence. Treasury is the default interface. Payables and the shared workspace
terms below describe retained compatibility code and historical evidence. Payables and Invoices are
future sibling experiences outside this Treasury phase.
Exact public-payout unshielding, an idle-surplus reserve and the complete signed-envelope guarantee
remain gaps; see `docs/scope.md` and `docs/enforcement.md`. Spending caps do not cap market exposure.

## Parties

**Owner**:
The wallet or Sputnik DAO that signs the agent's policy, issues its grants and approves held payouts.
_Avoid_: admin, user

**Agent**:
One Agent API agent with its own wallet, policy and grant, run by one instance of this server.
_Avoid_: bot, worker

**Treasury agent**:
An agent that swaps and shields toward a strategy without a vote per action. It runs the **Treasury**
area (docs/treasury.md).

**Payout agent**:
An agent that only makes confidential USDC transfers to agreed payees, each held for the owner's approval.
It runs the **Payables** area (docs/facilitator.md).

**Area** / **Brief**:
The active product area is **Treasury** (the treasury agent). **Payables** identifies the retained payout-agent compatibility area. A
brief is an experiment from the Agent Connect catalog that an area runs or plans, keeping its catalog
number and title (01 Confidential Treasury Facilitator, 02 Agentic Treasury Management). Each brief's
requirements distinguish mainnet observations, offline tests, pinned provider source with deployed
behavior unverified, and requirements not yet demonstrated.
_Avoid_: prototype (for an area), use case

**Workspace (historical shared interface)**:
The inherited signed-in owner's interface, with shared Home, Payables and Portfolio sections, and Activity. The default Treasury interface uses the single Treasury overview and supporting task views described below.
Each area retains its own agent, policy, grant, balance and access permissions. The shared Home
routes attention to the relevant area; it does not combine balances or authorize money actions.
Payables opens on Payments, with Agreements as its other task; Portfolio opens on Overview, with Strategy
as its other task. These tasks appear in the content area's navigation.
Payment queue rows include local invoices and link to one selected record; an invoice joins a payment
only through its recorded provider correlation ID. Approval and payment completion remain separate.
Payments defaults to **Needs review**: held payouts, changed or prepared invoices, owner-action recovery,
and unknown or conflicting retained outcomes. **All records** includes recorded terminal outcomes;
local recipient/reference search never fetches per-payment status or authorizes an action. Read failures
and incomplete coverage remain visible with either filter.
The desktop navigation rail and mobile drawer share the four workspace destinations. Payments includes manual payment
creation and invoice review; Agreements groups terms and separate policy inclusion by recipient.
Shared Activity retains each agent's returned operation, owner-action and run history, with links to
scoped **Operation status** controls and individual run details. Shared history supports local search and
expandable record type, recorded status and date filters. Unresolved operations, failed reads and
incomplete run records remain above the filters across all areas. Dates use local time; undated records,
including owner actions, remain included. A run ending, owner action or proposal vote does not establish
payment settlement. Operation status retains scoped URLs and links back to shared Activity.
Funding and policy are content-area utilities;
Guided walkthrough is under Help. Home keeps its real-funds entry under Guided walkthrough. Sweep is in
Balances & funding. Entry pages retain known limitations and expandable requirement evidence.
_Avoid_: entering a prototype or switching dashboards for navigation within the workspace.

**Executor**:
The one instance that sends, reconciles and serves invoices for an agent. Any other instance of the same
agent is **approve-only**: it reads and approves as the owner, and never sends.
_Avoid_: primary, leader

**Member**:
An account named in one of the owner DAO's group roles. Members may read the agent's private records;
public `Everyone` permissions and token-weighted roles do not establish private workspace membership.
For wallet-owned agents, only the owner account has access.

**Dashboard permissions**:
Per-agent capabilities derived from wallet ownership or the DAO's onchain policy, with no configured
operator list. For admitted DAO members, applicable Group and Everyone permissions combine. FunctionCall
proposal permission allows preparing requests; both FunctionCall proposal and approval permissions allow
execution controls under the existing signed policy and grant. Both policy proposal and approval permissions
allow local settings changes. These are application mappings, not proof of a passed DAO proposal.
Owner actions still require the owner's verified signature, obtained through the DAO's voting threshold
when it owns the agent. Historical records retain `operator` as the label for a manually triggered run.

**Machine credential**:
A revocable, expiring bearer credential bound to one Treasury workspace, signing host and provider
agent ID. Only an established wallet owner can issue one after fresh chain/provider ownership checks.
DAO machine delegation is refused until a verified DAO consent mechanism exists. Every request
requires fresh ownership evidence; failed reads, missing agents or changed identities refuse access.
The `read`, `prepare`, `execute-plan` and `sweep` scopes are independent and expose a limited procedure
list. They delegate access to the existing executor, not a new provider grant or an owner signature.
Execution uses the existing dispatch path. Secrets are returned once, stored only as hashes, and
stripped before forwarding. Private records and access attribution live in `.machine-auth/`.
New storage-version-2 records bind the agent ID; earlier experimental records remain listable and
revocable but cannot authenticate. No conversion of money state is needed. This is offline-tested
candidate behavior, not deployed.

**Treasury app (candidate)**:
Treasury acting as an app on the platform's `/apps/v1`, under the owner's signed consent (`read` + `treasury`
by default; `treasury-execute` only by the owner's explicit choice). Outside agents propose swaps through it, the owner
signs each proposal's exact terms in their wallet, and the owner executes it. Its relay (`app/treasury-app.ts`) records
each request before the platform sees it, resends only the identical request after a lost answer, relays only the
platform's exact approval text, and reads a lost execution back instead of retrying. Exit codes: 0 ok, 2 nothing sent,
3 unknown, 4 partial. It decides nothing about money; the platform enforces consent, terms, policy, grant and strategy.
Its own server (`app/server.ts`, `pnpm app`) signs the owner in with their wallet on the app's host, under its own
session cookie, because the platform host has no owner sign-in; it holds no money state and starts no executor.
The owner issues outside agents **agent tokens** (`tat_…`, `app/runtime-tokens.ts`): `read` and/or `propose`, bound
to this host, one Organization, one agent, its provider agent ID and the issuing owner, expiring in 60 s to 24 h and
revocable by that owner, stored only as hashes under `.app/tokens/`. No token executes anything. Every agent call
re-reads the agent's owner, provider ID and the app's live consent from the platform, and refuses if any changed or
the platform doesn't answer. The owner **connects** an agent in the app (`/app/connect`): the app builds the
consent text with the SDK's `consentMessage` (`read` + `treasury`; `treasury-execute` only when the owner ticks it;
1 to 90 days, default 30) for the platform's host, and submits only a text it prepared for that owner, within ten
minutes; with no answer, the same signed body can be sent again. The signed-in owner reads each proposal with the platform's exact approve and reject
texts and its signing host as the NEP-413 recipient (`/app/proposals`), relays the wallet's signature over one of them,
and presses Execute: one attempt, a lost answer read back. The page for this is web/'s second entry, `proposals.html`
(`web/src/proposals/`, its own root without the gateway's Shell), served at the app's `/`: it shows each swap and the
platform's text verbatim, has the wallet sign exactly that text for the platform's host, and asks for a confirmation
before Execute. After an execution with no answer, or one that answers unknown, it offers no Execute while the proposal
still reads `approved`: the platform re-quotes before it claims, so that state proves nothing. Its Agent tokens card
issues and revokes the outside agents' tokens, showing each secret once. Outside agents call the app runtime with those tokens. This is offline-tested candidate code;
no app deployment or hosted acceptance is established.

Resting limit orders additionally require the host capability `treasury-limit-orders-v1` and a separate
`treasury` + `treasury-orders` consent. Each order uses the SDK's exact owner signing text (or a DAO vote);
the app saves immutable create requests and durable one-attempt placement/cancellation claims. Resting,
partial fills and cancellation acceptance are not completion; only a closed fill with final completed payout is.
The app consumer uses the verified local 0.5.8 SDK alias, while legacy clients retain 0.4.0. This path is
offline-tested only; production provider order routes and live enforcement remain unverified.
See docs/limit-orders-consumer.md for state preservation and release gates.

Owner decision relays keep durable `decision-attempts/` records below `APP_STATE` as soon as a decision attempt is admitted, before its platform reads, approval or rejection. An unanswered decision, an in-flight relay, or a torn record remains poll-only across app and browser restarts. A `proposed` read does not prove an earlier decision stopped, and never releases a signing hold. Only a definitive, typed refusal can archive that attempt and permit another explicit signature; unknown replies, plain HTTP errors and successful decisions keep the claim. Preserve active claims and refusal archives across backup and rollback.

A lost definitive-refusal reply is not recovered by a generic unheld read. Without a receipt bound to the exact attempted decision, the browser remains poll-only and requires manual review of retained attempt evidence; clearing local storage or deleting a claim is not a recovery procedure.

**Portfolio**:
The historical product-facing label for the Treasury area in the shared workspace.
The standalone product uses **Treasury** in its default interface.
It covers allocations, rebalancing and strategy limits; the underlying treasury agent, purpose,
grant labels and routes retain their existing names.

## Mandate

**Policy**:
The owner-signed rules that the provider enforces: allowed actions, assets, caps, budget and destinations.
A policy is **in force** when it is applied, synchronized, not frozen, and bound to the agent's wallet.
_Avoid_: rules, config

**Mandate digest**:
The sha256 of a policy's canonical JSON, recorded with every plan and every money action.

**Grant**:
The owner's permission for this server to act for the agent, named by its **grant label**.
_Avoid_: token, credential (the grant token is only the secret that proves the grant)

**Grant label**:
What a grant is for, signed by the owner: `treasury`, `payout` or `invoices`, optionally followed by a
suffix such as a strategy digest (`treasury:<digest>`). Each purpose names the labels that may act for it.

**Purpose**:
Why a send or approval happens: `treasury`, `autopilot`, `payout`, `invoice` or `approval`. A purpose
decides which rules apply and which grant labels may act for it.
_Avoid_: kind, type

**Authorization**:
The single decision of whether a send or approval, with a given purpose, may go ahead, covering what
the provider can't check itself. It decides; it never fetches, sends or records.
_Avoid_: guard, gate, check

**Agreed payee**:
A recipient listed as a confidential transfer destination in a policy whose destinations mode is
`only`. A policy in `except` mode has no agreed payees.
_Avoid_: allowlisted address, destination

**Agreement**:
An owner's consent to pay a payee, with **terms**: an amount ceiling per invoice and a deadline. A payee
*requests* one from the invoice page (an **agreement request**), or the owner *offers* one first (a
purchase order, a bounty or grant award). Agreeing makes the payee an agreed payee by policy update;
the terms are this server's record, shown beside each held payout, and enforced by the vote on it.
_Avoid_: whitelist entry, PO (unless it is one)

**Strategy**:
The owner's target allocation and limits for a treasury agent. The autopilot acts only while its live
grant's label carries the digest of the strategy in force.

**Plan**:
A saved, expiring list of swaps and shields, bound to the policy and strategy it was made under.

**External plan**:
An authorized outside agent's chosen swaps, quoted and saved by Treasury through `externalPlan`.
The outside agent supplies decisions, not routes, signatures or provider credentials. Preparation
moves no funds and refuses the complete plan if its quotes, cost, feasibility or observed mandate
checks fail. Saved plans record `source: external` and use the existing expiry, strategy/policy binding,
execution claim and dispatch path. Existing source labels remain readable without conversion.
This uses Treasury plan-execution authority; the scheduled autopilot's auto-execute ceiling does not
apply and there is no separate per-client budget. Offline-tested through the packaged Treasury skill;
not deployed. Provider concurrency guarantees remain unverified.

**Rebalance**:
Planning swaps toward the strategy's target allocation: legs under its minimum are left alone, legs that
could cost more than its cap at their floor are left out, and the rest are saved as a plan. Nothing moves
until the plan is executed.

**Steward**:
An experimental LLM that proposes a plan in conversation, its responses verified against its TEE. It only
proposes; the plan executes like any other. It is retained for demos at `/a/<agent-name>/steward`
(or `/steward` on a standalone server), hidden from navigation.

## Money actions

**Operation**:
One money action in the agent's log, identified by its idempotency key from the write-ahead record
through its outcome. New non-invoice operations record preparation and then a durable submission
claim before the provider call. A preparation without a claim proves it was never submitted; a claim
without an outcome remains unresolved. Legacy records without this distinction remain unresolved.
Internal provider-verification withdrawals use the same journal and dispatch path. Their approval
verifies declared source terms; it does not establish exact recipient receipt or final-artifact
binding. This verification work adds no product payout flow; see `docs/provider-acceptance.md`.
_Avoid_: transaction, job

**Unresolved operation**:
An operation without a proven outcome that blocks new sends: any but a held payout or a prepared
invoice, which are open but can't be lost. While one exists, no new operation may be sent.
_Avoid_: pending, stuck

**Held payout**:
A payout the provider holds for the owner's approval. Its outcome is open, but it can't be lost, so it
does not block new sends.
_Avoid_: pending approval (as a noun)

**Refusal**:
A proven outcome that nothing was sent, recorded with a code.

**Sweep**:
Shielding the managed USDC, wNEAR and ETH public balances into their confidential balances. Other assets are not included.

**Money lock**:
The lock every money action runs under: one money-moving run at a time across this host's processes,
refused while an unresolved operation exists. It is single-host, not distributed fencing.

**Owner intent**:
An owner action (create, grant, freeze, policy update, approval vote) prepared by the server and signed
by the owner's wallet or a DAO vote, kept `prepared → submitted → settled` so a restart follows it.

**Invoice**:
A payee's request to be paid, which becomes one payout operation with a stable key and immutable terms. Until it is
submitted it is **prepared**: nothing is in flight, so it is not an unresolved operation.

## Autopilot and records

**Autopilot**:
The treasury agent acting on its own schedule, off by default: each **tick** reads the status of open
operations, sweeps, and executes a rebalance whose preview fits the strategy's auto-execute limit.
Each planned swap also requires fresh valuation and must keep the plan's gross submitted swap value
within that limit; shields are excluded from the sum. These are local checks using observed prices,
as described in `docs/enforcement.md`. A tick whose
start can't be recorded does not run; a missing end means it was interrupted or its outcome is unknown.
_Avoid_: bot, cron job

**Tick**:
One autopilot run: sweep, then rebalance if the strategy's grant approves it and the plan fits the
limit. Scheduled on the strategy's interval, counted from the latest recorded `run` summary in the
inbox, or started manually by an account with execution permission. That summary is written before the final after-observation and evidence
end; it is not proof that the tick or its operations settled. Each records a start and an end in the evidence. New ticks also record intermediate stage
starts/returns and provider-accepted submissions in a supplementary progress file. These observations
never authorize a send or establish settlement; older ticks have no reconstructed stages.

**Run log / Recording**:
A private, versioned projection of a tick's recorded observations into AG-UI events. It preserves the
tick's outcome separately from later journal observations. Missing timing stays unknown; a recorded
tick end does not prove every operation settled. It never authorizes a money action. The adapter is
offline-tested. Members can export a recording from its executor and inspect its recorded observations
in the dashboard. New exports use envelope version 3 and declare AG-UI protocol 1.0. A recorded end
with an unclosed stage or an explicitly failed run emits `RUN_ERROR`; a missing end stays open.
Older version 1/2 recordings remain readable without rewriting their events. The inspector is read-only,
with no timed playback or live stream; it keeps source
gaps, unknown timing and later observations explicit. The inspector and export access controls are
tested offline, not mainnet-observed.

**Public overview**:
The default Treasury landing page is a static explanation of delegated rebalancing with requirement stages from the canonical inventory. The inherited shared presentation explains Payables and Portfolio only when explicitly selected for compatibility.
It reads no agent records, shows no private evidence and submits no money actions. Earlier example-page
hashes open the corresponding area's overview. It requires no wallet and never mounts the authenticated
dashboard or its reads. Simulated approval, execution and playback are retired.

**Guided Treasury run**:
The operational guided run at `/a/<agent>/demo` for a treasury agent, in every build: readiness checks,
the rebalance preview and its explicit execution, and the confirmed plan's outcome, with links to strategy
and grant, policy and owner-action review. Steps mark nothing complete, and the readiness checks authorize
nothing. The followed plan is the exact one confirmed, kept in the page address like Home's; reloading
reopens it and submits nothing. Explanatory walkthrough chapters belong to Proto's showcase, which links
here.

**Guided walkthrough (historical shared interface)**:
The retained guided walkthrough for the payout agent in the shared build, using the agent's actual balances, policy and
grant. It reuses the existing payment controls, including their explicit confirmations
and owner approvals. Treasury agents use the guided Treasury run. Its prerequisite observations do not authorize a send. Outcomes come from
operation and payment records selected by the exact confirmed plan or returned payment identity;
a walkthrough can finish without a swap, wait for approval, be refused, or leave an unresolved
operation. Opening or reloading it submits nothing. Reload clears the local selection, and existing
records remain accessible through Payments and Activity.

**Inbox**:
What the agent tells its owner while no one is watching: a record of each tick, and warnings or
requests that stay open until the owner dismisses them.

**Books**:
The agent's balances checked against outside records: public balances against chain transfers,
confidential balances against the API's recorded executions. A difference is unexplained: it can reflect
outside credits or incomplete records.

**Intervention**:
A hosted dashboard call classified by the gateway's intervention list, recorded before it runs
(or not run). The unattended-run report counts them. The existing record format and historical
classification are retained when dashboard permissions change.

## Treasury interface

**Canonical Treasury host**: One gateway can accept both Treasury and its explicitly configured
legacy page host. The legacy host redirects GET/HEAD page visits to the canonical HTTPS host with
the path and query preserved. Sign-in and API requests and all other methods on the legacy host
are refused, never forwarded or replayed. Health reads remain available on both. Sessions stay
host-local; the owner signs in at the canonical host. This routing is offline-tested and not deployed.

**Reference Treasury frontend (candidate)**: The focused Treasury assets can be served by the
shared gateway for its existing DAO Treasury, under a separately reviewed host assignment.
The wallet Treasury retains its own host, onboarding, registry and executor. Sharing frontend
assets does not share sessions, authority or state, or start another executor. The integration
is offline-tested against the evolving Proto candidate, not deployed.

A manually confirmed plan stays selected on the overview while its exact operation records are
followed. The last successful budget observation before confirmation is retained beside subsequent
provider observations. Neither the difference nor a returned execution stream establishes settlement,
plan-specific charges or atomic budget accounting. A changed policy prevents headroom comparison;
failed reads remain unavailable. The page address keeps the confirmed plan's identifier, so a reload
reopens the same plan's retained operations without replaying execution. The pre-confirmation budget
observation is not retained after reload; the reopened view shows only later observations. The address
is not a durable money record and selects nothing when malformed. **Stop following this plan** removes the identifier and closes
the view; it cancels nothing, and the plan's operations stay in Activity. Signed monthly caps and each USD budget window are shown together;
recorded refusal codes are read on demand, never produced by a live probe.

**Frontend release manifest**: The `contract.json` shipped with the default build. It names the
Proto platform capabilities (P2 manifest v1, from `@multiagency/sdk`) that the build's
calls need, so Proto can refuse to serve an incompatible release. It grants no authority.
`pnpm check:frontend` checks it against the build's actual module graph. The shared Payables and
Portfolio surface enters only through the `@legacy` build seam and is absent from this build.

**Owner contract client**: The web app's client over Proto's `ownerClient` (`web/src/shared/client.ts`).
A failure's kind, not its message, decides recovery:
- `unresolved` or `busy`: refused before sending; the UI points to the operations to follow.
- `refused` or `provider`: refused, with the reported reason. A provider failure after a send counts as
  `provider` only when the provider proves it a refusal; otherwise it is `unknown`.
- `unavailable`: a read failed; reading again is safe.
- `unknown`: a mutation or stream may have taken effect. Its records are re-read and nothing is
  resent. A lost plan preview may have saved a plan that expires unused.

The signed-in account is re-read when the tab becomes visible again and when another tab of this host
signs in or out. While it is being re-read, no permission-dependent control is offered.

The price-freshness and budget-window display rules are app-owned copies, kept equal to the
backend's by a parity test while the copied backend remains. Offline-tested; not deployed.

The signed-in Treasury header shows the owner from the existing setup observation, including the
DAO’s proposal route when applicable. This identity is separate from the connected wallet and is
absent from the public entry. It adds no read or authorization decision.

The default web build presents brief 02 on one Treasury screen: allocations, signed monthly caps, budget headroom, quoted rebalancing, targets and schedule, and confidential sweep. It reuses the existing agent-scoped server controls. The presentation flag does not restrict server permissions or start another executor. Public copy contains no private observations. Exact public-payout unshielding remains outside the implemented behavior. This cleanup has not been deployed. The historical two-area UI requires explicit `PUBLIC_TREASURY_ONLY=false` for compatibility tests.

**Registered treasury workspace**: An optional self-service gateway entry for one owner, before or after its Agent API agent is created. Wallet registration is bound to the signed-in NEAR account. Sputnik DAO registration requires a group member with permission to propose owner actions. Registration creates no provider intent and signs nothing. The existing owner-intent flow creates the agent after explicit wallet signing or DAO approval. Each workspace keeps its settings and all state in its own directory under `.treasuries/`; the gateway registry is additional private state. One treasury workspace per owner, with at most 16 on this prototype host. Schedules start off. This is offline-tested candidate behavior, not deployed.
