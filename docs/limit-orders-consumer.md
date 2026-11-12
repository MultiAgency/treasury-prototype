# Treasury app limit-order consumer

Status: local consumer integration only, using the frozen SDK 0.5.8 release artifact. The SDK package is published; compatible platform and provider deployment remain separate gates. No live order, provider mutation, deployment or live-service restart was performed. Offline and browser fixtures do not establish provider behavior.

## Dependency and release boundary

The order app imports `@multiagency/treasury-app-sdk`, pinned to the portable repository artifact `file:vendor/multiagency-sdk-0.5.8.tgz`. Its verified SHA-256 is `844fae568516dbc8d377d6f8dcceb8177be8a92c134db545d024ac25cf45d254`. An independent download of the [published SDK 0.5.8 package](https://www.npmjs.com/package/@multiagency/sdk/v/0.5.8) matched this tarball byte for byte. That release evidence does not establish a compatible deployed platform or provider.

The tarball's `package/provenance.json` records:

- Platform source commit [`2326a89505b7cb4996820467856de01165f881c6`](https://github.com/MultiAgency/platform/commit/2326a89505b7cb4996820467856de01165f881c6), following merged [MultiAgency/platform#78](https://github.com/MultiAgency/platform/pull/78).
- Source snapshot digest `6ce0914b10e83ffd74714b5356fee4d45699ce96f88cf96270bd524ca485f0fa`.
- Empty `dirtyPaths` and `sourcesDirty`, with no overlay diff.

The checksum was verified before use. The build-input regression pins the artifact checksum, checksum sidecar and embedded source provenance. These identify the tested consumer bytes; the registry download confirms the same published bytes. Neither establishes a compatible deployed platform or live provider behavior.

For this app build, keep the portable vendored dependency:

```json
"@multiagency/treasury-app-sdk": "file:vendor/multiagency-sdk-0.5.8.tgz"
```

The published package's bytes and provenance now match the reviewed frozen source. A registry alias remains a separate dependency change: propose an exact npm alias, regenerate the lockfile and repeat consumer checks before replacing this file pin. Keep the app alias until the legacy gateway consumer is migrated separately. The existing `@multiagency/sdk: "0.4.0"` remains for those consumers.

The 0.5.8 contract omits legacy `Client.treasury.setConfidential` and `Client.steward.propose`, and its policy actions include `limit_order`, absent from this checkout's legacy provider `Policy` type. The alias confines this task to the app consumer without editing the SDK checkout or altering those existing flows. The published artifact rejects exponent-form prices through normal schema validation; malformed input is refused before a platform call.

## Release artifact contract comparison

Compared with the immediately prior 0.5.8 consumer artifact from `2fedc80`, packed `CHANGES.md`, `provenance.json` and two generated JavaScript bundles changed. The bundles differ only in build-path comments; their executable lines and the other 97 packed files, including the limit-order contracts, app client, consent and capability contracts, and SDK Treasury app skill, are byte-identical. The earlier optional `payment.repeats` addition on an owner `approval_vote` preparation remains unchanged. This Treasury consumer does not use that payment preparation path. Its order behavior was rechecked against the release artifact.

## Consent and operation behavior

The app server reads the host's `treasury-limit-orders-v1` capability through the SDK app client's existing `capabilities()` method, a credentialed `GET /apps/v1/capabilities`. API-only hosts can answer 404 for `/gw/me`; public owner-UI discovery is not the app capability contract. The credential stays on the server. Advertising the capability grants no authority. The current owner separately consents to `read`, `treasury` and `treasury-orders`; `treasury-execute` never implies orders. This additional consent stays reachable after the ordinary Treasury connection. Wallet owners sign the SDK consent text; DAO members with proposal permission file the SDK-built consent vote and follow that same request.

Every browser call goes to this app's server. The app credential stays in its SDK client on the server. The app checks the current agent owner/provider identity, live consent and current DAO Group roles before every order operation; public Everyone rights alone admit no member. For DAO approvals, only the platform's returned transaction is offered, with proposal-and-vote chosen only for a member who can vote. Polling can relay a signature, so a locally saved request must bind the requested Organization, agent, provider identity and DAO before any state poll.

The server persists requestId and exact order terms before `limitOrders/create`; only that saved body may be retried. It reads the returned order and supplies `limitOrderText(view, "approve")` with the platform host as recipient. The current wallet owner signs those exact bytes. Approval sends no funds. Once a decision attempt is admitted, the server fsyncs an exclusive decision-attempt claim before reading the order or relaying approval or rejection bound to the platform, Organization, agent, order ID, verdict and signed-body digest. Reads and refreshes report whether that claim is held and withhold signing text while held. The browser retains its own uncertain marker across reload, but the server claim is authoritative across tabs and process restarts. A delayed, failed or completed `proposed` read cannot unlock signing: platform approval can still be in flight before its record is written. A successful or unanswered relay and any torn claim remain poll-only. Only a definitive typed refusal archives the original attempt and permits a new explicit decision; a plain HTTP error is ambiguous. Placement and cancellation each have an exclusive durable claim before one SDK call. An uncertain answer or a later repeated initial HTTP request follows only `get`/`refresh`. It never submits another placement or replacement create request to compensate.

SDK 0.5.8 adds an explicit **Continue pending cancellation** action. The browser offers it only after a successful, fresh same-ID `get`/`refresh` view says `cancelMayResume === true`; beginning another read or losing a read clears that permission. The server independently repeats both reads and requires the refreshed same-ID view to carry the same strict boolean proof before calling `limitOrders/cancel` for that ID. This proof identifies a platform cancellation claim that never began its provider POST; the platform rechecks it under its money lock before its sole POST. Missing, false, malformed or stale proof, failed reads and a recorded submission attempt remain read-only. Continuation never resets the local claim. A lost continuation reply triggers reads only; another continuation requires a new explicit owner action and fresh platform proof.

Resting, partially filled, cancellation requested, payout failed and unknown states remain distinct. Full partial-fill and payout evidence stays visible. A placement `SUCCESS` or accepted cancellation proves no completed trade. Completion is shown only for a closed fill (`filled`, `canceled`, `expired`) with `isPayoutStatusFinal: true` and `payoutStatus: "completed"`.

If a definitive-refusal HTTP reply is lost, the browser cannot bind a later `decisionHeld: false` read to its exact attempted decision: that read may have raced the POST. The browser therefore retains its hold and supports polling only. Recovery requires manual review of the matching active claim/refusal archive, subject identity and signed-body digest, together with evidence ruling out other in-flight decision requests. No automatic receipt-based unlock is implemented. If that evidence cannot be established, keep the hold. Do not delete decision records or clear browser attempt markers to authorize a retry; any release requires a separately reviewed recovery action.

## State preservation

Additive private records live below `APP_STATE` (default `.app/`): `order-requests/`, `order-attempts/`, `order-dao-votes/`, `order-dao-consents/` and shared proposal/order `decision-attempts/`. Existing `requests/` and `tokens/` formats are unchanged. Preserve all these directories on backup, restart, rollback and migration. A torn attempt claim remains claimed. Decision claims, including active directories, torn files and archived refusals, must survive. Older consumers that do not enforce these claims must keep decisions unavailable. Only the explicit cancellation continuation with fresh platform proof may proceed; local claim contents alone never permit replay. Never remove a claim or saved request to retry an ambiguous operation. Resolve it against retained platform/provider evidence. This task starts no executor and modifies no platform money state.

The browser also retains exact unsatisfied create requests and action attempts in localStorage for recovery guidance. Server records are authoritative across tabs and restarts. Clearing browser storage cannot permit another initial SDK placement/cancellation. A cancellation continuation still requires fresh server-verified platform proof. An uncertain create draft stays locked to the same requestId and terms.

For the dedicated app image, staging configuration, read-only platform preflight and rollback procedure, use the [Treasury app deployment runbook](treasury-app-deployment.md).

## Remaining platform/provider gates

- The SDK 0.5.8 library is published with matching provenance; an exact registry alias still needs its own reviewed dependency change and consumer checks. Platform PRs #78 and #87 are merged, but verify a compatible deployed platform before app rollout, including its app capability endpoint and all order/DAO route contracts. The last checked 0.5.7 staging platform lacks this order route; an advertised capability alone proves neither the active agent release nor provider support.
- Production provider order routes remain unverified and were absent in the supplied read-only platform observation. Live placement, cancellation, partial fills, final payout semantics, deduplication and provider policy enforcement remain unverified.
- The owner must separately sign a policy revision enabling `limit_order` with its deviation bound, hold the required live Treasury grant, and satisfy platform policy/strategy checks. A configured cash floor currently refuses resting orders.
- Preserve and reconcile platform order journals, one-way claims and DAO relay receipts for rollout/rollback; an older platform cannot be assumed to read new order journal methods.

No live order or operational rollout is authorized by these local checks.
