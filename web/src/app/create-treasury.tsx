import { treasuryReservation } from "./gateway-contract";
import { TreasuryBrand } from "./treasury-brand";
import { WalletButton } from "../features/owner/owner";
import { useState } from "react";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button, ErrorBox } from "../shared/ui";
import { gw, errorMessage } from "../shared/lib";
import { loadGateway, type Gateway } from "./session";

// A hosted agent stays closed until its server first answers. Wait, within this budget, for the account that
// reserved it to gain access, so the new workspace doesn't open on "Access unavailable". A sign-out or
// another account ends the wait without opening it; past the budget it opens with its own recheck.
const ACCESS_WAIT_MS = 30_000;
type AccessWait = "granted" | "timeout" | "signed-out" | "switched";
async function waitForAccess(name: string, account: string): Promise<AccessWait> {
  for (const deadline = Date.now() + ACCESS_WAIT_MS; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 1_000))) {
    const gateway = await loadGateway().catch(() => undefined);
    if (gateway === undefined) continue;
    if (!gateway?.viewer) return "signed-out";
    if (gateway.viewer.account !== account) return "switched";
    if (gateway.viewer.access[name]) return "granted";
  }
  return "timeout";
}
const STOPPED = {
  "signed-out": "You signed out before the new workspace opened.",
  switched: "Another account signed in before the new workspace opened.",
};

/** Registers an isolated workspace; the following screen obtains the owner's actual signature. */
export function CreateTreasury({ gateway }: { gateway: Gateway }) {
  const [kind, setKind] = useState<"wallet" | "dao">("wallet");
  const [dao, setDao] = useState("");
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopped, setStopped] = useState<{ reason: keyof typeof STOPPED; account: string }>();
  const [error, setError] = useState<string>();
  const treasuries = gateway.agents.filter(agent => agent.area === "treasury" || agent.name === "treasury");
  const create = async () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const request = treasuryReservation(gateway, kind, dao);
      const account = gateway.viewer!.account;
      const answer = await gw<{ name: string }>(request.path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request.body) });
      if (!/^[a-z0-9-]{1,32}$/.test(answer.name)) throw new Error("The server returned an invalid treasury. Refresh before continuing.");
      setStarting(true);
      const outcome = await waitForAccess(answer.name, account);
      if (outcome === "granted" || outcome === "timeout") location.assign(`/a/${answer.name}/`);
      else { setStarting(false); setStopped({ reason: outcome, account }); }
    } catch (error) { setError(errorMessage(error)); setBusy(false); }
  };
  return <main className="mx-auto flex max-w-xl flex-col gap-8 px-5 py-10">
    <header className="flex flex-wrap items-center justify-between gap-4"><TreasuryBrand /><WalletButton /></header>
    <h1 className="text-2xl font-semibold">Your treasuries</h1>
    {treasuries.length > 0 && <nav aria-label="Your treasuries" className="flex flex-col gap-3">{treasuries.map(agent => <Button key={agent.name} asChild variant="outline" className="h-auto justify-start whitespace-normal break-all"><a href={`/a/${agent.name}/`}>{agent.owner}</a></Button>)}</nav>}
    <form className="flex flex-col gap-6" onSubmit={event => { event.preventDefault(); void create(); }}>
      <h2 className="text-xl font-semibold">Create your Treasury</h2>
      <FieldGroup>
        <Field><FieldLabel>Owner</FieldLabel><ToggleGroup type="single" value={kind} onValueChange={value => { if (value === "wallet" || value === "dao") setKind(value); }} aria-label="Treasury owner" disabled={busy}>
          <ToggleGroupItem value="wallet">My NEAR account</ToggleGroupItem><ToggleGroupItem value="dao">A DAO</ToggleGroupItem>
        </ToggleGroup></Field>
        {kind === "dao" && <Field><FieldLabel htmlFor="treasury-dao">DAO account</FieldLabel><Input id="treasury-dao" value={dao} onChange={event => setDao(event.target.value)} placeholder="example.sputnik-dao.near" required disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></Field>}
      </FieldGroup>
      <p className="text-sm text-muted-foreground">{kind === "wallet" ? "Your wallet approves creation, policy, and delegation." : "Use an existing Sputnik DAO where you can submit proposals. Its members approve creation and delegation."}</p>
      <p className="text-sm text-muted-foreground">Continue opens an isolated workspace; it signs nothing and moves no funds. Next, explicitly authorize agent creation and policy, save and authorize your strategy, fund your agent, then enable scheduling. Scheduling starts off.</p>
      <ErrorBox error={error} />
      {stopped && <p role="alert" className="text-sm">{STOPPED[stopped.reason]} It is reserved for {stopped.account} and nothing was signed. <a href="/" className="underline">Return to Home</a> and sign in as {stopped.account} to continue.</p>}
      <Button type="submit" className="self-start" disabled={busy || kind === "dao" && !dao.trim()}>{starting ? "Starting your workspace…" : busy && !stopped ? "Opening…" : "Continue"}</Button>
    </form>
  </main>;
}
