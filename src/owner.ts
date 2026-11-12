import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { GenerateIntentResponse, OwnerWallet, SignedData } from "@near-intents-agent-api/sdk";
import { Near, parseKey, type PrivateKey } from "near-kit";
import { api, waitForStatus } from "./api.js";
import { delegateTransaction } from "./chain.js";
import { mainnet } from "../shared/near.js";

const accountId = process.env.AGENT_OWNER_ACCOUNT_ID;
const privateKey = process.env.AGENT_OWNER_PRIVATE_KEY as PrivateKey | undefined;
if (!accountId || !privateKey)
  throw new Error("AGENT_OWNER_ACCOUNT_ID and AGENT_OWNER_PRIVATE_KEY must be set (see .env.example)");

const keyPair = parseKey(privateKey);
const near = new Near({ ...mainnet, privateKey, defaultSignerId: accountId });

export const owner = {
  type: "near",
  account_id: accountId,
  public_key: keyPair.publicKey.toString(),
} satisfies OwnerWallet;

/** Signs `intent.payload` exactly as generated, by the standard the API chose. */
async function sign({ intent, signer }: GenerateIntentResponse): Promise<SignedData> {
  if (signer.type !== "near" || signer.public_key !== owner.public_key)
    throw new Error("owner_account_mismatch");
  if (intent.standard === "nep413") {
    const { signature } = await near.signMessage({ ...intent.payload, nonce: Buffer.from(intent.payload.nonce, "base64") });
    return { ...intent, public_key: owner.public_key, signature };
  }
  if (intent.standard !== "nep366") throw new Error(`unsupported standard ${intent.standard}`);
  // Gasless delegate action: the API's sponsor relays it, and near-kit reads the nonce from chain.
  const { payload } = await delegateTransaction(near, signer.account_id, intent.payload).delegate({ blockHeightOffset: 120 });
  return { ...intent, signed_delegate: payload };
}

/** generate → show preview → owner confirms → sign → submit → settle; throws unless it succeeds. */
export async function runOwnerIntent(request: Parameters<typeof api.generateIntent>[0]) {
  if (request.type === "approval_vote") throw new Error("Use the bound payment approval flow; generic owner signing cannot release payments");
  const generated = await api.generateIntent(request, { idempotencyKey: crypto.randomUUID() });
  if (generated.type !== request.type) throw new Error("Provider generated a different owner intent type");
  console.log(JSON.stringify(generated.preview, null, 2));
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`\nSign ${generated.type} as ${owner.account_id} on mainnet? [y/N] `);
  rl.close();
  if (answer.trim().toLowerCase() !== "y") throw new Error("Not signed");
  await api.submitIntent({
    type: generated.type,
    correlation_id: generated.correlation_id,
    signed_data: await sign(generated),
  } as Parameters<typeof api.submitIntent>[0]);
  const status = await waitForStatus(generated.correlation_id);
  if (status.status !== "SUCCESS") throw new Error(status.failure_code ?? `${request.type} ${status.status}`);
  return status;
}
