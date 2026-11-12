# Deploy the independent Treasury app

The deployment package runs the Treasury app consumer from `app/main.ts` on its own service and host. It connects to a compatible platform through the SDK app client and starts no executor. The existing Treasury gateway, its registered agents, volumes and executor assignments keep their current deployment path. This runbook identifies candidate configuration; it does not establish the current state of any hosted service.

## Dedicated deployment files

| File | Purpose |
| --- | --- |
| [`Dockerfile.app`](../Dockerfile.app) | Installs the frozen dependencies, builds the owner page and includes `app/` plus its shared server imports. |
| [`railway.app.json`](../railway.app.json) | Selects the app image, one replica and `/health` for the dedicated Railway service. |
| [`deploy/app-entrypoint.sh`](../deploy/app-entrypoint.sh) | Starts the app server with its persistent app-state directory; it starts no gateway or agent child processes. |
| [`app/main.ts`](../app/main.ts) | Reads the app's host, platform connection and session settings and serves the proposals entry at `/`. |
| [`.env.app.example`](../.env.app.example) | Provides the app configuration template with blank credentials. Copy it to a private file outside the source and image context. |
| [`scripts/treasury-app-preflight.mjs`](../scripts/treasury-app-preflight.mjs) | Performs the bounded read-only platform checks locally or from its packaged path, `/app/scripts/treasury-app-preflight.mjs`. |

The root `railway.json`, `Dockerfile`, `Dockerfile.dashboard` and `deploy/dashboard-entrypoint.sh` remain the gateway deployment. A normal redeploy through that configuration does not start this consumer. Select `/railway.app.json` as the dedicated service's **Config File Path** before deploying this package. Check that an inherited start-command override does not replace the app image's entrypoint.

## App service configuration

Use a separate staging service and its own persistent volume mounted at `/data`. Configure one replica. The service needs the following values in its server environment:

| Variable | Required value |
| --- | --- |
| `APP_HOST` | The exact externally visible app host used for wallet sign-in, without a scheme or path. Include the port only when it is part of that public host. |
| `PLATFORM_URL` | The verified compatible platform's HTTPS origin. This is the platform origin, without an `/apps/v1` suffix. |
| `TREASURY_APP_CREDENTIAL` | This app deployment's platform credential, supplied as a server secret. |
| `SESSION_SECRET` | A separate random secret of at least 32 characters for this app's sessions. |
| `APP_STATE` | `/data/app`, on the app service's persistent volume. |
| `PORT` | `8080` in the packaged image, or Railway's assigned port. |
| `TRUST_PROXY` | `true` behind the Railway proxy for the existing request-limit address handling. |

`APP_WEB_DIST` can override the packaged `web/dist` location; ordinary image deployment uses the packaged assets. `NEAR_RPC_URL` and `FASTNEAR_API_KEY` are optional server settings for owner-key and DAO-role reads. The app does not need the executor's Agent API key or grant token. Do not copy executor settings into this service. Keep the app credential, session secret and any RPC key out of browser assets, build arguments, logs and checked-in environment files.

Changing `APP_HOST` changes the wallet's sign-in recipient. Verify the chosen host and HTTPS routing before inviting owners to sign in. A health check can pass on another hostname; it does not prove that host-bound sign-in or private app routes work.

## Prepared staging identity proof

The existing staging identity supplied for this handoff is `multiagency-treasury` (display name `MultiAgency Treasury`), with responsible account `multiagentic.near` and publisher website `https://treasury.dev.multiagency.ai`. The prepared public proof is [`deploy/treasury-app-domain-proof.txt`](../deploy/treasury-app-domain-proof.txt). Serve its exact contents at that publisher website's `/.well-known/multiagency.txt`, then have the operator verify the live response. This file alone does not publish the proof, issue a credential or authorize an order. It is not included as an automatic route in the app image.

## Operator credential intake

