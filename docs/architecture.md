# Architecture

This repository focuses on Treasury and retains compatible idea-1 and idea-3 code. The
[domain mapping](scope.md#domain-to-responsibility-mapping) is authoritative for destination
responsibilities and distinguishes intended topology from current source and historical deployment.
Proto remains the three-idea showcase; it is not a canonical-host alias for Treasury.

Two areas, Payables and Treasury, share one core. Each agent runs in its own instance of the server (`src/server.ts`),
with its own wallet, grant, money lock and logs; the hosted gateway signs members in and forwards
their calls to those instances. Files are listed under `src/` unless a path says otherwise.

## The one rule

**One send site.** Every money action, whichever area starts it, goes through `dispatch` in
`agent.ts`: under the money lock, with no unresolved operation, a write-ahead record, `authorize`, then
the provider call. `test/send-path.test.ts` fails if any other file sends. The callers are
`invoices.ts` (an invoice's payment), `treasury.ts` and `plans.ts` (shields, swaps, sweeps) and
`agent.ts`'s own `pay` (a payment by hand).

## Shared core

`src/router.ts` composes `rpc/owner.ts`, `rpc/payables.ts`, `rpc/treasury.ts` and
`rpc/observations.ts`. Shared transport error handling lives in `rpc/base.ts`; shared input schemas
live in `rpc/inputs.ts`. This extraction retains procedure paths, gateway access classifications and
existing domain calls. Submission remains centralized in dispatch.

| Concern | Files |
|---|---|
| Sending | `agent.ts` (dispatch), `authorize.ts` (checks the provider can't make; pure), `lock.ts`, `executor-lease.ts`, `executor-lifecycle.ts` |
| Records | `ops.ts` (the operation journal), `recover.ts`, `reconcile.ts`, `synced.ts`, `evidence.ts`, `inbox.ts` |
| The owner's rules | `policy.ts`, `mandate.ts` (the digest), `grants.ts`, `owner-intents.ts`, `owner-requests.ts`, `owner.ts`, `dao-owner.ts`, `chain.ts`; `../shared/nep413.ts` |
| Provider and values | `api.ts`, `holdings.ts`, `value.ts`, `ledger.ts` |
| Serving | `server.ts`, `router.ts`, `env.ts`, `notify.ts`; `../shared/http.ts`, `../shared/signin.ts` |
| Shared with the Treasury app (`shared/`, outside the retiring `src/`) | `http.ts`, `nep413.ts`, `signin.ts`, `near.ts` (the mainnet RPC config) |

## Confidential Treasury Facilitator (the payout agent)

| Concern | Files |
|---|---|
| Intake | `invoice-http.ts` (public routes, `/internal/agreements`), `invoice-page.ts` (HTML and copy), `invoice-browser.js` (checked browser module), `agreements.ts` (requests, offers, terms), `invoices-server.ts` |
| Payments | `invoices.ts` (files an invoice through dispatch), `invoice-store.ts` (SQLite: identity, revisions, reservations), `payouts.ts` (held payouts) |
| Approval | `payment-approval.ts` (checks a held payout against provider evidence before the owner signs) |

## Agentic Treasury Management (the treasury agent)

| Concern | Files |
|---|---|
| Planning | `treasury.ts` (rebalance legs, quotes, sweep), `planning/` (plan model, checks, storage, observations and execution; `plans.ts` retains compatibility exports), `strategy.ts`, `strategy-digest.ts` |
| Running alone | `autopilot.ts` (the scheduled tick: sweep, then rebalance within its limit) |
| Experimental | `llm.ts` (the steward, reached only at `/steward`) |

## Around them

- **Gateway** (`gateway/`): sign-in decided per agent from its owner (`roles.ts`): a DAO's roles, or the
  owner account itself; which calls each role may
  make (`allowlist.ts`), and, for members, proposal decoding for "What am I voting on?" (`proposals.ts`, `sign-requests.ts`).
- **Web** (`web/src/`): one app for both areas. `format.ts` `kindOf` uses the configured area, with a policy-based fallback for legacy instances; `beats.ts` holds each area's briefs, requirements and stages; `showcase.tsx` shows
  them. `timeline-payment.tsx` and `timeline-run.tsx` follow one held payment or the latest autopilot
  run step by step, each step read from its own record; they show data only on the instance that holds
  those records (approvals filed there, evidence its executor wrote).
- **Command line**: `create-agent.ts`, `issue-grant.ts`, `revoke-grant.ts`, `update-policy.ts`,
  `archive.ts`, `inspect.ts`, `books.ts`, `smoke.ts`, `run-report.ts`, `report.ts`, `remote.ts`.

Planning is grouped under `src/planning/`: `model.ts` defines the saved contract, `checks.ts` is pure,
`store.ts` preserves the existing `.plans/` format and claims, `observation.ts` reads current facts,
and `execution.ts` coordinates execution. Treasury previews import storage and observations directly,
so planning and execution no longer form a runtime import cycle. `src/plans.ts` keeps existing imports
compatible. The source digest changes with this extraction; state paths, saved plan digests and the
single send site do not. Existing execution/recovery tests and `test/planning-boundaries.test.ts`
cover this locally; it does not establish new mainnet behavior.
Other domain-wide file moves remain separate changes because they touch nearly every import.

## How the money path stays safe on one host

The provider enforces the signed policy; what that guarantees is in [enforcement](enforcement.md). This
is what the server adds around it.

### Sends, journal and recovery

New money actions recheck lock ownership and unresolved operations after
preflight. This closes the reproduced preflight lock-loss scenario; ownership loss during an
in-flight send remains a single-host residual risk, not a distributed fencing guarantee.

Owner intents persist `prepared → submitted → settled` in a private per-instance file. Updates take
an inter-process lock and reload the file before modification, so concurrent preparation and settlement
preserve each other's records. `submitted` means submission was attempted, not proven accepted.
Own and peer readers refuse malformed lifecycle states or an unsigned preparation containing a
retained signature or outcome; those records need verified recovery, not another submission.
The local reader refuses settled records without a recognized terminal outcome. Peer records with
incomplete settlement evidence continue blocking another delegate preparation.
A browser wallet's signature is relayed only if it is the owner's key, as the API names it, over exactly
the prepared intent: the NEP-413 message, or a NEP-366 delegate action from the owner's account calling
exactly the prepared methods, arguments, gas and deposits (`src/owner-signature.ts`). The wallet's own
code loads from outside this repo, so this doesn't rest on the API's check. Offline-tested, and passed
by a browser wallet's delegate action and message signature on mainnet (2026-10-13, mainnet log); a
tampered signature hasn't been seen live. A wallet that adds a `callbackUrl` to a NEP-413 signature is
refused, safe but possibly too strict for some wallets. A DAO's signature is found on chain and
verified against the prepared hash (`findSignature` in `src/dao-owner.ts`) before it is submitted.
Approval signatures are poll-only after an attempt. For other owner actions, the existing recovery
flow can resend the saved signature only while the API reports `PENDING_SIGNATURE` and the signing
window remains open. Settled results remain available after restart. Records deleted by older versions
cannot be reconstructed locally. This is single-host coordination, not distributed fencing.

The agent's executor runs status-only reconciliation every 10 seconds (an `EXECUTOR=off` instance doesn't), independently of strategy execution.
Startup and successful onboarding use one activation path: acquire the single-host executor lease
before publishing a new agent identity, then start the background loops once. Failed ownership
acquisition leaves the original creation action available for recovery without signing again.
Approve-only activation also binds one identity; shutdown prevents a late lease acquisition from
publishing an identity or starting background loops.
`pnpm reconcile --poll` performs one pass. Unknown IDs, failed reads, `UNCERTAIN`, and `NEEDS_REVIEW`
remain unresolved. Nothing is resent: provider deduplication and lookup semantics remain unverified.

Plans simulate cumulative swaps and shields using guaranteed output floors, then recheck remaining
feasibility between legs. Policy, strategy digest, cost ceiling, and expiry are checked after
asynchronous preflight before each send, including a swap following an automatic shield.
These recovery and execution checks are offline fault-tested; they are not mainnet-validated.

New non-invoice operations use journal v2: a durable preparation followed by a durable submission
claim before the provider call. On the next money-lock acquisition, an unclaimed preparation is
resolved as `never_submitted`. Claimed operations without an outcome and ambiguous legacy records
remain blocked. Invoice preparation keeps its existing SQLite lifecycle. Before upgrading, follow the
[stopped-writer migration](operations.md#journal-v2-and-owner-intent-locking-upgrade).

### Checks before each send

Every money submission (invoice, dashboard, CLI, autopilot) goes through one dispatch: under the
money lock, with no earlier operation of unknown outcome, written ahead to the log before it is sent.
Policy enforcement is delegated to the Agent API and OutLayer, with the evidence and limitations
listed in the [enforcement assessment](enforcement.md). Provider refusals are recorded.
Dispatch also refuses locally, recording why, what the provider can't see or check
(`src/authorize.ts`): a policy that is frozen, unapplied or unsynchronized; no live grant; a grant for
another purpose (the autopilot's must carry its strategy's digest); a swap into an asset the policy
doesn't list (the provider checks only the asset spent); a payout that isn't a confidential USDC
transfer, repeats one already held, or that the wallet can't cover (the provider would hold it for a
vote and fail it after); an invoice under a policy that doesn't hold it for the owner;
and a plan's send once its plan, strategy or policy changed, its valuation is unavailable, or its swap
costs more than the strategy allows. Autopilot also refuses a swap that would exceed the plan's
cumulative ceiling at observed submission-time values. Prior submitted swaps come from the existing
journal under the money lock; shields do not count and missing values do not become zero. These
checks add no persisted counter or new state format. Status reconciliation uses no grant and can
discover settlement after revocation.

A held, never-submitted invoice retains its key, can be revalidated by submitting
the original form, and never blocks other money actions; an attempted submission whose outcome is
unknown still does. Changed invoice content requires review.

Owner approval is verified from the provider's own evidence, so any instance of the agent can
approve, including an approve-only one (`EXECUTOR=off`) that never saw the payment sent. The
approval and the held execution must name each other and this agent's wallet; the approval must be
a confidential transfer whose `{to, token, amount}` hash to the provider's `request_hash` (the wallet
provider's canonical operation), to a payee, asset and amount within the applied policy (destinations,
assets, per-transaction cap, owner approval on). If this instance recorded the payment, it must match
that record and any invoice behind it must be unrevised. Incomplete or unsupported provider terms are
refused, never trusted. Preparation binds the approval ID, request hash, correlation ID, policy digest
and invoice revision; the checks run again immediately before submitting a wallet or DAO signature, and
a changed term or policy invalidates the approval. Approving needs the owner's signature, not this
instance's grant. Rejection needs only the identity checks. An attempted approval signature is
poll-only after restart or an ambiguous response, never automatically resubmitted.

These checks trust the Agent API's identity, policy and balance responses; their local observation
age is not an independent proof of chain-state freshness. A policy or revocation can change after the
final read, so the provider's own enforcement stays the boundary. The local authorization path does
not reject a policy merely because it has a provider timelock, and it does not inspect the provider's
scheduled-execution queue. Provider release-time checks remain unverified; no local hold on all
delayed execution is claimed.

### Invoice storage

Anyone signs in with a full-access NEAR wallet key and files an amount and optional note for their
own account. An agreed payee's filing is an invoice; anyone else's is an agreement request, stored apart
from payments (`.agreements/`, `src/agreements.ts`) and never sent. Sign-in uses near-connect's wallet list pinned to one reviewed
commit (`WALLET_MANIFEST` in `src/invoice-page.ts`). Residual supply-chain risk: each wallet's code
still loads from the URL that list names, mostly `raw.githubusercontent.com`, which its maintainers
can change; the page also allows inline and `https:` scripts because wallets run as inline code in
sandboxed frames that inherit its policy. Wallets can't read the session, and every signature is
verified server-side, so the remaining risk is a wallet that phishes for keys. The provider payout policy must still require owner
approval and confidential transfers. Invoice and dashboard commands share the same execution path.

Before a payment can be sent, `.invoices/<agent>.sqlite` atomically stores the submission identity,
initial revision, exact payment request, stable idempotency key and reservation. A second transaction
marks submission attempted before network I/O. A crash after that point is ambiguous even when the
network call may never have started. Missing correlation IDs, failed reads and uncertain outcomes
never authorize another send. Reconciliation polls known operation IDs and never resends: **ambiguous
replay is not possible**.

Retries of the same form retain the same payment identity. Changed amount/note contents are retained
as revisions requiring review; they never modify an existing payment or create a second attempt.
The browser retains its pending form ID across reloads. A genuinely new form is a new business
occurrence; there is no semantic duplicate-invoice detector. Payments shows invoice revisions, operation IDs
and reserved amounts. Accounts with execution or settings permission may cancel a payment only when its durable state proves submission
never began. A held/unknown payment retains its reservation until a proven terminal outcome. These
reservations are records of encumbrances, not yet a full available-cash or liquidity-control engine.

Before upgrading an existing payout executor, follow the
[invoice migration instructions](operations.md#invoice-migration-and-deployment).

SQLite provides local atomicity, not exactly-once remote payment execution. These paths are covered
by offline concurrency, HTTP authorization and process-crash tests, and the flow ran on mainnet on
2026-10-12 ([mainnet log](mainnet-log.md)).

## Dashboard access (offline-tested)

The gateway verifies the connected account and the requested agent's owner. Wallet-owned agents admit
only that owner. DAO-owned agents admit accounts explicitly named in a Group role; `Everyone` and
token-weighted Member roles do not establish private workspace membership. After admission, applicable
Group and Everyone permissions combine, independent of role names. Exact kind/action permissions and
Sputnik's four wildcard forms are interpreted per
[contract source at 5434a59](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/policy.rs).
This is a source comparison, not verification of the deployed DAO contract version.

`src/gateway/roles.ts` derives five per-agent capabilities. The gateway and frontend use the same pure
`mayCall` table in `src/gateway/allowlist.ts`; an unknown procedure is refused even to a wallet owner.
No configured account or role name can override ownership or membership.

| Capability | Wallet owner | DAO group member |
| --- | --- | --- |
| Sign owner intent | Yes | No; the DAO supplies its signature after approval |
| Propose FunctionCall | Not applicable | `call:AddProposal` |
| Vote to approve FunctionCall | Not applicable | `call:VoteApprove` |
| Trigger execution | Yes | Both FunctionCall proposal and approval permissions |
| Change local settings | Yes | Both `policy:AddProposal` and `policy:VoteApprove` |

Execution and settings capabilities are conservative application mappings from those permissions,
not contract actions or evidence that a voting threshold was met. Proposal-only and vote-only members
cannot trigger direct execution. Existing policy, grant, reviewed-plan, executor and dispatch checks
still apply to every money action. Owner policy/grant changes and held-payout decisions still require
verified owner signatures; a member's vote alone cannot satisfy that requirement.

Members may read private records. Preparing an owner action, agreement terms, funding transaction or
plan requires the wallet owner or FunctionCall proposal permission. Saving a strategy requires settings
permission; it stops the schedule and does not authorize the new strategy. Enabling a saved, authorized
strategy requires execution permission. Stopping scheduling and reconciling existing operations allow
either execution or settings permission. The legacy combined schedule route requires both. Wallet
signature submission is available only to the owner wallet; DAO signatures follow the existing server
observation path. `ownerIdentity` is an internal gateway read, unavailable through browser RPC.

Permissions remain per agent. Shared pages have no combined workspace authority. Permission loss
disables action controls; a strategy confirmation stays invalid until reviewed again. Session and
agent-access denials hide private data. The existing intervention
classification and JSONL format remain readable; changing permissions creates no state migration.

## Frontend responsibilities (offline-tested)

Frontend infrastructure is separated into `client.ts`, `queries.ts`, `format.ts` and `action-hooks.ts`;
`lib.ts` retains compatibility exports. Query factories accept an explicit client and cache scope.
Local agent documents keep their existing keys; Home keeps its fleet namespace. Agent switching
still loads a new document. `workspace-observations.ts` owns fleet observations, `proposals.tsx`
presents proposals, and `attention.ts` supplies shared agreement and grant destinations. Each status
badge requires only its own observations; failed attention sources remain explicit alongside known items.

`agent-context.ts` has no shell dependency. Payment details, retained Activity and run records have
recovery views while setup or overview is loading or has failed. Treasury-link reads are limited to pages using them and
do not gate the shell. The private `instance` read returns configured identity and executor mode
without provider calls. Combined with gateway permissions, it exposes schedule stopping during
provider failures; the gateway requires execution or settings permission, and approve-only instances
still refuse the control. Offline fixtures in
`test/browser/task-loading.cjs` reproduce failed and indefinitely pending setup, overview and treasury-link reads.

`read-failure.tsx` distinguishes failed initial reads from failed refreshes. Activity and shared
workspace history retain previously loaded records with their read time; empty cached lists never
establish a current absence during failure. The payment recovery view labels cached outcomes as
last reported, and unavailable unresolved-operation reads retain references without recovery controls.
Schedule recovery explains permission and executor restrictions. `test/browser/failure-states.cjs`
checks retained records, open evidence, explicit retries and permission explanations offline.

Scoped Activity presents operation checks as **Operation status**, with a next step for each
reported outcome. A provider `FAILED` result does not establish that a replacement payment is safe.
Owner-action records remain visible after an ordinary read failure, marked with their last successful
read time, and are hidden on access denial. Explicit refreshes preserve keyboard focus and open record
details. `test/browser/recovery-clarity.cjs` checks these behaviors at mobile and desktop widths using
intercepted requests; the controls only read existing records or invoke status reconciliation.

The Policy page separates policy and current-grant observations from allowed actions, owner controls
and revision evidence. `policy-observations.tsx` presents the server's policy check without combining
it with grant liveness into authorization. Approve-only instances do not claim to hold a grant token.
Missing revision evidence stays explicit in `policy-evidence.tsx`; grant controls retain their existing
signing behavior. `test/browser/policy-clarity.cjs` checks these presentation boundaries offline.

`setup-progress.tsx` reads recorded owner actions before onboarding offers agent creation. An unfinished
creation, a succeeded creation awaiting setup readback, or unavailable records keeps that button
disabled. Its refresh reads setup and owner records without signing or submitting. Returning owners
without a reported grant first see unfinished setup actions, then a policy, Payables grant or Strategy
destination based on available observations. Records cover this instance only; funding requests made
through wallets or Trezu still need review there. `test/browser/setup.cjs` checks these
paths on mobile and desktop with offline fixtures.

Owner action preparation exposes its correlation ID and a durable Activity link. Component-owned
status observation in `owner-observation.ts` stops on unmount; server recovery remains independent.
Returning to Activity reads durable records. Approval success is displayed separately from payment
settlement, and missing evidence retains existing retry restrictions.

`main.tsx` lazy-loads the authenticated application and legacy public overview routes at their entry
decisions. Public explanations use the canonical summaries without mounting authenticated reads.
The production build places these applications in asynchronous chunks; this is a bundle-boundary
check, not a measured startup improvement or deployed observation.


The locally prepared signed-in frontend shares a flat desktop navigation rail and mobile navigation drawer
with Home, Payables, Portfolio and Activity (`web/src/app/workspace.tsx`). The gateway's accessible-agent list determines
which areas appear; permissions remain agent-scoped. Area navigation loads the existing `/a/<agent>/`
URL as a new document, preserving the existing client/cache isolation and draft unload warnings.
The shell, sibling controls and invoice links share one cached `/gw/me` session response. A refreshed
permission applies to every consumer together. Shared pages display the connected identity without
combining permissions from different agents into a workspace-wide role; an agent page uses only that
agent's access. Explicit denials still hide private observations immediately, including late responses.
Scoped RPC requests verify access to their target agent only; an unrelated agent's ownership lookup
cannot block them. Fleet discovery still resolves all configured agents. The gateway verifies the
reported owner through `ownerIdentity`, which reads provider ownership without the grant adoption
or funding observations performed by setup. Cold ownership failures deny access. A transport failure
can retain the last verified owner; a malformed successful response clears that evidence and denies
access. `test/gateway-access.test.ts` and `test/setup-gateway.test.ts` cover these boundaries offline.
The shared Home shows independent attention checks, agreement requests, open proposals and compact status;
its real-funds guide is inside a Guided walkthrough disclosure. Activity groups all returned money,
owner-action and Treasury run records by agent, plus DAO-wide proposals. `features/workspace/history.tsx`
provides local search, area, record-type, namespaced status and inclusive local-date filters over the
returned records. Owner actions have no recorded timestamp; undated records remain included. The
unresolved query, failed reads and incomplete-run warnings remain above all filters, including area.
No filter derives dispatch blockers or equates owner/run/proposal outcomes with payment settlement.
Neither view aggregates balances or authorizes money actions. Failed reads remain explicit and one failed
agent does not hide another. `features/workspace/activity.tsx` uses per-agent clients and query keys;
run summaries link to scoped `/follow/run` details without repeating operation lists. Missing-end and
unreadable-record warnings remain visible outside the run-history disclosure. Books and ledger exports
are requested only by their own controls. Recovery links retain the existing
agent-scoped routes and permissions, labeled Operation status, with a return to shared Activity.
`test/activity-filters.test.ts` covers date and status distinctions; `test/browser/workspace-activity.cjs`
checks filtering with retained warnings, agent isolation, deep links and access revocation.
Pending workspace ledger exports abort on access denial or unmount, and check cancellation again
before creating a download. `test/browser/workspace-activity.cjs` covers full returned histories,
agent isolation, retained read failures and delayed exports after denial with offline fixtures.
Area task names come from `web/src/app/navigation.ts`: Payments and Agreements for Payables, Overview
and Strategy for Portfolio. These appear in content navigation, separate from the workspace rail.
Funding and policy/grants are content-area utilities; Guided walkthrough is under Help. Run details and Run now
remain reachable from Overview and Strategy, while returned run history is in shared Activity.
Existing URLs remain unchanged. Compact payment rows
link to the existing detail route; only the selected record mounts live payment-status reads and
approval controls. Home attention items link to that same identity.
`features/payables/payment-queue.ts` filters already-read summaries into Needs review and All records,
with local recipient/reference search. Review includes held payouts, changed/prepared invoices, owner
recovery and missing or conflicting outcomes; owner approval alone never removes a record from review.
The projection keeps local invoice and operation identities separate from provider payment references.
Read failures and incomplete coverage remain visible outside the filtered list. It does not authorize
an action or add per-row status reads.
The standalone local-agent layout and signed-out example routes remain separate.
`test/browser/workspace.cjs` checks navigation, recovery access, filtering and absence of mutation
calls at 320px, 390px and 1280px with intercepted requests. This is local, offline-tested behavior;
the shared workspace has not been verified on a deployed host.

The run view and recording inspector share a read-only projection of the existing, validated AG-UI
events (`features/evidence/recording-model.ts` and `recorded-progress.tsx`). Each observed stage has
one row with its recorded start and optional return. Submissions stay independent because the source
does not associate them with a stage; overlapping stages do not create an inferred association.
A recorded run end never supplies a missing return or proves settlement. Older recordings have no
reconstructed stages. The inspector keeps individual observations behind a disclosure, with source
gaps and later journal observations retained separately. The run page groups outcome, stages and later
observations in one timeline, with its receipt, inspector and polling controls under Run details.
Unit and offline browser fixtures cover these presentation rules. New exports use envelope version 3
and declare AG-UI protocol 1.0; lifecycle validation rejects a finished run with open stages.
An observed run failure or a recorded end with missing stage returns emits RUN_ERROR without
inventing returns. Legacy versions 1/2 remain readable. This adds no event transport or authorization rule.

`/a/<agent>/demo` is the guided run. For a treasury agent, in every build, it is
`features/run/treasury-run.tsx`: readiness checks, the rebalance preview and explicit execution, and the
confirmed plan's `PlanOutcome`, with links to the strategy, policy and owner-action screens. It follows the
plan through the same `useFollowedPlan` page-address binding as Home, so a reload reopens that exact plan
without resending. Stable deep links for other apps, each landing on its real control:
`/demo#check`, `/demo#preview`, `/demo?plan=<id>#outcome`, `/#rebalance`, `/automations` (strategy save
and authorization), `/policy` and `/policy#grants`, and `/activity#owner-actions`. The shell reveals a
link's `#id` once its element renders (`app/hash-target.ts`). `test/browser/treasury-run.cjs` checks the
run and every deep link on the Treasury build. The readiness checks (`features/run/run-checks.tsx`) are shared with the payout agent's
walkthrough, which exists only in the shared build.

`features/demo/live-demo.tsx` composes the payout agent's guided walkthrough, reached from
Home's Guided walkthrough disclosure or Help → Guided walkthrough in the area. It reads the current agent's observations and reuses the
existing manual payment review, configured invoice link and payment
discovery components. Prerequisite observations do not authorize actions; failed observations keep
the guide's local submission controls unavailable while recorded outcomes remain reachable. Approve-only payout instances
direct invoice submission to the configured service. Explicit confirmations and required owner approval
remain in the existing controls; no mutation runs on entry or reload. A non-refused
payment response selects its returned identity using the existing payment detail component. The guide
never selects the newest record as a substitute; reload clears this local selection. Earlier records
remain discoverable through Payments and Activity. The guide creates no server records, RPC procedures or state formats of
its own. `test/browser/live-demo.cjs` checks these paths with intercepted requests; no deployed or
mainnet behavior is inferred from those fixtures.

The workspace attention summary owns fleet reads once; incomplete checks and retry controls appear
there without repeating them in the compact status section. Treasury grant warnings link directly to
Strategy; an unknown area retains the Policy destination. Activity describes recorded operations,
including refusals, without implying every record was submitted. Local invoices join payment discovery
on Payments; invoice-only records never turn invoice IDs or idempotency keys into provider correlation
IDs. Full references remain available in disclosures. Activity loads Books only when “Compare balances
with records” is opened.
When setup confirms an executor and the account may stop scheduling, an unrelated overview failure leaves the existing schedule
stop control accessible alongside Activity recovery. These presentation boundaries are checked with
intercepted requests in `test/browser/decision-clarity.cjs`; no deployed behavior is inferred.

The invoice listener serves the page and its browser module from the same origin. The browser
module owns drafts, refresh ordering and DOM updates; TypeScript checks its JSDoc types during
`pnpm typecheck`. It is served as JavaScript without another build step. The browser regression
loads the complete page renderer and module with mocked API and wallet responses; the HTTP test
checks that the listener serves both resources. Neither test extracts functions from source comments.
Sign-out and an explicit session-access denial clear private rows, invalidate outstanding status reads,
stop polling, and restore keyboard focus to sign-in (`test/browser/invoices.cjs`, offline). The account-scoped draft keeps its submission identity for
reauthentication. The synthetic payee journey
checks request, agreement, invoice and outcome presentation at mobile and desktop widths
(`test/browser/invoices.cjs`); owner decisions there are fixture transitions, not real signatures.

The Treasury strategy UI derives labels and control permissions in `web/src/features/portfolio/strategy-presentation.ts`.
This is presentation only; server controls and dispatch still recheck authorization. Query refreshes
can name affected reads for local changes, or skip shared invalidation for plan previews.
Money execution and recovery retain broad invalidation. These behaviors are tested offline in
`test/strategy-presentation.test.ts`, `test/query-refresh.test.ts` and the browser suites.

Invoice session isolation is offline browser-tested: account changes clear rendered records and
polling, and pending reads or submissions from the previous session cannot update the new account's
form or lists. Saved drafts remain scoped by account. This does not cancel a submission already
accepted by the server.

### Stable area identity and payment discovery

An optional `area` in gateway configuration (`payables` or `treasury`) supplies `DASHBOARD_AREA` to
that child process and appears in gateway metadata. It controls presentation only; policy, grant and
role checks still govern actions. Standalone or externally started agent servers can set
`DASHBOARD_AREA` explicitly. Legacy instances without it keep policy-based area inference. The
workspace labels configured areas without fetching their balances. Disabling swaps leaves the
Treasury area's navigation and recorded runs accessible, while swap previews remain unavailable.
This is offline-tested in `test/area-config.test.ts` and `test/browser/workspace-navigation.cjs`.

`web/src/features/payables/payment-records.ts` joins retained local transfers, provider history, held observations and
owner records for display. A failed or incomplete provider history read cannot hide a transfer already
present in local activity. Identity-only observations preserve previously known terms. Display memory
is scoped to the agent and document; it is neither durable evidence nor authorization. Queue rows do
not start individual status polls; the selected payment does. Approval state and settlement are still
read separately, and source errors/incomplete history remain visible. Unit tests and the local-history
browser regression cover this behavior; no deployed observation is claimed.

### Reads with local effects

Some existing read handlers also maintain local recovery state: `setup` may adopt a staged grant,
`held` records a provider observation when a payout leaves approval, including unresolved processing
or queued statuses that block new sends; invoice status refreshes may update the invoice
record and reservation. The executor also reconciles independently of the dashboard. These effects
are intentionally retained; consolidating presentation queries does not remove their recovery role.
A future separation must preserve restart and approve-only behavior, not merely rename endpoints.

### Agreement responses and deposit evidence (offline-tested)

The remote agreement store validates successful responses: agreement lists and terms, a nonempty
offer ID, and an explicit acknowledgment for proposing or declining. Malformed responses leave the
result unconfirmed; the client does not retry a mutation that may already have been applied.
Valid server error messages and the existing request timeout are retained. The regression fixtures
are in `test/agreement-responses.test.ts`; the local agreement record format is unchanged.

Ledger deposit lookups validate receipt structure and transfer events before selecting an asset.
Malformed evidence makes the ledger read unavailable with a sanitized error, including when a valid
transfer precedes a malformed event. Valid receipts with no matching transfer retain a null asset.
Each ledger invocation fetches each distinct deposit transaction hash once, with at most four
concurrent single-hash requests, then resolves each deposit address independently. Failed reads stop
new lookups and drain in-flight requests before rejecting. There is no persistent cache, and each
new read still looks up historical deposits. `test/ledger.test.ts` covers these behaviors offline;
this is not a deployed-provider observation or a measured production performance improvement.

### Workspace task organization (local implementation)

The frontend is grouped into `app/`, `shared/`, `features/` and `public/` under `web/src`.
`app/shell.tsx` composes navigation without waiting for provider reads; the agent task boundary retains
onboarding and independent recovery behavior, including records while setup is pending. Task query
factories compose through `shared/queries.ts`, preserving the existing agent and fleet cache keys.
Home skips agreement-request reads for known Treasury areas; it retains held, unresolved, inbox and
schedule observations because Treasury can transfer and Payables may retain a legacy schedule.

The desktop rail and mobile drawer contain only Home, Payables, Portfolio and Activity. Mobile uses a
native modal with Escape, focus restoration and a visible current-page label. Area task tabs and named
Funding and Policy utilities appear in the content; Help contains Guided walkthrough. Same-agent task links use
the router; switching agents loads a new document. Existing payment/run URLs and legacy anchors remain.
Payments combines local invoice and payment discovery, with secondary manual payment creation. An
invoice joins a payment only through its recorded correlation ID; an invoice-only detail reads no
provider payment status. Missing invoice access and remote executor records remain explicit.
Agreements groups all open terms by recipient and displays policy inclusion independently; closed
records, offers and direct policy changes have named disclosures. Strategy separates saved
configuration, owner authorization, schedule and manual rebalance. The editor saves directly with
the schedule off and opens authorization for that saved digest; one strategy summary remains
visible during review. Saving never signs or enables scheduling. Stale or unavailable observations
still prevent authorization. Manual previews use percentages and estimated/minimum received amounts.
Completed setup and manual
previews start collapsed; the rebalance anchor opens its preview. Sweep belongs to Balances & funding
under “Shield public funds”, opened by its existing anchor. A selected run leads with its original
recorded outcome and per-operation results, followed by later observations. Technical observations,
receipt metadata and recording inspection are under Run details; the new-run control follows the
selected record. A run ending still does not establish settlement. Policy shows live grant revocation directly and
keeps ended grants in history. Shared Activity retains operation, owner-action and run histories plus
lazy books views, with links to scoped recovery controls and individual run details. Run history starts
collapsed; read failures, incomplete records and missing ends stay explicit. Overview retains known
limitations and the requirement-evidence disclosure, including its `#evidence` anchor, without repeating
the Recent activity list or the “What this demonstrates” introduction.

Payment discovery and selected-payment observations are separate hooks. Normal review and recovery
share status polling and a display that distinguishes owner decision from payment outcome. Only a
selected payment polls its provider status. Pure stage derivation never reconstructs approval evidence
from settlement. Confirmation controls live with owner actions, separate from generic UI primitives.
Public overviews share only data-free task vocabulary and requirement stages with the workspace.
Simulated execution, approval and playback are removed. Earlier example-page hashes resolve to the
corresponding area's static explanation. Public code cannot import authenticated observation or action
modules; opening it reads no private records and displays no private evidence.

These changes require no RPC or state-format migration. They are local frontend changes, not a new
mainnet observation or provider-enforcement claim. Offline validation includes feature-boundary and
payment-stage tests plus the workspace, payment, recovery, strategy and public browser fixtures.

## Idea-3 candidate integration

`router.ts` includes `rpc/work-orders.ts`; gateway permissions classify its read, prepare and
signature submission calls. `work-orders.ts` bridges the configured payout parent to the invoice
executor's private `/internal/work-orders` endpoint. `invoice-http.ts` also exposes payee-scoped
order APIs. `work-order-pool.ts` starts isolated subprocesses; `work-order-runtime.ts` coordinates
owner intents and fixed invoice filing; `work-order-binding.ts` checks immutable order terms.
Store, pool, protocol and binding tests cover local behavior. There is no connected work-order
React interface, no complete hosted lifecycle evidence and no payee settlement implementation.
Keep each child settings file, initialization marker, owner intents, invoices and operation journal
with its immutable order record; do not reuse the parent's grant or owner private key.

### Focused Treasury owner identity (offline-tested)

The focused header displays `ownerName(setup)` beside the existing wallet control, so the owner
can distinguish the DAO reference from another Treasury before reviewing actions. DAO identity
retains the existing proposal label; long account names wrap. Missing owner evidence retains the
existing generic wallet label rather than inferring identity from the connected account or gateway.
The public entry renders no owner observation. Treasury browser fixtures cover these cases; this
presentation adds no RPC, signing, authorization or state-format change.
