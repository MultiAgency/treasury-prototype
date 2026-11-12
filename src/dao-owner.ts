import type { Intent, OwnerWallet } from "@near-intents-agent-api/sdk";
import { encodeSignedDelegateAction, Near, parsePublicKey } from "near-kit";
import { accountExists, delegateTransaction, transactionsApi } from "./chain.js";
import { mainnet } from "../shared/near.js";
import { nep413Hash, rawKey, verifyEd25519 } from "../shared/nep413.js";

/**
 * A DAO as an agent's owner. A Sputnik DAO holds no keys, but it can sign through NEAR's MPC
 * network: a proposal calling `v1.signer.sign` produces an Ed25519 signature for a key derived
 * from the DAO and a path, and only the DAO can ask for it. The owner is the implicit account of
 * that key, so to the Agent API it is an ordinary NEAR owner, and each owner signature is a vote.
 */

const PATH = "agent-owner";
const near = new Near(mainnet);

type NearOwner = Extract<OwnerWallet, { type: "near" }>;

/** The DAO's owner account: the implicit account of its MPC key on the `agent-owner` path. */
export async function daoOwner(dao: string): Promise<NearOwner> {
  const publicKey = await near.view<string>("v1.signer", "derived_public_key", { path: PATH, predecessor: dao, domain_id: 1 });
  if (!publicKey) throw new Error(`v1.signer derived no key for ${dao}`);
  return { type: "near", account_id: rawKey(publicKey).toString("hex"), public_key: publicKey };
}

/** The owner account exists once funded; a delegate action needs its access key on chain. */
export const ownerFunded = (owner: NearOwner) => accountExists(owner.account_id);

/**
 * NEP-366: the delegate action near-kit builds for `payload`, signed by a key store whose one key
 * is the owner's. Its signer records the hash and leaves a placeholder; the DAO's signature over
 * that hash replaces the placeholder's last 64 bytes.
 */
async function delegateRequest(payload: Extract<Intent, { standard: "nep366" }>["payload"], owner: NearOwner) {
  let hash: Uint8Array | undefined;
  const key = {
    publicKey: parsePublicKey(owner.public_key),
    secretKey: "",
    sign: (message: Uint8Array) => {
      hash = message;
      return { keyType: 0 as never, data: new Uint8Array(64) };
    },
  };
  const keyStore = { get: async () => key, add: async () => {}, remove: async () => {}, list: async () => [owner.account_id] };
  // Long enough for the vote; the Agent API's own expiry is the tighter limit.
  const { signedDelegateAction } = await delegateTransaction(new Near({ ...mainnet, keyStore }), owner.account_id, payload)
    .delegate({ blockHeightOffset: 6000 });
  const bytes = Buffer.from(encodeSignedDelegateAction(signedDelegateAction, "bytes"));
  return { hash: Buffer.from(hash!), bytes };
}

/**
 * What the DAO signs for one owner intent, as plain data that survives a restart: the hash (hex) and,
 * for a delegate action, its exact bytes (base64). Those bytes hold a nonce and block height read
 * from chain, so building them again would give another hash than the one the DAO voted on.
 * `since` is the block height when it was prepared: no proposal can have signed it before.
 */
export type DaoSigning = { owner: NearOwner; intent: Intent; hash: string; delegate?: string; since?: number };

export async function signingRequest(intent: Intent, owner: NearOwner): Promise<DaoSigning> {
  if (intent.standard === "nep413") {
    const { message, nonce, recipient } = intent.payload;
    return { owner, intent, hash: nep413Hash(message, Buffer.from(nonce, "base64"), recipient).toString("hex") };
  }
  if (intent.standard === "nep366") {
    if (!(await ownerFunded(owner))) throw new Error(`Fund the DAO's owner account ${owner.account_id} first`);
    const { hash, bytes } = await delegateRequest(intent.payload, owner);
    return { owner, intent, hash: hash.toString("hex"), delegate: bytes.toString("base64") };
  }
  throw new Error(`A DAO owner signs NEAR intents only, not ${intent.standard}`);
}

/** The signed data the DAO's signature completes. */
export function completeSigning({ owner, intent, delegate }: DaoSigning, signature: Buffer) {
  if (!delegate) return { ...intent, public_key: owner.public_key, signature: signature.toString("base64") };
  const signed = Buffer.from(delegate, "base64");
  signature.copy(signed, signed.length - 64);
  return { ...intent, signed_delegate: signed.toString("base64") };
}

