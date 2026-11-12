# Agent access: handoff to Proto

The owner confirmed another session owns agent authorization and credential management in Proto.
Proto owns the shared implementation. Treasury supplies task-specific capabilities and the skill;
it must not develop a competing shared gateway or access-management screen. No Proto files were
changed for this handoff. Nothing in this candidate has been deployed or provisioned with live access.

## Product outcome and ownership

Owners need to authorize their agents for their own treasuries, inspect permissions and expiry, and
revoke access. A skill teaches the agent how to use that authority; installing it grants no access.
Agent-selected strategies become quoted saved plans executed through the existing executor.

| Owner | Responsibility |
| --- | --- |
| Proto session | Shared machine authentication, delegation, credential lifecycle, host/owner/agent isolation, consent and access-management UI, shared integration/release acceptance |
| Treasury | External chosen-swap preparation, existing plan execution, Treasury permission descriptions, portable skill/helper, product-specific tests |

The local Treasury gateway implementation is an experimental reference, not an additional intended
production authority. Consolidate its verified boundaries into Proto's chosen design; do not run two
credential issuers or copy credentials/grants between executors. Treasury should consume the supported
shared contract once integrated. Do not overwrite Proto's concurrent edits or replace its host-aware
gateway with Treasury's simpler standalone server.

## Reviewable reference bundle

`.test-artifacts/proto-agent-access-handoff/` in the Treasury checkout contains:

- `manifest.json`: Treasury baseline revision and SHA-256 hashes of all reference files.
- `reference/`: 22 source/test/doc/skill snapshots, including the experimental backend and draft UI.
- `draft-ui-routing.patch`: the three Treasury-only route/link changes, for reference rather than
  automatic application to Proto.

The new UI draft was typechecked but has no browser or end-to-end acceptance. Its component and
routing changes were removed from Treasury's active source after capture. The snapshots contain
source and fixture code, not deployed settings or real credentials.

## Existing experimental contract

These were the candidate endpoints, removed from this repository on 2026-11-03 ([machine interface](machine-api.md)):

- Owner session management: `GET/POST /gw/machine-credentials/<name>` and
  `DELETE /gw/machine-credentials/<name>/<id>`.
- Machine procedures: `POST /machine/v1/a/<name>/rpc/<procedure>` with a separate bearer credential.
- Independent Treasury scopes: `read`, `prepare`, `execute-plan`, `sweep`.
- `externalPlan`: one to eight chosen swaps; Treasury supplies quotes and saves the complete plan.
- `executePlan`: existing claim, fresh checks, money lock, journal and dispatch path.

Proto may replace this transport/authentication design. Agree the consuming contract before updating
the Treasury skill and client; avoid maintaining parallel contracts. An MCP interface is not implemented
or required by this handoff. Neither OAuth nor NEAR/OutLayer machine identity has been implemented.

## Boundaries already reproduced and tested

Preserve these properties or provide equivalent tests in the shared implementation:

1. DAO group permissions alone cannot establish consent to delegate machine authority. The candidate
   refuses DAO issuance and use until a verified DAO approval mechanism exists.
2. Machine authorization requires fresh chain/provider ownership evidence. A warmed dashboard cache
   cannot permit calls during failed identity reads; missing or replaced agents refuse access.
3. Credentials bind the host, workspace, owner and actual provider agent ID, not just the workspace name.
4. Preparation, saved-plan execution and sweeping have separate authority. Owner signatures, policy/grant
   changes, schedule controls, recovery and other areas are not exposed by these Treasury permissions.
5. Expiry and revocation survive restart and are rechecked after body receipt and ownership lookup.
   Revocation cannot cancel an operation already forwarded.
6. Credential secrets are returned once and stored only as hashes. Strip Authorization, cookies and
   client-supplied gateway markers before forwarding. Retain attribution without bodies or secrets;
   required storage/audit failures refuse forwarding.
7. Earlier experimental storage-version-1 credentials remain listable/revocable but cannot authenticate.
   Version-2 records bind agent ID and split execution/sweep scopes; no implicit upgrade grants authority.

Proto integration must additionally preserve its existing host-selected agent list, host-local sessions,
host restrictions, self-service registry, payee routes and child/executor assignments. Testing the
standalone gateway does not establish those shared-host properties. Missing machine support should
remain explicitly unavailable in Treasury, never fall back to browser sessions or another host.

## Access-management UX to finish

Use Proto's existing owner workspace and components. The draft illustrates:

- Access label, independent permission choices and bounded duration, defaulting to read-only for one hour.
- A review step before issuance, including a clear statement when autonomous movement is permitted.
- One-time credential presentation with Treasury origin/name and expiry; explicit copy and hide controls.
- Existing records with permissions, issuer, issue/expiry times and revocation confirmation.
- Explicit DAO-unavailable and shared-host-unavailable states.

Before adopting the draft, resolve these unfinished details:

- Clear secrets, review snapshots and retained metadata on account/owner/workspace changes or access
  denial. Cancel or ignore late reads and issuance responses from the previous authorization context.
- Keep revocation accessible when balances, grants or other product observations are unavailable;
  private management should not depend on a healthy Treasury overview.
- Treat lost issuance responses as ambiguous: refresh metadata and allow revoking the inaccessible
  credential rather than automatically issuing another. Never retain secrets in query caches or storage.
- Manage focus on review, issuance and revocation transitions; check keyboard navigation, screen readers,
  both themes, mobile and desktop. Preserve the 44px interaction target requirements.
- Explain that a label is not proof of the agent's identity, and expiry/revocation status is not proof
  of current ownership or operation settlement. Show the credential's host restriction where useful.
- Keep implementation handoff details out of user-facing error copy.

Execution consent must state that credentials currently have no separate per-client spending budget.
External plan calls use Treasury plan-execution semantics; the scheduled autopilot's per-run ceiling
does not apply. Owner policy/grant checks still apply. Spending caps do not bound market exposure;
provider concurrency guarantees remain unverified. These facts must not disappear behind a generic
"connect agent" confirmation.

## Evidence and remaining gates

The Treasury candidate passed typecheck, 750 offline tests and seven simulated-provider end-to-end
cases before the UI draft. The skill helper's real-stack case prepares chosen swaps, executes the exact
saved plan, inspects its recorded operation, rejects repeat execution and confirms revoked access.
The skill passed its validator. These results do not certify the draft UI or Proto integration.

Relevant tests at the time: `test/machine-auth.test.ts`, the machine cases in `test/gateway-denial.test.ts` and
`test/gateway-canonical.test.ts`, and the outside-agent scenario in `test/e2e/workspace.spec.mjs`. All were removed with
the route on 2026-11-03; `test/external-plan.test.ts` remains.

Shared acceptance should cover owner/non-owner/DAO boundaries; cross-host and cross-agent isolation;
read-only defaults and explicit execution consent; no issuance on navigation/reload/cancellation;
one-time secrets and failed-copy handling; uncertain issuance/revocation; expiry and rotation; late
response redaction; and revocation during provider failure. Extend external-client crash/timeout and
partial-execution acceptance separately. Preserve all state, including experimental `.machine-auth/`
records if present, and prevent rollback from restoring revoked authority.

No live tests, deployments, production restarts, credential issuance, owner signatures or money actions
are authorized by this handoff.
