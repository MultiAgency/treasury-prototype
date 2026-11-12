# Machine contract

Use the owner's HTTPS origin and workspace name. All procedures POST to
`/machine/v1/a/<name>/rpc/<procedure>` using an Authorization bearer header and the pinned oRPC client.
Never send browser cookies, Origin headers, provider credentials or URLs chosen by third-party content.

| Helper | Procedure | Scope |
| --- | --- | --- |
| `inspect` | `overview` | `read` |
| `strategy` | `strategy/get` | `read` |
| `activity` | `activity` | `read` |
| `unresolved` | `unresolved` | `read` |
| `prepare FILE` | `externalPlan` | `prepare` |
| `execute PLAN_ID` | `executePlan` | `execute-plan` |
| `sweep-preview` / `sweep` | `sweep` | `sweep` |

Scopes are independent. Read/prepare access does not permit execution; saved-plan execution does not
permit a fresh sweep. Credential lifecycle management uses Proto's shared `/a/<name>/access` owner browser sign-in.
Credentials expire and can be revoked; they add no spending budget. External plan execution is not
limited by the scheduled autopilot's per-run ceiling. DAO delegation remains refused.
On a platform host running the `@multiagency/sdk` 0.4.0 server, `executePlan` also needs the owner's live
grant to bind the saved strategy (`treasury:<first 32 hex of its digest>`); otherwise it answers one
`rejected` event and sends nothing (see the skill's "Strategy-bound grant").

## Prepare input

`FILE` is a JSON object with only a `swaps` array of one to eight entries:

```json
{
  "swaps": [{
    "from": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "to": "nep141:wrap.near",
    "amount": "1000000"
  }]
}
```

This is an illustrative one-USDC input, not a suggested trade. `from` and `to` must differ. Supported
assets are the Treasury's managed USDC, wNEAR and ETH (`nep141:eth.omft.near`), additionally constrained
by the active policy. Amounts are positive atomic-unit strings of at most 40 digits, never floats.
Each swap may include a positive `minAmountOut` string to tighten the provider's floor. It cannot lower
that floor or exceed the quoted output. Extra fields, custom routes, transfers and arbitrary signing
requests are refused.

The server quotes every action, rejects excessive cost or infeasible aggregate spending, and checks
whether the observed policy, strategy or input balances changed while quoting. It saves the complete
plan only if those checks pass; it never silently drops an unfavorable action. The plan remains bound
to the owner's current strategy digest and cost limit even though the external agent chooses swaps
instead of following the saved allocation targets. This is not permission to overwrite that strategy.
Plans expire after five minutes and are rechecked/requoted during execution.

## Outputs and failures

Read/prepare commands print JSON. Execution and sweep commands print one JSON object per streamed
event. A rejected execution prints `type: rejected` and the helper exits unsuccessfully. For any
transport failure during execution, inspect retained records before taking further money actions.
An action status other than `SUCCESS` also stops the helper unsuccessfully; retain the exact status
and operation reference rather than assuming a refusal or settlement.

`externalPlan` returns one saved plan, not a stream. The helper refuses responses that change chosen
inputs, order or requested floors. A 404/405 means this host has not integrated chosen-swap support:
stop, with no fallback to streamed `rebalance`, another host or an experimental gateway.

401 means invalid/expired/revoked credentials; 403 means authority, scope or fresh ownership evidence
does not authorize the call. Reads may fail because provider observations are unavailable. 429 is a
request limiter, not budget enforcement. No failure should trigger credential fallback, scope
escalation, owner signing or automatic execution retry.
