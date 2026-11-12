# Treasury proposals demo

**Demonstrated workflow: an outside agent proposes swaps through the Treasury app → the owner signs the platform's exact
terms → the owner executes → the agent follows the outcome.** Coordination: `coordination/treasury-app-move.md`
(stage 6).

Everything runs locally against an isolated platform stack with a **simulated** provider, chain, settlement and owner
wallet. No real funds, live credentials or real signatures are involved.

The platform supplies the app consent, proposals, the owner's signed approval check, guarded execution and the journal.
Treasury supplies its own code:
- the Treasury app server (`app/`), over HTTPS with the stack's certificate;
- owner sign-in and agent tokens;
- the skill helper (`skills/treasury/scripts/treasury-app.mjs`);
- the owner's approval relay and Execute.

This directory holds only the run's inputs, the owner's simulated decisions and a receipt.

## Command

Prerequisites are as for [the strategy demo](../treasury-strategy/README.md): Node 24.22.2, `pnpm install` here, and a
platform snapshot whose harness has `appCredential`, `signOwner`, `setPrice` and `dropSwapResponse`
(`test/e2e/stack-controls.mjs`). Build the web app first; the app server serves its proposals page.

```sh
nvm use 24.22.2 && pnpm build:web
SNAPSHOT=/Users/jlwaugh/agencies/dao/sdk/.test-artifacts/stack-snapshots/c8dafe626d05552a1d101d8119f41441f67bb4c25dec60331dc98e2e62589de8
node demo/treasury-proposals/run.mjs --proto "$SNAPSHOT"                        # happy path
node demo/treasury-proposals/run.mjs --proto "$SNAPSHOT" --fault below-floor    # price below the signed floor
node demo/treasury-proposals/run.mjs --proto "$SNAPSHOT" --fault lost-response  # a lost provider reply
```

Inputs are the strategy demo's `scenario.json` (3 USDC, then 2 USDC, into wNEAR), unless `--scenario FILE` is given.
The run directory is `.test-artifacts/demo/proposals-*/`, with `receipt.json` and each helper command's output. The
helper's output is checked for the agent token, and a leak fails the run.

## Sequence

1. **Strategy in force:** the owner's strategy fixture, as in the strategy demo.
2. **Credential:** the platform operator issues the Treasury app's deployment credential (`tap_…`, `appCredential`).
3. **The app starts:** the Treasury app runs on HTTPS with this run's own state.
4. **Sign in:** the owner signs in to the app with their wallet (simulated signature, fixture key lookup).
5. **Connect:** the owner connects the agent in the app. The app builds the consent text (`read` + `treasury`, no
   `treasury-execute`) for the platform's host; the owner signs it, and the app submits exactly that.
6. **Token:** the owner issues the agent a `read` + `propose` token.
7. **Propose:** the agent reads `unresolved`, then runs `propose terms.json --request-id demo-1`. The platform quotes
   each swap and keeps its floor. The provider sees no submission.
8. **Approve:** the owner reads the proposal from the app, which returns the platform's exact text and its host as the
   recipient. The owner signs that text and the app relays it. The provider still sees no submission.
9. **Execute:** the owner executes once through the app.
   - `--fault below-floor`: wNEAR's price rises first. Execution is refused `not_executable` (exit 2) with nothing
     submitted, the proposal stays `approved`, and after the price returns it executes.
   - `--fault lost-response`: the provider's reply to the first swap is lost. The outcome is `unknown` (exit 3), and a
     second Execute sends nothing.
10. **Follow:** the agent reads `proposal ID` and acts no further.

The result is `as expected` only if all of these hold:
- the provider's submissions are exactly the proposed legs, each at or above its signed floor;
- the proposal ends `executed`, or `unknown` with one submission and nothing more for `lost-response`;
- the platform snapshot is unchanged after the run.

## Evidence

**Runs with the app's connect route, 2026-11-03 UTC.** All three used the same snapshot `c8dafe62…` (verified and
`unchangedAfterRun: true`), Node 24.22.2, skill `306e6c55e409…` and Treasury app `29481036c3f4…`. The consent is
prepared, signed and submitted through the Treasury app. No step goes around Treasury's code.

| Run | Result | Submissions | End state |
|---|---|---|---|
| Happy path, `proposals-FDapXb` | as expected; exit 0 | 2, floors kept | executed |
| Below the floor, `proposals-ExXPrc` | as expected; exit 0 | 0 while below (exit 2, `not_executable`); then 2, floors kept | executed |
| Lost response, `proposals-OYDZJs` | as expected; exit 0 | 1, none more after a second Execute | unknown |

These are simulator runs, not a hosted platform.

**Rerun after the independent review's fixes, 2026-11-03 UTC:** happy `proposals-xqhCV9`, below-floor
`proposals-wQbcGU` and lost-response `proposals-6lx0U8`, all as expected on the same snapshot (`unchangedAfterRun:
true`), Treasury app `c73fdb150c8e…`, skill `0161dec84a8c…`.

**Earlier runs, 2026-11-03 UTC, before the connect route** (the recipe then submitted the consent itself with
`appClient`): the same snapshot and Node, skill `306e6c55e409…`, Treasury app `b53ad40ff132…`.

| Run | Result | Proposal | Submissions | End state |
|---|---|---|---|---|
| Happy path, `proposals-XPZbWg` | as expected; exit 0 | `302bc71cc7a3d384ec3e046926c259f7` | 2, floors kept | executed (2 × SUCCESS) |
| Below the floor, `proposals-Dpei3P` | as expected; exit 0 | same ID (fresh stack, same request ID) | 0 while below; then 2, floors kept | executed |
| Lost response, `proposals-JtXSJv` | as expected; exit 0 | same ID | 1, no more after a second Execute | unknown |

Earlier attempts found two defects in Treasury's code, both fixed before these runs, with tests that fail without the
fixes:
- The app's proposal routes and the helper accepted only UUIDs, while proposal IDs are 32 hex characters (the SDK's
  `proposalId`). The fixture platform now validates inputs with the SDK's own schemas.
- The recipe passed the stack's `{ accountId, publicKey, signature }` into strict platform inputs.

## Remaining gaps

- **Only the stack's own Treasury agent:** the simulator swaps only for `portfolio`, so Treasury agents created through
  an app aren't exercised.
- **Page not driven here:** the owner's browser page isn't used in this recipe (`test/browser/treasury-proposals.cjs`
  covers it offline). Signing uses the stack's fixture key, not a wallet.
- **Not exercised:** a real wait between proposal and approval, provider concurrency, and real settlement timing.