The platform operator issues the app's `tap_…` credential. A Railway service key, provider API key or another app's token is not a substitute. There is no self-service credential-issuance endpoint. Follow the platform's [developer-access process at the frozen source](https://github.com/MultiAgency/platform/blob/2fedc80227b641cc7db48e079af2ed229a619d3f/docs/developer-access.md) before provisioning:

1. Review a unique deployment ID, display name, responsible NEAR account and publisher website. IDs use lowercase letters, digits and dashes and have at most 32 characters; the operator reserves `multiagency-*` by manual review.
2. Agree the proof domain and publish its HTTPS `/.well-known/multiagency.txt` with exactly `deployment=<reviewed-deployment-id> account=<responsible-NEAR-account>`. The current app does not serve this proof path, so plan proof hosting with the operator instead of assuming the new app hostname already supplies it.
3. Request staging access explicitly for owner consent scopes `read`, `treasury` and `treasury-orders`, including DAO use when needed. The existing intake template can predate `treasury-orders`; include that scope in the reviewed request. This feature does not require unattended `treasury-execute` consent.
4. Have the platform operator approve the identity, proof, host, expiry and request budget. The documented intake uses at most 90 days and the default 1,200 requests per hour unless another budget is reviewed. Credential issuance is a platform-state change, so perform it only after that review on the verified staging gateway.

The operator command is run from the gateway's actual persistent state directory, where `.app-access/` lives. Its arguments name the platform host, not `APP_HOST`:

```sh
/app/node_modules/.bin/tsx /app/src/app-credential.ts issue '<reviewed-deployment-id>' '<verified-platform-host>' 90 '<reviewed-display-name>'
```

The command writes a private hashed credential record and prints the bearer token once. The operator must capture it through a private terminal or a permission-restricted delivery mechanism, without returning stdout to chat, build logs, deployment logs or a public issue. Deliver it privately and install it only as the dedicated app's `TREASURY_APP_CREDENTIAL`. Record only its credential ID, approved deployment identity and expiry in the operator handoff. The gateway rereads credential records on requests; credential issuance alone needs no gateway restart and grants no owner consent.

Use a new reviewed deployment identity for an independent app. A replacement credential under an existing deployment name acts on all consents that deployment already holds. Do not reuse a dashboard or test actor to make the preflight pass. Owner-signed setup reservations in `.hosted/apps.json` also belong to their deployment and Organization; credential issuance neither creates an agent nor transfers another deployment's reservation. Verify an existing authorized staging tuple before requesting the tuple-specific preflight. New provider-agent creation remains a separate action.

An unauthenticated `401` at the capability endpoint demonstrates an authentication boundary, not an advertised capability. A successful service deployment, green CI on a draft platform change, or HTML at `/app/me` also does not establish a ready app host. When the reviewed identity or credential is missing, keep the local package ready and resolve intake before deploying against guessed values. Keep dated target observations and IDs in the private or ignored task report rather than treating this generic runbook as current infrastructure state.

## Freeze and verify the package

Keep `@multiagency/treasury-app-sdk` pinned to `file:vendor/multiagency-sdk-0.5.8.tgz`. The frozen unpublished artifact's SHA-256 is `3c3b87d541ff479771dc3cda7a15609b103b8315e6c5fc07d5e88f189a1786b5`. Its source commit and snapshot are recorded in the [consumer handoff](limit-orders-consumer.md#dependency-and-release-boundary). The legacy gateway consumer keeps `@multiagency/sdk` at `0.4.0`.

A registry alias is a later release decision, after publication and verification of the published package's provenance and contract. A matching version number alone is insufficient. Include the tarball, its checksum file, lockfile, app source, shared imports and deployment files in the frozen source package.

From that source package, prepare the local image and run the repository's release checks:

```sh
pnpm install --frozen-lockfile
pnpm verify
docker build --file Dockerfile.app --tag treasury-app:staging-review .
```