/** The chain's latest block height: where the search for a request's signature starts. */
export async function latestBlock() {
  return (await near.getStatus()).sync_info.latest_block_height;
}

/** The one call the DAO files as a proposal: v1.signer signing `hash` with the owner's key. */
export function signTransaction(hash: string) {
  const args = { request: { path: PATH, payload_v2: { Eddsa: hash }, domain_id: 1 } };
  return {
    receiverId: "v1.signer",
    actions: [{ type: "FunctionCall" as const, params: { methodName: "sign", args, gas: "50000000000000", deposit: "1" } }],
  };
}

/**
 * The same request filed by a member's own wallet as a Sputnik proposal, with a description saying
 * what it signs. (Through Trezu as a wallet, the description is Trezu's generic "sign on v1.signer".)
 * `bond` is the DAO's proposal_bond, attached exactly.
 */
export function proposalTransaction(dao: string, hash: string, description: string, bond: string) {
  const { receiverId, actions } = signTransaction(hash);
  const { methodName, args, gas, deposit } = actions[0]!.params;
  const kind = {
    FunctionCall: {
      receiver_id: receiverId,
      actions: [{ method_name: methodName, args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit, gas }],
    },
  };
  return {
    receiverId: dao,
    actions: [
      { type: "FunctionCall" as const, params: { methodName: "add_proposal", args: { proposal: { description, kind } }, gas: "100000000000000", deposit: bond } },
    ],
  };
}

/**
 * The same proposal, filed and approved in one transaction by a member who may also vote: `id` is the
 * one the DAO will give it, its `last_proposal_id` at filing. Both calls run in one receipt, so if `id`
 * is stale the vote fails and nothing is filed. With a one-vote threshold the proposal executes at once.
 */
export function proposalAndVote(dao: string, hash: string, description: string, bond: string, id: number) {
  const filing = proposalTransaction(dao, hash, description, bond);
  const { kind } = filing.actions[0]!.params.args.proposal;
  return {
    receiverId: dao,
    actions: [
      ...filing.actions,
      // The DAO checks `proposal` against the stored kind, so a vote can't land on another proposal.
      { type: "FunctionCall" as const, params: { methodName: "act_proposal", args: { id, action: "VoteApprove", proposal: kind }, gas: "75000000000000", deposit: "0" } },
    ],
  };
}

type Transactions = { transactions?: { receipts?: { execution_outcome?: { outcome?: { status?: { SuccessValue?: string } } } }[] }[] };

/**
 * The DAO's signature over the request's hash, once a proposal asking for it has executed; null until
 * then. The candidates are every transaction since the request was prepared in which the DAO itself
 * called out, as an executed proposal does when it calls v1.signer, however the final vote arrived (a
 * member's wallet or a relay). They are read again on each call: v1.signer answers in a later receipt,
 * so a transaction read too early has no signature yet. Only a signature that verifies against the
 * owner key counts.
 */
export async function findSignature(dao: string, { owner, hash, since }: DaoSigning) {
  const candidates: string[] = [];
  let resume_token: string | undefined;
  do {
    const page = await transactionsApi<{ account_txs?: { transaction_hash: string }[]; resume_token?: string }>("/account", {
      account_id: dao,
      is_predecessor: true,
      from_tx_block_height: since,
      desc: true,
      limit: 200,
      resume_token,
    });
    const txs = page.account_txs ?? [];
    candidates.push(...txs.map((t) => t.transaction_hash));
    resume_token = txs.length > 0 ? page.resume_token : undefined;
  } while (resume_token);

  // 20 is the most /transactions accepts in one call.
  for (let i = 0; i < candidates.length; i += 20) {
    const { transactions = [] } = await transactionsApi<Transactions>("/transactions", { tx_hashes: candidates.slice(i, i + 20) });
    for (const receipt of transactions.flatMap((t) => t.receipts ?? [])) {
      const value = receipt.execution_outcome?.outcome?.status?.SuccessValue;
      if (!value) continue;
      try {
        const result = JSON.parse(Buffer.from(value, "base64").toString());
        if (result?.scheme !== "Ed25519" || !Array.isArray(result.signature)) continue;
        const signature = Buffer.from(result.signature);
        if (verifyEd25519(owner.public_key, Buffer.from(hash, "hex"), signature)) return signature;
      } catch {}
    }
  }
  return null;
}
