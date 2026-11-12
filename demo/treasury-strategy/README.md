# Treasury strategy demo

**Demonstrated workflow: chosen swaps → saved plan → authorized execution → exact outcome.**

This recipe does not complete every original Treasury Management outcome. It does not demonstrate
scheduled autopilot, allocation-based rebalance, DAO-owned treasuries, swaps across more than one
asset pair, or PnL. Any evidence for those comes from elsewhere ([requirements and
evidence](../../docs/treasury.md)) or does not exist yet. It is not established by this recipe.

## 1. User story

A Treasury owner lets an outside agent choose swaps for it. The agent can quote them as one saved
plan and execute that exact plan after the owner says yes, so the owner keeps the decision and can
check every recorded operation.

Everything runs locally against an isolated Proto with a **simulated** provider, chain, settlement
and owner wallet. No real funds, live credentials or real signatures are involved. The recipe drives
the actual Treasury skill helper (`skills/treasury/scripts/treasury.mjs`). Proto supplies consent, the
scoped credential, plan records, guarded execution and the journal. This directory holds only scenario
inputs, the owner's simulated decisions and a receipt.

## 2. Command and inputs

Prerequisites:

- **Node 24.22.2** (the images' version). The shell default here is Node 26, so select it first: `nvm install 24.22.2 && nvm use 24.22.2`.
  Then `pnpm install` in this repository and in the Proto checkout (`/Users/jlwaugh/agencies/dao/proto`).
- Proto's Playwright Chromium (`pnpm exec playwright install chromium` in Proto) and `openssl`.
- A Proto checkout or a pinned Proto stack snapshot, passed with `--proto DIR` or `PROTO_DIR`. The
  default is the sibling `../proto`.
  - **Pinned snapshot** (a directory containing `SNAPSHOT.json`; preferred for review). The recipe
    recomputes the snapshot's digest using the algorithm in Proto's `test/e2e/run.mjs`. It skips
    top-level `.test-artifacts` and `SNAPSHOT.json`, and the digest must match the recorded
    `runDigest` or the recipe refuses before creating a run directory. It then copies the snapshot,
    checks the copy against the same digest and uses the snapshot's prebuilt web UI. After the run it
    recomputes the digest and records `unchangedAfterRun` in the receipt. A changed snapshot fails the run.
  - **Checkout.** The recipe copies Proto's source into its run directory and builds the web UI there,
    as Proto's own E2E runner does. The receipt records HEAD and the uncommitted file list.

  Neither mode writes to the Proto directory.

Run from this repository's root (`/Users/jlwaugh/agencies/dao/treasury`), with the snapshot to use:

```sh
nvm use 24.22.2
SNAPSHOT=/Users/jlwaugh/agencies/dao/sdk/.test-artifacts/stack-snapshots/c8dafe626d05552a1d101d8119f41441f67bb4c25dec60331dc98e2e62589de8
node demo/treasury-strategy/run.mjs --proto "$SNAPSHOT" --yes                                    # happy path
node demo/treasury-strategy/run.mjs --proto "$SNAPSHOT" --yes --fault unbound-grant              # no strategy-bound grant
node demo/treasury-strategy/run.mjs --proto "$SNAPSHOT" --yes --fault lost-response --lost-at 2  # lost-response variant
```

That snapshot is the platform's SDK 0.4.0 release candidate (source `1a7fe98`). Without `--proto`, the recipe uses the
sibling `../proto` checkout. The recipe now needs a platform whose harness has the `authorizeStrategy` stack control
(`test/e2e/stack-controls.mjs`); the earlier snapshots listed in section 4 predate it and no longer run with this recipe.

Other options:

- Leave out `--yes` and the run asks before executing. Without a terminal and without `--yes`, the
  owner's decision is recorded as declined: the run stops before execution, nothing is submitted, and
  the receipt's result is `declined` (exit 1).
- `--pause` waits for Enter before each step, for filming.
- `--headed` shows the owner's consent page in a browser.
- `--helper FILE` runs another implementation of the helper's commands in place of the packaged one, for evaluation.
  The receipt records the file and its sha256 (`provenance.helper`, with `packaged: false`).
- `--scenario FILE` uses another inputs file.

The run directory is `.test-artifacts/demo/run-*/`. It holds:

- `receipt.json`;
- each helper command's output;
- the Proto snapshot;
- the simulated environment's logs and observations.

These are local artifacts. Helper output is redacted before it is written, and a credential in it fails
the run. The exit code is 0 only when the result is `as expected`:

- the credential carries exactly `read`, `prepare` and `execute-plan`;
- the simulated provider records no submission through preparation and the owner's decision (dry quotes
  never enter its submission log);
