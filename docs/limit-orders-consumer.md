# Treasury app limit-order consumer

Status: local consumer integration only, using the frozen, unpublished SDK 0.5.8 handoff build. No live order, provider mutation, deployment or restart was performed. Offline and browser fixtures do not establish provider behavior.

## Dependency and release boundary

The order app imports `@multiagency/treasury-app-sdk`, pinned to the portable repository artifact `file:vendor/multiagency-sdk-0.5.8.tgz`. Its verified SHA-256 is `8559e5fb37a576ea1a99924d0bfc7223aee2e8965b8ea4a3b24cb1d8530def50`. This final source-frozen artifact replaces the earlier 0.5.8 consumer artifact. It remains unpublished. Its local release evidence does not establish a compatible deployed platform or provider.

The tarball's `package/provenance.json` records:

- Platform source commit [`8b2da58fdc72bdcbb50e667ac18f10db54a05066`](https://github.com/MultiAgency/platform/commit/8b2da58fdc72bdcbb50e667ac18f10db54a05066), associated with draft [MultiAgency/platform#78](https://github.com/MultiAgency/platform/pull/78).
- Source snapshot digest `a575d2ea766269a9c1fad37ae2f315afe88a68065caff05c1406c270c1e34063`.
- Empty `dirtyPaths` and `sourcesDirty`, with no overlay diff.

The checksum was verified before use. The build-input regression pins the artifact checksum, checksum sidecar and embedded source provenance. These identify the tested consumer bytes; they do not establish a published package, a compatible deployed platform or live provider behavior.

For this unpublished build, keep the portable vendored dependency:

```json
"@multiagency/treasury-app-sdk": "file:vendor/multiagency-sdk-0.5.8.tgz"
```

Do not switch this artifact to a registry alias before publication and provenance verification. After publication, compare the published package's provenance and contract against the reviewed frozen source, then propose an exact npm alias for that verified published version and regenerate the lockfile. A matching version number alone is insufficient. Keep the app alias until the legacy gateway consumer is migrated separately. The existing `@multiagency/sdk: "0.4.0"` remains for those consumers.

The candidate contract omits legacy `Client.treasury.setConfidential` and `Client.steward.propose`, and its policy actions include `limit_order`, absent from this checkout's legacy provider `Policy` type. The alias confines this task to the app consumer without editing the SDK checkout or altering those existing flows. The frozen candidate rejects exponent-form prices through normal schema validation; malformed input is refused before a platform call.

## Final artifact contract comparison

Compared with the prior 0.5.8 consumer artifact, the limit-order contracts, app client, consent and capability contracts, and SDK Treasury app skill are byte-identical. The only SDK schema addition is optional `payment.repeats` information on an owner `approval_vote` preparation: either `{ checked: true, payouts: [{ correlationId, at, status }] }` or `{ checked: false }`. It reports matching earlier payouts without refusing the payment. The SDK app-server skill now asks consumers of that path to display this information beside the payment terms. This Treasury consumer does not use that payment preparation path, so its tested order behavior and existing regressions need no change.

## Consent and operation behavior

The app server reads the host's `treasury-limit-orders-v1` capability through the SDK app client's existing `capabilities()` method, a credentialed `GET /apps/v1/capabilities`. API-only hosts can answer 404 for `/gw/me`; public owner-UI discovery is not the app capability contract. The credential stays on the server. Advertising the capability grants no authority. The current owner separately consents to `read`, `treasury` and `treasury-orders`; `treasury-execute` never implies orders. This additional consent stays reachable after the ordinary Treasury connection. Wallet owners sign the SDK consent text; DAO members with proposal permission file the SDK-built consent vote and follow that same request.

Every browser call goes to this app's server. The app credential stays in its SDK client on the server. The app checks the current agent owner/provider identity, live consent and current DAO Group roles before every order operation; public Everyone rights alone admit no member. For DAO approvals, only the platform's returned transaction is offered, with proposal-and-vote chosen only for a member who can vote. Polling can relay a signature, so a locally saved request must bind the requested Organization, agent, provider identity and DAO before any state poll.

The server persists requestId and exact order terms before `limitOrders/create`; only that saved body may be retried. It reads the returned order and supplies `limitOrderText(view, "approve")` with the platform host as recipient. The current wallet owner signs those exact bytes. Approval sends no funds. Placement and cancellation each have an exclusive durable claim before one SDK call. An uncertain answer or a later repeated initial HTTP request follows only `get`/`refresh`. It never submits another placement or replacement create request to compensate.

SDK 0.5.8 adds an explicit **Continue pending cancellation** action. The browser offers it only after a successful, fresh same-ID `get`/`refresh` view says `cancelMayResume === true`; beginning another read or losing a read clears that permission. The server independently repeats both reads and requires the refreshed same-ID view to carry the same strict boolean proof before calling `limitOrders/cancel` for that ID. This proof identifies a platform cancellation claim that never began its provider POST; the platform rechecks it under its money lock before its sole POST. Missing, false, malformed or stale proof, failed reads and a recorded submission attempt remain read-only. Continuation never resets the local claim. A lost continuation reply triggers reads only; another continuation requires a new explicit owner action and fresh platform proof.

Resting, partially filled, cancellation requested, payout failed and unknown states remain distinct. Full partial-fill and payout evidence stays visible. A placement `SUCCESS` or accepted cancellation proves no completed trade. Completion is shown only for a closed fill (`filled`, `canceled`, `expired`) with `isPayoutStatusFinal: true` and `payoutStatus: "completed"`.

## State preservation

Additive private records live below `APP_STATE` (default `.app/`): `order-requests/`, `order-attempts/`, `order-dao-votes/` and `order-dao-consents/`. Existing `requests/` and `tokens/` formats are unchanged. Preserve all these directories on backup, restart, rollback and migration. A torn attempt claim remains claimed. Only the explicit cancellation continuation with fresh platform proof may proceed; local claim contents alone never permit replay. Never remove a claim or saved request to retry an ambiguous operation. Resolve it against retained platform/provider evidence. This task starts no executor and modifies no platform money state.

The browser also retains exact unsatisfied create requests and action attempts in localStorage for recovery guidance. Server records are authoritative across tabs and restarts. Clearing browser storage cannot permit another initial SDK placement/cancellation. A cancellation continuation still requires fresh server-verified platform proof. An uncertain create draft stays locked to the same requestId and terms.

For the dedicated app image, staging configuration, read-only platform preflight and rollback procedure, use the [Treasury app deployment runbook](treasury-app-deployment.md).

## Remaining platform/provider gates

- Publish the SDK feature release, verify its provenance against the reviewed frozen source and pin the exact reviewed package. Review and release a compatible platform from draft PR #78; verify the deployed app capability endpoint and all order/DAO route contracts. The older 0.5.7 staging platform lacks this order route; an advertised capability alone proves neither the active agent release nor provider support.
- Production provider order routes remain unverified and were absent in the supplied read-only platform observation. Live placement, cancellation, partial fills, final payout semantics, deduplication and provider policy enforcement remain unverified.
- The owner must separately sign a policy revision enabling `limit_order` with its deviation bound, hold the required live Treasury grant, and satisfy platform policy/strategy checks. A configured cash floor currently refuses resting orders.
- Preserve and reconcile platform order journals, one-way claims and DAO relay receipts for rollout/rollback; an older platform cannot be assumed to read new order journal methods.

No live order or operational rollout is authorized by these local checks.
