import { createHash } from "node:crypto";
import type { Intent, OwnerWallet } from "@near-intents-agent-api/sdk";
import { DELEGATE_ACTION_PREFIX, decodeSignedDelegateAction } from "near-kit";
import { canonical } from "./mandate.js";
import { nep413Hash, rawKey, signatureBytes, verifyEd25519 } from "../shared/nep413.js";

/**
 * Whether a wallet's signed data is the owner's signature over exactly the intent this server
 * prepared. The browser wallet's own code builds what it signs, and that code loads from addresses
 * outside this repo; so before the signature is relayed, it is checked here against the prepared
 * payload and the owner's key, whatever the API would check after. Pure: the problem, or null.
 */

/** sha256 of the NEP-366 prefix and the delegate action: the hash its 64-byte Ed25519 signature covers. */
export function delegateSigningHash(signedDelegate: Uint8Array) {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(DELEGATE_ACTION_PREFIX);
  const action = Buffer.from(signedDelegate).subarray(0, signedDelegate.length - 65);
  return createHash("sha256").update(Buffer.concat([prefix, action])).digest();
}

const sameJson = (a: unknown, b: unknown) => canonical(a) === canonical(b);

function nep413Problem(intent: Extract<Intent, { standard: "nep413" }>, publicKey: string, signed: Record<string, unknown>) {
  if (!sameJson(signed.payload, intent.payload)) return "the signed message is not the one prepared";
  if (signed.public_key !== publicKey) return "signed with a key that isn't the owner's";
  if (typeof signed.signature !== "string") return "no signature";
  const { message, nonce, recipient } = intent.payload;
  return verifyEd25519(publicKey, nep413Hash(message, Buffer.from(nonce, "base64"), recipient), signatureBytes(signed.signature))
    ? null
    : "the signature doesn't verify";
}

function nep366Problem(intent: Extract<Intent, { standard: "nep366" }>, owner: { account_id: string; public_key: string }, signed: Record<string, unknown>) {
  if (typeof signed.signed_delegate !== "string") return "no signed delegate action";
  const bytes = Buffer.from(signed.signed_delegate, "base64");
  const { delegateAction: action, signature } = decodeSignedDelegateAction(bytes).signedDelegate;
  if (action.senderId !== owner.account_id) return "the delegate action is not from the owner's account";
  if (!("ed25519Key" in action.publicKey) || !Buffer.from(action.publicKey.ed25519Key.data).equals(rawKey(owner.public_key)))
    return "signed with a key that isn't the owner's";
  if (action.receiverId !== intent.payload.receiverId) return "the delegate action calls another contract";
  const expected = intent.payload.actions;
  if (action.actions.length !== expected.length) return "the delegate action holds other actions";
  for (const [i, a] of action.actions.entries()) {
    const { params } = expected[i]!;
    if (!("functionCall" in a)) return "the delegate action holds other actions";
    const call = a.functionCall;
    let args: unknown;
    try { args = JSON.parse(Buffer.from(call.args).toString("utf8")); } catch { return "the delegate action's arguments aren't JSON"; }
    if (call.methodName !== params.methodName || !sameJson(args, params.args) || call.gas !== BigInt(params.gas) || call.deposit !== BigInt(params.deposit))
      return "the delegate action is not the one prepared";
  }
  if (!("ed25519Signature" in signature)) return "not an Ed25519 signature";
  return verifyEd25519(owner.public_key, delegateSigningHash(bytes), Buffer.from(signature.ed25519Signature.data))
    ? null
    : "the signature doesn't verify";
}

export function ownerSignatureProblem(intent: Intent, signer: OwnerWallet, signed: Record<string, unknown>): string | null {
  if (signer.type !== "near") return `a ${signer.type} owner signs outside this dashboard`;
  if (signed.standard !== intent.standard) return "signed by another standard than the one prepared";
  try {
    if (intent.standard === "nep413") return nep413Problem(intent, signer.public_key, signed);
    if (intent.standard === "nep366") return nep366Problem(intent, signer, signed);
  } catch (error) {
    return `the signed data can't be read (${error instanceof Error ? error.message : "unknown"})`;
  }
  return `this dashboard signs NEAR intents only, not ${intent.standard}`;
}