- the saved plan, the provider's submissions (legs and floors) and Proto's recorded operations each hold
  exactly the chosen swaps, with distinct identities, and the submitted total equals the scenario's;
- the budget is read again after execution (step 8 reports what is left per window, and the receipt
  keeps both reads). The simulated provider reports a fixed `spent_usd` of 0, so "after" equals "before"
  here; real budget charging is not exercised, and a difference would not be attributed to this plan.

Inputs are in [`scenario.json`](scenario.json). The default is 3 USDC and then 2 USDC into wNEAR. For a
different set of swaps, copy the file, edit `swaps` and pass it with `--scenario`. The script stays the same.

- `swaps`: one to eight `{ from, to, amount, minAmountOut? }` entries, with amounts in atomic units as
  strings (USDC has 6 decimals: `"3000000"` is 3 USDC). They go to `externalPlan` exactly as written.
  A `minAmountOut` can only raise the provider's floor. `rebalance` is never called; it would choose
  swaps from the allocation targets instead.
- Asset IDs: USDC `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, wNEAR
  `nep141:wrap.near`, ETH `nep141:eth.omft.near`.
- Simulator limits:
  - it quotes only USDC → wNEAR;
  - it holds 100 USDC;
  - the daily budget is $50, so keep the total under about 50 USDC.
- `strategy`: target weights (basis points), minimum leg in USD and cost limit. The recipe writes it
  as the owner's prior setup, using the same offline fixture as Proto's agent-access E2E, with a
  scheduled-autopilot ceiling of zero. This is simulated owner configuration, not a recorded owner
  action. Chosen swaps keep the strategy's digest and cost limit but need not follow its targets.
  The owner then signs the strategy-bound grant for it (see section 3). Saving a different strategy
  would need a new grant.

## 3. Sequence

Pre-roll, before the request: the strategy fixture is written. The owner then authorizes that saved
strategy before any machine-route execution: Proto's `authorizeStrategy` stack control prepares
`owner/prepare` `{ type: "grant_issue", label: "treasury", expectedStrategyDigest }` through the owner's
route, signs it with the fixture key and follows it to `SUCCESS`. From the platform's 0.4.0 server on,
`executePlan` through a machine credential runs only under that grant (label `treasury:<first 32 hex of
the digest>`). The agent checks that the `strategy` it reads has the authorized digest. The owner grants read, prepare and
execute-plan access at Proto's `/a/portfolio/access`, with a simulated wallet sign-in. There is no
spending budget beyond the signed policy. The agent then reads balances, budget left, strategy and
unresolved operations, and stops if any operation is unresolved.

| Beat | Actor | What happens | Identity shown |
|---|---|---|---|
| Request | Owner | "Move 5 USDC into wNEAR in two swaps" (`scenario.json`) | — |
| Agent action | Agent | `prepare` → `externalPlan` quotes both swaps and saves one plan; nothing moves | plan ID, expiry, exact actions and floors |
| Human decision | Owner | Authorizes that plan ID (prompt, or `--yes`); the agent runs `execute PLAN_ID` once | plan ID; one provider correlation ID per action |
| Result | Agent | `activity` filtered by plan ID, plus `unresolved` | the plan's recorded operations and their statuses |

The credential's `execute-plan` scope is the platform authority for execution. The prompt stands in
for the owner telling the agent to act; Proto does not record it. Signing is simulated.

**Unbound-grant variant** (`--fault unbound-grant`): the owner skips the strategy-bound grant, so the
live grant stays a plain `treasury` grant. Preparation still saves the plan. `execute` must answer exactly
one `rejected` event naming the grant, and the helper must print "Refused before sending" with its guidance:
report to the owner, and don't retry or prepare a replacement until the owner authorizes the saved strategy.
The provider records no submission, and no operation is recorded or unresolved.

**Lost-response variant** (`--fault lost-response --lost-at N`):

1. The simulated provider accepts swap N, but its response is lost.
2. The helper exits with "outcome may be unknown".
3. Activity shows that operation with no provider reference, and one unresolved operation blocks every new send.
4. The agent stops and reports. It does not retry the lost swap.
5. The recipe then probes the block on purpose: it replays the same plan ID, and prepares and executes a
   distinct new plan. Both executions must be refused, and the provider must record no new submission.
6. Observation continues on the same plan ID. The provider-status refresh (`recover`) is an owner or
   member dashboard action, not a machine scope.

Video outline (about 60 seconds), with the pre-roll filmed separately if needed:

1. **Request** (0–10s): show `scenario.json`.
2. **Prepare** (10–25s): the saved plan shows exactly the two chosen swaps, their floors and a
   five-minute expiry. Nothing has moved.
3. **Explicit execute** (25–35s): the owner authorizes that plan ID, and the agent executes it once.
4. **Exact outcome** (35–50s): two `SUCCESS` actions and that plan's recorded operations with
   correlation IDs. Close on `receipt.json`.
5. **Lost response** (15s): the same story with `--lost-at 2`. The first swap succeeds and the second
   is unknown. New sends are blocked, and the agent stops instead of replaying.

Say on screen that the provider, wallet and settlement are simulated. A `SUCCESS` status from the
simulator is not mainnet settlement.

## 4. Fresh evidence and remaining gaps

**Runs on the platform's SDK 0.4.0 snapshot, 2026-11-03 UTC.** All three used
`--proto /Users/jlwaugh/agencies/dao/sdk/.test-artifacts/stack-snapshots/c8dafe626d05552a1d101d8119f41441f67bb4c25dec60331dc98e2e62589de8`
(source HEAD `1a7fe98`, no overlay, verified before and `unchangedAfterRun: true`), Node 24.22.1, packaged helper
sha256 `691b131ac9c8…`, Treasury skill digest `ace831b722ae…` and the unchanged `scenario.json`. That skill digest
predates a one-paragraph note added to `references/api.md` afterwards; the helper and `SKILL.md` are as run.
These are simulator runs of this recipe, not a hosted platform.

| Run | Result | Plan ID | Operations (from `activity`) | Unresolved |
|---|---|---|---|---|
| Happy path, `run-00NxHA` | as expected; exit 0 | `f6c2480d-0d48-4a46-b800-6f9f9fa290c1` | 3 USDC: SUCCESS `aa25042c-2824-4a5a-bbe4-68f23080b072`<br>2 USDC: SUCCESS `abdb1421-2025-4ea9-9149-ce15c55f5d89` | none |
| No strategy-bound grant, `run-jrttO2` | as expected; exit 0 | `c304145c-b21e-4761-afe1-cb0034e00e49` | none (one `rejected` event) | none |
| Lost response at swap 2, `run-qSCgir` | as expected; exit 0 | `fa0f5dc4-a59f-4c02-a471-622983fb09bf` | 3 USDC: SUCCESS `eea1afe7-768b-4a9d-8396-d9d4a4e75327`<br>2 USDC: outcome unknown, no provider reference | `external:beb77c70-9657-4f5f-8d6d-189c90e31043` |

- **Happy path:** the strategy-bound grant settled for digest `sha256:c4eff28b…3ec6f`, which equals the `strategy` the
  agent read. Credential scopes exactly `read`, `prepare` and `execute-plan`; 2 submissions, distinct identities,
  total 5000000 (5 USDC), floors as planned.
- **No strategy-bound grant:** `execute` exited 1 with one `rejected` event ("the agent's live grant doesn't bind the
  saved strategy…") and the helper's "Refused before sending" guidance; 0 submissions.
- **Lost response:** 2 submissions. The replay and the execution of a newly prepared plan
  (`00f3d6ec-4d28-438f-8651-54a18f532012`) were both refused with CONFLICT; the provider still recorded 2 submissions.

**Review candidate runs, 2026-10-19 UTC.** Both used Proto's review candidate snapshot
`--proto /Users/jlwaugh/agencies/dao/proto/.test-artifacts/stack-snapshots/92815f4a75b45810eed815648f73769ea1a4b614b0ba66e137abbfa98389dd6f`
(source HEAD `af6c03b`, overlay `87efd4a7…`, verified before and `unchangedAfterRun: true`), Node 24.22.0,
Treasury skill digest `405d68c41ab6…` (A6's skill; frontend release A6 `13ad983b…8d1a` is the paired
candidate, not loaded by the recipe) and the unchanged `scenario.json`.

| Run | Result | Plan ID | Operations (from `activity`) | Unresolved |
|---|---|---|---|---|
| Happy path, `run-SVaXTI` | as expected; exit 0 | `1fc3bb1f-b9ff-47c9-bbbf-5096afe0fe1b` | 3 USDC: SUCCESS `d9b24cf2-3655-4f83-b211-92f316166e50`<br>2 USDC: SUCCESS `399094cf-116c-4989-bd9c-c21960183b7e` | none |
| Lost response at swap 1, `run-USAphG` | as expected; exit 0 | `1e61e7d4-b112-4a9a-922a-35e59a250413` | 3 USDC: outcome unknown, no provider reference | `external:6917016d-7401-490d-92ff-0672c6c230e5` |

- **Happy path:** credential scopes exactly `read`, `prepare` and `execute-plan`; 2 submissions, distinct identities, total 5000000 (5 USDC), floors as planned.
- **Lost response:** 1 submission. The replay and the execution of a newly prepared plan
  (`e75c912d-7ff7-4511-99d9-b689d3302dda`) were both refused with CONFLICT; the provider still recorded 1 submission.
- **Happy path with the budget read after execution**, `run-lMzYdW` (as expected; exit 0), after step 7 gained it:
  plan `926f20f9-323d-4988-92e3-e1139169b19e`, 3 USDC SUCCESS `be79aca4-b9ae-4c81-b5c3-837d88906284`
  then 2 USDC SUCCESS `9f62f917-c89f-4ad4-9cc3-abee926df0a6`, listed in plan order. Budget left after:
  daily $50, weekly no limit, monthly $200, the same as before, because the simulator reports nothing spent.

**Runs on Proto's SDK 0.1.0 snapshot, 2026-10-19 UTC.** This is not the review candidate snapshot. Both used
`--proto /Users/jlwaugh/agencies/dao/proto/.test-artifacts/stack-snapshots/ee70c2090ca7da9fe0186f5bb349f9a0286bc12c1ce9b2398d0d31f4986abafe`
(source HEAD `af6c03b`, overlay `47444766…`, verified before and `unchangedAfterRun: true`), Node 24.22.0,
Treasury skill digest `405d68c41ab6…` (the skill served by frontend release A6, `13ad983b…8d1a`) and the
unchanged `scenario.json`. The recipe drives the skill helper; it does not load the A6 frontend.

| Run | Result | Plan ID | Operations (from `activity`) | Unresolved |
|---|---|---|---|---|
| Happy path, `run-jHYRpJ` | as expected; exit 0 | `a11a8772-01cc-4cef-9961-b0c35617f504` | 3 USDC: SUCCESS `1323f702-80d1-4c7b-a48a-59b757ed20d0`<br>2 USDC: SUCCESS `5e51a54f-99a6-473a-8977-ec34912d43d0` | none |
| Lost response at swap 1, `run-W6QCwu` | as expected; exit 0 | `8c95ca65-efe8-4c46-a358-50a3f863f416` | 3 USDC: outcome unknown, no provider reference | `external:aa1a2e7c-1554-43a5-bd4c-3d92e89b8f84` |

- **Happy path:** credential scopes exactly `read`, `prepare` and `execute-plan`. 2 submissions, distinct identities, total 5000000 (5 USDC), floors as planned.
- **Lost response:** 1 submission. The replay and the execution of a newly prepared plan
  (`c55849a2-5d2f-493f-800f-99e58be29ec4`) were both refused with CONFLICT; the provider still recorded 1 submission.

**Pinned-snapshot runs with the repaired checks, 2026-10-18 UTC.** All used
`--proto /Users/jlwaugh/agencies/dao/proto/.test-artifacts/stack-snapshots/e27183cb27da43c7bd1caa1f96a2544f1f8f2f93fc2428f0bbdd4017d1217d6e`
(source HEAD `af6c03b`, overlay `3a7e26d0…`, verified before and `unchangedAfterRun: true`), Node
24.22.0, Treasury skill digest `976dbc035632…` and the unchanged `scenario.json`.

| Run | Result | Plan ID | Operations (from `activity`) | Unresolved |
|---|---|---|---|---|
| Happy path, `run-16dTLf` | as expected; exit 0 | `4506206c-0d6b-4916-bb75-25ea243c17ee` | 3 USDC: SUCCESS `cd238ceb-9233-4bf5-a27e-ed940c9a0b24`<br>2 USDC: SUCCESS `3a11d3c6-0384-4ff1-869c-0812c840bc71` | none |
| Lost response at swap 1, `run-avaGZl` | as expected; exit 0 | `c4c56e09-f366-4cde-8db0-40ea696b41f2` | 3 USDC: outcome unknown, no provider reference | `external:beb91f8d-946b-481f-98fd-0fa746804d0d` |
| No terminal, no `--yes`, `run-RvjxLz` | declined; exit 1 | `88baa72d-4d9e-47fa-9e19-61d1529853ac` | none | none |

- **Happy path:** 2 submissions, distinct identities, total 5000000 (5 USDC), floors as planned.
- **Lost response:** 1 submission. The replay of the plan and the execution of a newly prepared plan
  (`1a5d3c8b-ab06-4ead-b094-9a23d2f8526f`) were both refused with CONFLICT ("Execution outcome may be
  unknown…"). Preparation of the new plan itself was accepted; nothing moves at preparation. The
  provider still recorded 1 submission.
- **Declined:** 0 submissions.
- **Planted faults** (scratch copies of the recipe, deleted afterwards), each `unexpected`: a provider
  submission before authorization; a consent without `Execute saved plans`; a provider leg that
  differs from the plan; a replay that is not refused.

**Pinned-snapshot runs, 2026-10-16 UTC.** Both used
`--proto /Users/jlwaugh/agencies/dao/proto/.test-artifacts/stack-snapshots/bf6cf8c4eb9e5f6d945a92e75d3c25a0cc956bfa47a257d11cf768afd63b8dd7`
and the unchanged `scenario.json`. The receipts are in this repository's `.test-artifacts/demo/`.

| Run | Result | Plan ID | Operations (from `activity`) | Unresolved |
|---|---|---|---|---|
| Happy path, `run-tE1hZP` | pass; exit 0 | `671a31ef-f2ff-4664-910f-79455a0febf9` | 3 USDC: SUCCESS `7dc9d921-e540-4acd-ac28-5914f90c4217`<br>2 USDC: SUCCESS `0046940c-f3c7-468b-8a4e-0ead679cb9ac` | none |
| Lost response at swap 2, `run-IdHRdA` | pass; exit 0 | `9d64688f-71a0-4d12-a094-bbeaa8f29a70` | 3 USDC: SUCCESS `cc38fb35-4ee4-402c-8a32-a9bf39362120`<br>2 USDC: outcome unknown, no provider reference | `external:33e5d28d-c4b5-46b2-b320-b924c9675be4` |

Notes on these runs:

- **Snapshot integrity:** each receipt records `runDigest` `bf6cf8c4…8dd7`, verified before the run and
  `unchangedAfterRun: true`. The snapshot was built from Proto source HEAD `af6c03b` with its recorded
  overlay (`overlayDiffSha256` `f6add54a…74eb`).
- **Simulator submissions:** each run made 2 swap submissions with distinct identities, and nothing was
  replayed. In the lost-response run, execution exited 1 with "outcome may be unknown".
- **Refusal check:** a tampered copy of the snapshot was refused before a run directory was created.
  The copy was made in scratch space with one changed file, and the pinned snapshot was untouched.

**Earlier baseline from a Proto checkout, 2026-10-16 UTC.** The DAO session ran these two from this README. Their
receipts are in this repository's `.test-artifacts/demo/` (local, ignored by Git).

| Run | Result | Plan ID | Operations (from `activity`) | Unresolved |
|---|---|---|---|---|
| Happy path, `run-rSHrss` | pass; exit 0 | `e9f70ef3-c63b-46ab-9a4b-77ba67b18631` | 3 USDC: SUCCESS `4bd989d4-0bdf-463a-9e9c-ad2d9938e534`<br>2 USDC: SUCCESS `008069b0-6bce-4aff-a2b5-e5f5d435713b` | none |
| Lost response at swap 2, `run-mkep3l` | pass; exit 0 | `140d12eb-11a6-4a81-b1ab-b7dbbf1fbd79` | 3 USDC: SUCCESS `1240cec5-5de8-4f96-8ec2-56905889d2f4`<br>2 USDC: outcome unknown, no provider reference | `external:c7158312-e727-4eba-8d92-e60a61f3a834` |

Environment and observations for both runs:

- Node 26.8.1. Node 24 was not run.
- Proto at `af6c03b`, including other sessions' uncommitted harness edits (harness digest `5eacbefab34d…`).
- Treasury skill digest `11510fd912e1…`.
- In the lost-response run, execution exited 1 with "outcome may be unknown". The simulator recorded
  2 swap submissions with distinct identities and no replay; it accepted swap 2, and only its response
  was lost.

Other receipts:

- `run-tuOJNU` in the same directory is an earlier happy-path pass from the original checkout, with an
  older harness digest (`7d1480a35028…`).
- An earlier repeat run from a fresh copy (`run-gQf0Re`, `run-COu28I`) wrote its receipts inside
  that copy, in a temporary session directory, not in this repository. Those receipts are not part of
  the review set.

Earlier checks from the original checkout also passed:

- the owner declining, with nothing submitted;
- a single 12 USDC swap;
- a lost response at swap 1;
- interactive authorization;
- USDC → ETH, which the simulator refused at preparation with nothing saved or sent.

Remaining gaps:

- **Swap pairs:** the simulator quotes only USDC → wNEAR, at fixed prices with instant settlement.
  Other managed pairs are refused with `Unexpected offline swap terms`. That is a simulator limit, not
  policy. Proto request W1 is recorded at low priority.
- **Not exercised:** provider concurrency, atomic budget charging and real settlement timing.
- **Dependency on Proto test files:** the recipe imports Proto's E2E harness modules
  (`test/e2e/environment.mjs`, `wallet.mjs`, `provider.mjs`, `stack-controls.mjs`). A pinned snapshot fixes their content;
  a later snapshot may change their interface (Proto request W2, optional).
- **Strategy setup is a fixture:** it is not configured through the owner's dashboard in this recipe. The
  strategy-bound grant goes through the owner's own route, but its signature comes from the stack's fixture
  key, not a wallet.
- **Recovery is outside the agent's access:** after an unknown outcome, the agent can only observe.
  Resolving it needs an owner or member action in the dashboard.
- **Wallet owners only:** DAO machine delegation is refused.
- **Not yet checked:** `--headed`.
- **No profit figure:** balance change is not profit; see [PnL data needs](../../docs/pnl-data-needs.md).