Record the exact source revision or source snapshot, artifact checksum and check results. A local image build verifies packaging only. It does not verify the target platform or provider. Complete any failed or unavailable check before calling the package release-ready.

## Platform first, then the app

1. Verify the intended Railway project, environment, separate app service, host, volume and existing gateway/executor assignments read-only. Use explicit verified IDs for subsequent operations. Historical hostnames or a directory's linked service do not select a safe deployment target.
2. Release a reviewed compatible platform candidate before pointing the app at it. The frozen SDK source is associated with [MultiAgency/platform#78](https://github.com/MultiAgency/platform/pull/78); its PR and tarball alone are not a compatible deployed platform. Preserve the platform's order journals, one-way submission/cancellation claims and DAO relay receipts during its rollout.
3. Complete operator intake and obtain the dedicated staging credential as described above. With that intended app credential, run the read-only SDK preflight below against that exact platform. Require a passing capability check before staging the disconnected app. For an existing connected Organization/agent, also require the tuple-specific identity and live-consent checks before claiming that connection is ready. A missing order consent is a separate owner task; the preflight must not manufacture one.
4. Select `/railway.app.json` on the verified separate staging service, supply the app settings and persistent volume, and deploy the frozen app package there. Retain the default gateway configuration and its service. This consumer rollout neither transfers executor ownership nor moves an agent's funds or settings.
5. Perform the staging acceptance checks below and record the observed deployment result privately. Keep production routing and real order actions as separate reviewed steps.

The authorized staging plan permits progress against a verified compatible target. It does not authorize guessing a platform, overwriting the existing Treasury service, issuing production orders or treating an unrelated successful deployment as this consumer's release.

## Read-only platform preflight

Use [`scripts/treasury-app-preflight.mjs`](../scripts/treasury-app-preflight.mjs), packaged at `/app/scripts/treasury-app-preflight.mjs`, with a private environment file containing the verified `PLATFORM_URL` and `TREASURY_APP_CREDENTIAL`. Keep this file outside the source package and restrict its permissions. The capability-only check is:

```sh
node --env-file=/secure/app.env scripts/treasury-app-preflight.mjs
```

For an already connected Organization and agent, request all supported read checks:

```sh
node --env-file=/secure/app.env scripts/treasury-app-preflight.mjs --organization '<org>' --agent '<agent>'
```

The script prints a JSON summary and exits `0` when the requested compatibility checks pass. Exit `2` means a required read is unavailable, the capability is absent, the identity mismatches or the agent has no matching live order consent. Investigate that summary without printing the credential or raw upstream errors. Capability-only success verifies a disconnected staging app's platform route; it does not establish a ready agent connection. A failed live-consent check remains an onboarding task requiring the owner's separate decision.

The preflight uses the SDK app client on the server and reads only:

- `app.capabilities()`, which sends credentialed `GET /apps/v1/capabilities`. Require `treasury-limit-orders-v1`. The public owner-UI `/gw/me` endpoint can be absent on API-only hosts and is not a fallback.
- `app.identity(agent)`. Verify the intended agent, current owner, provider agent ID, signer kind, platform host and app deployment identity against the planned connection.
- `app.consents.list(organization)`. Inspect whether a current consent matches that Organization, agent, provider identity, owner, signer, host and deployment, is live and contains both `treasury` and `treasury-orders`. Existing `treasury` or `treasury-execute` authority does not imply orders.

These SDK reads establish the app connection contract. They do not prove all nine order methods or the DAO relay routes on a deployed host. Review those route versions as part of the compatible platform release; defer any exercise that would create a request, signature or provider operation to its separately authorized verification.

Do not use `limitOrders/quote`, `create`, approval, rejection, placement or cancellation as a deployment smoke check. Do not poll `daoLimitOrders.state` or DAO consent state as a supposedly passive smoke check: those routes can relay an owner signature or record a consent. Do not run `pnpm test:live` for this deployment.

## Staging acceptance

- `GET /health` returns success, and the service's process/entrypoint is `app/main.ts`, rather than the gateway or an agent server. The app exposes its owner page at `/`, with working packaged static assets.
- Signed out, `GET /app/me` and private order routes refuse access. The browser receives no app credential. The service's persistent `APP_STATE` is on its own volume, and repeated reads do not create replacement order requests.
- Sign in deliberately with the current wallet for the selected app host. Confirm the signed-in account and selected Organization/agent. An account switch must not cause another owner to sign the order text.
- On an existing ordinary Treasury connection, the additional order-consent controls remain reachable. Without the host capability, order controls remain unavailable. Without order consent, the UI explains the additional consent and shows the appropriate wallet or DAO path.
- Inspect consent controls without preparing, signing, submitting or voting a new consent as an automatic acceptance action. Do not click preview, create, approve, place, cancel or DAO relay controls. Existing consent can be read without renewing it.
- If retained order records exist, verify their exact IDs and visible states read-only. Resting, partial fills, cancellation requested, payout failure and unknown outcomes remain distinct. A pending pre-submission cancellation exposes **Continue pending cancellation** only with fresh `cancelMayResume === true` proof; inspect it without activating it during acceptance. Completion requires a closed fill and final completed payout evidence; a funded/resting order or accepted cancellation is not completion.

A passing health check or sign-in is not evidence that production provider order routes, policy enforcement, fills or payouts work. The default policy still requires a separately owner-signed revision enabling `limit_order`, an appropriate deviation bound and a live Treasury grant. A configured cash floor currently refuses resting orders. Keep the [remaining platform/provider gates](limit-orders-consumer.md#remaining-platformprovider-gates) explicit before any later live-order plan.

The durable decision-attempt guarantee starts once this corrected consumer admits the decision request, before its platform reads and relay. It cannot reserve an attempt before a request reaches the app or finishes its admission checks. It does not reconstruct signatures attempted by older consumers before those records existed. This task deploys neither version.

If a definitive-refusal HTTP reply is lost, the browser cannot bind a later `decisionHeld: false` read to its exact attempted decision: that read may have raced the POST. The browser therefore retains its hold and supports polling only. Recovery requires manual review of the matching active claim/refusal archive, subject identity and signed-body digest, together with evidence ruling out other in-flight decision requests. No automatic receipt-based unlock is implemented. If that evidence cannot be established, keep the hold. Do not delete decision records or clear browser attempt markers to authorize a retry; any release requires a separately reviewed recovery action.

## Preserve state and roll back

Before backup, replacement or rollback, stop writes to this app and preserve the entire `/data/app` directory. It contains `requests/`, `tokens/`, `order-requests/`, `order-attempts/`, `order-dao-votes/`, `order-dao-consents/` and `decision-attempts/`. Retain request bodies, decision-attempt active directories and refusal archives, receipts and claims even when a response was lost. A pending or `proposed` observation never releases an unresolved decision. A torn decision record stays held. A torn claim remains claimed; only an explicit same-ID cancellation continuation with fresh `cancelMayResume === true` platform proof may proceed. A prior provider submission attempt stays read-only. Do not delete records or browser drafts to repeat an ambiguous action.

Roll back the consumer image while retaining its current state. Confirm that the chosen older consumer enforces the durable decision-attempt records as well as the other retained records; if it does not, keep order actions unavailable and use a compatible observer for reconciliation. The separate legacy SDK `0.4.0` consumer does not gain order support by rollback. Platform rollback has its own journal-format and DAO relay compatibility obligations; never restore an old platform journal over newer order records.

This app rollback starts no executor. Preserve the existing gateway/executor volume and assignment independently using the [gateway operations runbook](operations.md#executor-migration-and-state-preservation). Record the resulting source/image revision, deployment outcome and retained unresolved requests privately, without copying secrets into this document.
