import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer,type Server} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {AddressInfo} from 'node:net';
import {sessionToken} from '../shared/signin.js';
const listen=(s:Server)=>new Promise<number>((done,fail)=>{s.once('error',fail);s.listen(0,'127.0.0.1',()=>done((s.address() as AddressInfo).port));});

test('self-service gateway admits a new authenticated account, scopes its workspace and pins owner creation', {timeout:30000}, async()=>{
 const root=mkdtempSync(join(tmpdir(),'treasury-http-')),secret='offline-self-service-session-secret-at-least-32';
 const rpc=createServer((req,res)=>{let text='';req.on('data',c=>text+=c).on('end',()=>{const q=JSON.parse(text);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{name:'HANDLER_ERROR',cause:{name:'UNKNOWN_ACCOUNT',info:{}},code:-32000,message:'Unknown account'}}));});});
 const rpcPort=await listen(rpc);const probe=createServer();const port=await listen(probe);await new Promise<void>(done=>probe.close(()=>done()));
 const config=join(root,'dashboard.json');writeFileSync(config,JSON.stringify({host:'treasury.test',agents:[]}));
 const app=process.cwd();let output='';
 const child=spawn(join(app,'node_modules/.bin/tsx'),[join(app,'src/gateway/server.ts')],{cwd:root,env:{...process.env,PORT:String(port),DASHBOARD_FILE:config,SESSION_SECRET:secret,TREASURY_SELF_SERVICE:'true',NEAR_RPC_URL:`http://127.0.0.1:${rpcPort}`},stdio:['ignore','pipe','pipe']});
 child.stdout!.on('data',c=>output+=c);child.stderr!.on('data',c=>output+=c);
 const base=`http://127.0.0.1:${port}`;
 const auth=(account='alice.near')=>({cookie:`dao_session=${sessionToken(account,secret)}`});
 const post=(path:string,body:unknown,account='alice.near')=>fetch(base+path,{method:'POST',headers:{...auth(account),'content-type':'application/json'},body:JSON.stringify(body)});
 try{
  for(let n=0;n<100;n++){if(output.includes('on port'))break;if(child.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,50));}
  const fresh=await (await fetch(base+'/gw/me',{headers:auth()})).json() as any;
  assert.equal(fresh.viewer.account,'alice.near');assert.deepEqual(fresh.agents,[]);assert.equal(fresh.selfServiceTreasury,true);
  assert.equal((await fetch(base+'/gw/treasuries',{method:'POST',headers:{'content-type':'application/json'},body:'{"kind":"wallet"}'})).status,401);
  assert.equal((await fetch(base+'/gw/treasuries',{method:'POST',headers:{...auth(),origin:'https://elsewhere.test','content-type':'application/json'},body:'{"kind":"wallet"}'})).status,403);
  assert.equal((await post('/gw/treasuries',{kind:'dao',dao:'not-a-dao.near'})).status,400);
  const creation=await post('/gw/treasuries',{kind:'wallet'});assert.equal(creation.status,201);const {name}=await creation.json() as any;
  assert.deepEqual(await (await post('/gw/treasuries',{kind:'wallet'})).json(),{name});
  let me:any;
  for(let n=0;n<100;n++){me=await (await fetch(base+'/gw/me',{headers:auth()})).json();if(me.agents.length)break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(me.agents[0]?.owner,'alice.near',output);
  const other=await (await fetch(base+'/gw/me',{headers:auth('bob.near')})).json() as any;assert.deepEqual(other.agents,[]);
  assert.equal((await post(`/a/${name}/rpc/setup`,{},'bob.near')).status,403);
  assert.equal((await post(`/a/${name}/rpc/treasury/link`,{json:{accountId:'bob.near'}})).status,403);
  assert.equal((await post(`/a/${name}/rpc/owner/prepare`,{json:{signer:'wallet',action:{type:'agent_create',role:'treasury',owner:{type:'near',account_id:'bob.near',public_key:'bad'}}}})).status,400);
  const setup=await (await post(`/a/${name}/rpc/setup`,{})).json() as any;assert.equal(setup.json.agentId,null);assert.equal(setup.json.dao,null);
  assert.match(readFileSync(join(root,'.treasuries',name,'.env.instance'),'utf8'),/^AUTOPILOT=off/);
 }finally{
  const exited=new Promise<void>(done=>child.once('exit',()=>done()));child.kill('SIGTERM');await exited;
  rpc.closeAllConnections();await new Promise<void>(done=>rpc.close(()=>done()));rmSync(root,{recursive:true,force:true});
 }
});

// A replacement must wait for ownership rather than burn through Railway's restart attempts.
test('replacement gateway waits for the previous gateway lease before serving', {timeout:20000}, async()=>{
 const {default: lockfile}=await import('proper-lockfile');
 const {TreasuryRegistry}=await import('../src/gateway/treasury-registration.js');
 const root=mkdtempSync(join(tmpdir(),'treasury-rollout-'));
 const registry=new TreasuryRegistry(join(root,'.treasuries'),[]);
 let release:(()=>Promise<void>)|undefined=await lockfile.lock(registry.root,{lockfilePath:join(registry.root,'.gateway.lock'),stale:60000});
 const probe=createServer();const port=await listen(probe);await new Promise<void>(done=>probe.close(()=>done()));
 const config=join(root,'dashboard.json');writeFileSync(config,JSON.stringify({host:'treasury.test',agents:[]}));
 let output='';const app=process.cwd();
 const child=spawn(join(app,'node_modules/.bin/tsx'),[join(app,'src/gateway/server.ts')],{cwd:root,env:{...process.env,PORT:String(port),DASHBOARD_FILE:config,SESSION_SECRET:'offline-rollout-session-secret-at-least-32',TREASURY_SELF_SERVICE:'true'},stdio:['ignore','pipe','pipe']});
 child.stdout!.on('data',c=>output+=c);child.stderr!.on('data',c=>output+=c);
 try {
  await new Promise(r=>setTimeout(r,2500));
  assert.equal(child.exitCode,null,output);
  assert(!output.includes('on port'),'replacement must not serve while the lease is held');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  await release();release=undefined;
  for(let n=0;n<100&&!output.includes('on port');n++) { if(child.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,50)); }
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,200,output);
 } finally {
  if(child.exitCode===null){const exited=new Promise<void>(done=>child.once('exit',()=>done()));child.kill('SIGTERM');await exited;}
  await release?.();rmSync(root,{recursive:true,force:true});
 }
});
