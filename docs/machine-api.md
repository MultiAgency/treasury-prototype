# Treasury machine interface v1: removed

Treasury's own `/machine/v1/a/<treasury-name>/rpc/<procedure>` route, its credential management
(`/gw/machine-credentials/<name>`) and its credential store (`src/gateway/machine-auth.ts`) were removed from this
repository on 2026-11-03 (user decision, `coordination/treasury-app-move.md`, Answers 4). Outside agents move to the
platform's app scope (`/apps/v1`) through a Treasury app; until that exists, the packaged
[Treasury skill](../skills/treasury/SKILL.md) targets the platform's machine route, described below.
`test/gateway-denial.test.ts` checks that a bearer call and credential management no longer reach an agent.

## Production still serves the old route until redeployed

Observed 2026-11-03 UTC, read-only: the `treasury` service (Railway project `platform`, production) runs deployment
`95451b7a-27d9-4652-a0d9-b502b5d0f420` (2026-10-16T04:53Z, a CLI upload with no commit metadata), with
`TREASURY_SELF_SERVICE=true` and `DASHBOARD_FILE=/app/deploy/treasury.json`. An unauthenticated
`POST https://treasury.multiagency.ai/machine/v1/a/treasury/rpc/instance` answered
`401 {"error":"Invalid, expired or revoked credential"}`, so that deployment serves an earlier version of the route.
Which credentials exist and what that version permits was not checked. The route leaves production only when the
owner redeploys from a tree without it; such a redeploy also ships every other unreleased change.

## State: archive `.machine-auth/`, don't delete it

`.machine-auth/` at the gateway root (`/data/state` in production) holds credential hashes, expiry and revocation
flags and `access.jsonl` attribution. Nothing reads it after the removal. Preserve it with all other state during any
backup, migration or redeploy ([operations](operations.md)), and archive it rather than delete it: it is the record of
which machine calls were made. Machine entries in `.evidence/interventions.jsonl` (`machineCredentialId`) stay as they
are. No money record needs conversion.

## Strategy-bound grant before plan execution

The MultiAgency platform's machine route, from the `@multiagency/sdk` 0.4.0 server (dao/sdk `1a7fe98`;
the package is published, but no host runs that server yet), runs `executePlan` for a machine credential only while
the owner's live grant binds the saved strategy. That grant's label is `treasury:<first 32 hex of the strategy
digest>`. Under any other grant it answers one `rejected` event ("the agent's live grant doesn't bind the saved
strategy…"); the plan is not claimed and nothing is sent. `read`, `prepare` and `sweep` are unchanged, and so is the
owner's own session. Per platform source at that commit (`src/planning/strategy-grant.ts`, `src/rpc/treasury.ts`).

Before any machine-route execution, the owner reviews the saved strategy and signs the grant in their own session:
`owner/prepare` with `{ type: "grant_issue", label: "treasury", expectedStrategyDigest: <digest from strategy/get> }`,
then signs and submits it like any owner action. Each saved strategy needs its own grant. After the owner saves a
different strategy, machine plans are refused again until they sign a new one. The packaged skill helper reports this
refusal as "Refused before sending" and tells the agent to report it to the owner, not to retry execution or prepare a
replacement plan (offline-tested: `test/treasury-skill-helper.test.ts`).

