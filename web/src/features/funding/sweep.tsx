import { ConfirmButton } from "../owner/confirm-button";

import { LockKey } from "@phosphor-icons/react";

import { amount, client, useRun } from "../../shared/lib";
import { useCanCall } from "../../app/viewer";
import { useAgent } from "../../app/agent-context";
import { Button, Card, CardHeader, Dot, Note, Spinner, StatusBadge } from "../../shared/ui";
import { OutcomeError } from "../../shared/outcome-error";
import { useSendBlock } from "../../shared/send-block";

export function Sweep() {
  const canSweep = useCanCall("sweep");
  const executor = useAgent().setup.executor !== false;
  const grant = useAgent().setup.grant;
  const canShield = grant?.label === "treasury" || Boolean(grant?.label.startsWith("treasury:"));
  const { events, state, input, error, kind, run } = useRun(client.sweep);
  const running = state === "running";
  const plan = events.find((e) => e.type === "plan");
  const shields = events.filter((e) => e.type === "shield");
  const exposed = plan?.exposed ?? [];
  const sendBlock = useSendBlock();
  const canPreview = canSweep && executor && canShield;

  return (
    <Card>
      <CardHeader
        icon={<LockKey size={20} weight="bold" />}
        title="Sweep"
        description="Shield public USDC, wNEAR and ETH balances. Other assets are not included in this sweep."
      />
      <div className="flex flex-col gap-3 text-sm">
        {!plan && <Note>{running ? "Reading the balances…" : "Preview shows which managed balances are public."}</Note>}
        {plan && exposed.length === 0 && <Note>No public USDC, wNEAR or ETH balances found. Other assets are not checked.</Note>}
        {exposed.map((h) => {
          const shield = shields.find((e) => e.asset === h.asset);
          return (
            <div key={h.asset} className="flex flex-wrap items-center gap-2 tabular-nums">
              <Dot symbol={h.symbol} />
              {amount(h.public, h)} public
              {shield && (
                <StatusBadge status={shield.status} failureCode={shield.failureCode}>
                  Shield{" "}
                </StatusBadge>
              )}
            </div>
          );
        })}
        {canPreview && sendBlock && <Note>{sendBlock}</Note>}
        {!canShield && <Note>Shielding requires a treasury grant. Payout and invoice grants cannot shield funds.</Note>}
        <OutcomeError error={error} kind={kind} />
      </div>
      <div className="mt-auto flex justify-end gap-3">
        <Button variant="outline" size="sm" disabled={running || !canPreview} onClick={() => run({ execute: false })}>
          Preview
        </Button>
        <ConfirmButton
          path="sweep"
          label={running && input?.execute ? <><Spinner /> Shielding</> : "Shield"}
          disabled={!canPreview || exposed.length === 0 || running || input?.execute || Boolean(sendBlock)}
          title="Shield these managed balances?"
          description="Moves the listed public USDC, wNEAR and ETH balances into the agent's confidential balance on mainnet. It stays in the account, out of public view."
          confirm="Shield"
          onConfirm={() => { if (!sendBlock) void run({ execute: true }); }}
        />
      </div>
    </Card>
  );
}
