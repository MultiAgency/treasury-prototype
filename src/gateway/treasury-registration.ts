import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { BadRequest } from "../../shared/http.js";
import { mkdirSynced, writeAtomic } from "../synced.js";
import { accessOf, type Owner } from "./roles.js";
import type { AgentEntry } from "./config.js";

const account = z.string().regex(/^(([a-z0-9]+[-_])*[a-z0-9]+)(\.([a-z0-9]+[-_])*[a-z0-9]+)*$/).min(2).max(64);
const record = z.object({ owner: account, kind: z.enum(["wallet", "dao"]), name: z.string().regex(/^t-[a-f0-9]{20}$/), port: z.number().int().min(18000).max(18999) });
export type TreasuryRegistration = z.infer<typeof record>;
const nameOf = (owner: string) => `t-${createHash("sha256").update(owner).digest("hex").slice(0,20)}`;

/** Identity is established by sign-in; a DAO additionally requires current group proposal permission. */
export async function registrationOwner(accountId: string, input: unknown, lookup: (id: string) => Promise<Owner>) {
  const parsed = z.discriminatedUnion("kind", [z.object({ kind: z.literal("wallet") }).strict(), z.object({ kind: z.literal("dao"), dao: account }).strict()]).safeParse(input);
  if (!parsed.success) throw new BadRequest("Choose your NEAR account or enter a valid Sputnik DAO account.");
  if (parsed.data.kind === "wallet") return { owner: accountId, kind: "wallet" as const };
  const owner = await lookup(parsed.data.dao);
  if (!owner.policy || !accessOf(accountId, owner)?.canPropose) throw new BadRequest("A DAO group member with permission to propose owner actions must create this treasury.");
  return { owner: owner.account, kind: "dao" as const };
}

/** One owner per isolated directory. No provider action occurs during registration. */
export class TreasuryRegistry {
  readonly root: string;
  constructor(root: string, private readonly occupied: number[], private readonly max = 16) {
    this.root = resolve(root); mkdirSynced(this.root);
  }
  list(): TreasuryRegistration[] {
    const file = join(this.root, 'registry.json');
    const records = existsSync(file) ? z.array(record).max(this.max).parse(JSON.parse(readFileSync(file,'utf8'))) : [];
    if (new Set(records.map(r=>r.owner)).size !== records.length || new Set(records.map(r=>r.port)).size !== records.length || records.some(r=>r.name!==nameOf(r.owner) || this.occupied.includes(r.port))) throw new Error('Treasury registry identity or port conflict');
    if (records.some(r => !existsSync(join(this.directory(r), ".env.instance")))) throw new Error("Treasury settings are missing; restore preserved state before restarting.");
    return records;
  }
  register(owner: string, kind: 'wallet'|'dao') {
    account.parse(owner);
    const release = lockfile.lockSync(this.root, { realpath: true, retries: 0, stale: 60_000 });
    try {
      const records=this.list(), existing=records.find(r=>r.owner===owner);
      if(existing) { if(existing.kind!==kind) throw new BadRequest('Owner type differs from the existing treasury.'); return existing; }
      if(records.length>=this.max) throw new BadRequest('This prototype has reached its treasury capacity.');
      const used=new Set([...this.occupied,...records.map(r=>r.port)]);
      let port=18000; while(used.has(port) && port<=18999) port++;
      if(port>18999) throw new BadRequest('No treasury port is available.');
      const created=record.parse({owner,kind,name:nameOf(owner),port});
      const directory=this.directory(created); mkdirSynced(directory);
      const settings=join(directory,'.env.instance');
      // Existing state after an interrupted registration is preserved, never reset.
      if(!existsSync(settings)) writeAtomic(settings,`AUTOPILOT=off\nTREASURY_ACCOUNT=${kind==='dao'?owner:''}\n`,0o600);
      writeAtomic(join(this.root,'registry.json'),JSON.stringify([...records,created],null,2)+'\n',0o600);
      return created;
    } finally { release(); }
  }
  directory(r:TreasuryRegistration) { return join(this.root, r.name); }
  entry(r:TreasuryRegistration):AgentEntry { return {name:r.name,owner:r.owner,area:'treasury',port:r.port,executor:true,envFile:join(this.directory(r),'.env.instance')}; }
}

/** New instances never inherit another agent's credentials, owner keys, invoice server or schedule. */
export function registeredEnv(entry: AgentEntry, parent:NodeJS.ProcessEnv) {
  const names=['PATH','HOME','TMPDIR','NODE_ENV','NODE_OPTIONS','NEAR_INTENTS_AGENT_API_KEY','NEAR_INTENTS_AGENT_API_URL','NEARAI_API_KEY','FASTNEAR_API_KEY','NEAR_RPC_URL'];
  return {...Object.fromEntries(names.filter(k=>parent[k]!==undefined).map(k=>[k,parent[k]])),ENV_FILE:entry.envFile,PORT:String(entry.port),DASHBOARD_AREA:'treasury',AUTOPILOT:'off',EXECUTOR:parent.EXECUTOR==='off'?'off':'on'};
}

/** Pin setup to the selected owner even if a browser sends a modified RPC payload. */
export function checkRegisteredAction(r:TreasuryRegistration, body:Record<string,unknown>) {
  const input=z.object({json:z.object({signer:z.enum(['wallet','dao']),action:z.object({type:z.string(),role:z.string().optional(),owner:z.object({account_id:z.string()}).passthrough().optional()}).passthrough()}).passthrough()}).safeParse(body);
  if(!input.success) throw new BadRequest('Invalid owner action.');
  const {action,signer}=input.data.json;
  if(signer!==r.kind) throw new BadRequest('Use the selected treasury owner to sign.');
  if(action.type==='agent_create' && (action.role!=='treasury' || (r.kind==='wallet' ? action.owner?.account_id!==r.owner : action.owner!==undefined))) throw new BadRequest('Creation must use this treasury’s selected owner and treasury policy.');
}
