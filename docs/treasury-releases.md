# Treasury frontend releases

Local release artifacts of the focused Treasury build, frozen under `.test-artifacts/releases/`. None
has been published or deployed. Digests use the Proto release server's `digest()`. Proto's harness
results are reported by Proto and were not rerun here. Every release keeps the confirmed plan in the
page address (`?plan=<uuid>`): reloading or following a link reopens that exact plan's recorded
operations without resending anything.

## A — `9b721e67…59a1` (contract 1.2.0)

First release under the P2 owner-app manifest. `contract.json` declares the platform capabilities;
the default build no longer bundles the shared Payables and Portfolio screens. A Proto host without
the declared capabilities refuses it with 503.

## B — `8e9d170b…b28e` (contract 1.2.0)

Adds **Stop following this plan**, which removes the plan from the page address and closes the
view. It sends nothing and cancels nothing.

## C — `4c9df5c7…83a7` (contract 1.2.0)

Serves the Treasury skill at `/skill.md`, with its input contract inlined, through a new manifest
entry. The helper script ships with the skill package.

## A2 — `57221b72…7f9c` (contract 1.3.2, oRPC beta.43)

Calls go through Proto's `ownerClient`, and answers are validated against the published output
schemas. The default build no longer uses the copied backend. A failed read is `unavailable`, shown
with generic text rather than the server's message. A lost or unverifiable money action is
`unknown`, and the UI re-reads its records instead of resending.

## B2 — `793ec0ab…ea14` (contract 1.3.2)

A send refused because operations are unresolved, or because another money action is running, shows
owner guidance and a link to the operations to follow, in place of the server's operator wording.

## A3 — `55d0a15a…fe66` (contract 1.4.0, oRPC beta.44)

Reads use TanStack Query over the same client.
- **Cache keys:** prefixed with host, agent and signed-in account. When the account changes, the
  earlier account's agent reads and proposals are dropped.
- **Sends:** never go through the query library, so nothing retries or refetches a send.
- **Error classification:** a malformed answer is `unknown` after a send and `unavailable` for a
  read. A provider failure after a send is `unknown` unless the provider proves it a refusal.
- **Known issue (A3 and B3):** two reads, the instance and the strategy status, keep their first
  account's cache key after a later account switch. The data shown is still the current account's,
  because earlier entries are evicted and re-read. Fixed in A4.

## B3 — `ea377970…b880` (contract 1.4.0)

The exact-plan view shows when its operations were last read ("Operations last read: <time>",
"· refreshing" while reading, "not yet" before the first read). This is separate from a failed read,
which Activity reports, and from an empty history. A read time is not settlement.

## A4 — `fd3adb8c…b11f` (contract 1.4.0, oRPC beta.44)

Fixes the A3/B3 cache-key partition defect: instance identity and strategy status are read through
the account-scoped query set at each use, so after an account switch both are keyed and re-read in
the new account's scope. A late answer for the earlier account is cancelled and never reaches the
new scope. `pnpm check:frontend` rejects module-level copies of the account-scoped queries.

## A5 — `07d9542e…6229` (contract 1.4.0, oRPC beta.44)

Account switches are noticed promptly and are never shown with the previous account's permissions.
- **Re-read triggers:** the gateway session is re-read whenever the tab becomes visible again, and
  at once when another tab of this host signs in or out (a same-origin signal).
- **Pending state:** while it is being re-read, permission-dependent controls are not offered.
- **Skill and naming:** the served `/skill.md` is the rewritten skill (outcome first, a worked example,
  identity and resume rules, and this release's supported versions), with both input-contract links
  resolving on the page. Current docs use "contributor" and "payee" in place of "supplier", except
  where they quote the Agent Connect catalog.

## A6 — `13ad983b…8d1a` (`@multiagency/sdk` 0.0.1, oRPC beta.44)

The guided Treasury run is in the default build.
- **Run:** `/demo` is readiness checks, the rebalance preview with explicit execution, and the exact
  confirmed plan's outcome, kept in the page address like Home's; reloading reopens it and sends nothing.
  Before, a Treasury-only build redirected `/demo` to Home.
- **Deep links:** `/demo#check`, `/demo#preview`, `/demo?plan=<id>#outcome`, `/#rebalance`, `/automations`,
  `/policy`, `/policy#grants` and `/activity#owner-actions` land on their controls once those render.
- **Package:** built against `@multiagency/sdk` 0.0.1, the renamed contract package.

## A7 — `2b0bf1bf…1a0a` (`@multiagency/sdk` 0.1.0 linked, oRPC beta.44)

A new treasury opens on setup, not on "Access unavailable".
- **Access wait:** after `POST /gw/agents`, **Continue** waits up to 30 s for the reserving account's access
  to the new agent ("Starting your workspace…"), then opens it. Past the budget it opens with its own
  **Check access again**. A sign-out or another account during the wait stops it where it is, with a plain
  message; it never reserves again or signs anything. Access is never granted client-side.
- **Package:** built against the linked `@multiagency/sdk` 0.1.0; its manifest records the SDK's contents
  digest (`390c3ffc…0379`). Proto's packed 0.1.0 tarball (`7f68c9f1…d416`) differs only in `CHANGES.md`.
- **Skill:** unchanged from A6 (`405d68c4…`); `/skill.md` is byte-identical.

## A8 — `a3a089f9…3037` (`@multiagency/sdk` 0.1.0 linked, oRPC beta.44)

A blocked treasury says why and stops offering sends it will refuse.
- **Blocked summary:** the unresolved-operations card states how many operations block new sends, that a
  submission attempted with no provider reference has an unknown outcome, what stays safe (reading,
  previewing, checking outcomes), and that resolving it is a separate owner-authorized step this page
  cannot clear, retry or replay.
- **Send block:** while the latest unresolved read succeeds and reports operations, **Execute** and
  **Shield** are not offered, with the reason beside them; **Preview** stays. A failed or pending read
  leaves both as in A7. The server's refusal remains the authority.
- **Refused before sending:** an execution refused as unresolved or busy, with no execution events, closes
  the plan view and clears `?plan`; any other failure keeps it.
- **Wording:** outcome checks name a "replacement operation" for Treasury agents ("replacement payment"
  for Payables). After a sign-out or account switch during the access wait, the disabled button reads
  **Continue**.
- **Package:** the linked SDK's contents digest is `390c3ffc…0379`, the same as A7's input. Proto's
  0.1.0 tarball (`7f68c9f1…d416`) differs only in `CHANGES.md`.
- **Skill:** unchanged; `/skill.md` is byte-identical to A7's.

