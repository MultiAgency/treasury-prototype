import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BadRequest } from "../shared/http.js";
import { writeDurable } from "./durable.js";

/**
 * Bearer tokens the owner issues for an outside agent (coordination/treasury-app-move.md, Answers 2): `read` and
 * `propose` only. No scope executes anything; the owner executes approved proposals. Adapted from the removed machine
 * credential store: secrets are returned once and kept only as hashes; each token is bound to this app's host, one
 * Organization, one agent and its provider agent ID, and the owner who issued it; it expires and can be revoked.
 */
export const RuntimeScope = z.enum(["read", "propose"]);
export type RuntimeScope = z.infer<typeof RuntimeScope>;
export const RuntimeIssue = z.strictObject({
  organization: z.string().min(1).max(128), agent: z.string().regex(/^[a-z0-9-]{1,64}$/),
  label: z.string().trim().min(1).max(80),
  scopes: z.array(RuntimeScope).min(1).max(2).refine(values => new Set(values).size === values.length, "Name each scope once"),
  ttlSeconds: z.number().int().min(60).max(86_400).default(3_600),
});
const Stored = RuntimeIssue.omit({ ttlSeconds: true }).extend({
  version: z.literal(1), id: z.uuid(), secretHash: z.string().regex(/^[a-f0-9]{64}$/), owner: z.string().min(2),
  agentId: z.string().min(1), host: z.string().min(1), createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  revoked: z.boolean(),
}).strict();
type Token = z.infer<typeof Stored>;
export type RuntimeToken = Omit<Token, "secretHash">;
const shown = ({ secretHash: _hash, ...token }: Token): RuntimeToken => token;
const hash = (value: string) => createHash("sha256").update(value).digest();
export const MAX_TOKENS = 1_024;

/** Reloads each record per request, so a revocation holds across restarts and processes. */
export class RuntimeTokens {
  constructor(private readonly root: string) {}

  private read(id: string): Token | null {
    if (!z.uuid().safeParse(id).success) return null;
    let text: string;
    try { text = readFileSync(join(this.root, `${id}.json`), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    // A damaged record authorizes nothing and hides no other token: it reads as absent (and can't be revoked here;
    // the operator archives it).
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return null; }
    const record = Stored.safeParse(parsed);
    if (!record.success || record.data.id !== id || record.data.expiresAt <= record.data.createdAt) return null;
    return record.data;
  }

  issue(input: z.input<typeof RuntimeIssue>, bound: { owner: string; agentId: string; host: string }, now = Date.now()) {
    const checked = RuntimeIssue.safeParse(input);
    if (!checked.success) throw new BadRequest("Give organization, agent, a label, read and/or propose scopes, and a lifetime of 60 to 86400 seconds.");
    const parsed = checked.data;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if ((statSync(this.root).mode & 0o077) !== 0) throw new Error("The runtime token directory must be private");
    if (readdirSync(this.root).filter(name => name.endsWith(".json")).length >= MAX_TOKENS)
      throw new BadRequest("Token storage is full. Archive expired or revoked tokens before issuing more.");
    const id = randomUUID(), secret = randomBytes(32).toString("base64url");
    const record = Stored.parse({ version: 1, id, secretHash: hash(secret).toString("hex"), organization: parsed.organization,
      agent: parsed.agent, label: parsed.label, scopes: parsed.scopes, owner: bound.owner, agentId: bound.agentId,
      host: bound.host.toLowerCase(), createdAt: now, expiresAt: now + parsed.ttlSeconds * 1_000, revoked: false });
    writeDurable(join(this.root, `${id}.json`), JSON.stringify(record) + "\n");
    return { token: shown(record), secret: `tat_${id}.${secret}` };
  }

  /** The live token a bearer header names on this host, or null. */
  authenticate(authorization: string | undefined, host: string, now = Date.now()): RuntimeToken | null {
    const match = authorization?.match(/^Bearer tat_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/);
    if (!match) return null;
    const record = this.read(match[1]!);
    if (!record || record.revoked || now >= record.expiresAt || record.host !== host.toLowerCase()) return null;
    return timingSafeEqual(hash(match[2]!), Buffer.from(record.secretHash, "hex")) ? shown(record) : null;
  }

  list(owner: string, organization: string, agent: string): RuntimeToken[] {
    let files: string[];
    try { files = readdirSync(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return files.filter(file => file.endsWith(".json")).map(file => this.read(file.slice(0, -5)))
      .filter((record): record is Token => record !== null && record.owner === owner && record.organization === organization && record.agent === agent)
      .map(shown);
  }

  /** Only the owner who issued a token revokes it; revoking needs no platform answer, so it works during an outage. */
  revoke(id: string, owner: string) {
    const record = this.read(id);
    if (!record || record.owner !== owner) return false;
    writeDurable(join(this.root, `${id}.json`), JSON.stringify({ ...record, revoked: true }) + "\n");
    return true;
  }
}
