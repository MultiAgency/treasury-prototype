const {rpcAnswer}=require('./fixtures/rpc.cjs');
const {runTask}=require('./fixtures/task.cjs');
const assert=require('node:assert/strict');
const {join,resolve}=require('node:path');
const {mkdirSync}=require('node:fs');
async function treasuryCreation(browser,root){
 for(const kind of ['wallet','dao']){
  const page=await browser.newPage({viewport:{width:kind==='wallet'?1280:390,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(8000);
  await page.addInitScript(()=>{
   localStorage.setItem('member:selected-wallet:mainnet','fixture-wallet');
   window.walletConnects=0;
   const accounts=[{accountId:'owner.near',publicKey:'ed25519:11111111111111111111111111111111'}];
   const wallet={manifest:{id:'fixture-wallet',name:'Offline wallet',features:{signMessage:true,signDelegateActions:true},permissions:{}},getAccounts:async()=>accounts,signIn:async()=>{window.walletConnects++;return accounts},signOut:async()=>{},signMessage:async()=>{throw Error('Unexpected signing')},signAndSendTransaction:async()=>{throw Error('Unexpected onchain action')}};
   window.addEventListener('near-selector-ready',()=>window.dispatchEvent(new CustomEvent('near-wallet-injected',{detail:wallet})));
  });
  const name='t-aaaaaaaaaaaaaaaaaaaa',owner=kind==='wallet'?'owner.near':'team.sputnik-dao.near',requests=[],errors=[];
  let registered=false,prepared;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const {hostname,pathname:p}=new URL(route.request().url());if(hostname!=='frontend.test')return route.abort();
   if(p==='/gw/me')return route.fulfill({json:{selfServiceTreasury:true,agents:registered?[{name,owner,area:'treasury',dao:kind==='dao'}]:[],invoices:null,viewer:{account:'owner.near',access:registered?{[name]:{canSign:kind==='wallet',canPropose:kind==='dao',canVote:kind==='dao',canExecute:true,canManage:true}}:{}}}});
   if(p==='/gw/treasuries'){
    requests.push(p);assert.deepEqual(route.request().postDataJSON(),kind==='wallet'?{kind}:{kind,dao:owner});registered=true;return route.fulfill({json:{name}});
   }
   if(p.includes('/rpc/')){
    const method=p.split('/rpc/')[1];requests.push(method);
    if(method==='owner/prepare'){prepared=route.request().postDataJSON().json;return route.fulfill({status:400,json:{json:{defined:false,code:'BAD_REQUEST',message:'Offline check stopped before signing.'}}});}
    const values={setup:{executor:true,agentId:null,wallet:null,owner:null,grant:null,dao:kind==='dao'?{id:owner,funded:true,owner:{type:'near',account_id:'dao-signer',public_key:'fixture'}}:null},'owner/actions':[]};
    assert(method in values,`Unexpected RPC ${method}`);return route.fulfill({json: rpcAnswer(method, values[method])});
   }
   return route.fulfill({path:p.startsWith('/static/')?join(root,p):join(root,'index.html'),contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.startsWith('/static/')?'font/woff2':'text/html'});
  });
  await page.goto('http://frontend.test/');await page.getByRole('heading',{name:'Create your Treasury',exact:true}).waitFor();
  assert.deepEqual(requests,[]);
  const walletButton=page.getByRole('button',{name:'Wallet: owner.near',exact:true});
  await walletButton.waitFor();
  await walletButton.click();await page.getByRole('menuitem',{name:'Disconnect',exact:true}).waitFor();await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button',{name:'Connect wallet',exact:true}).count(),0);
  if(kind==='dao'){await page.getByRole('radio',{name:'A DAO',exact:true}).click();await page.getByLabel('DAO account').fill(owner);}
  const out=resolve(process.env.PROTO_BROWSER_ARTIFACTS || '.test-artifacts/treasury-ui');mkdirSync(out,{recursive:true});
  await page.screenshot({path:join(out,kind==='wallet'?'create-desktop.png':'create-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  const create=page.getByRole('button',{name:kind==='dao'?'Propose creating the agent':'Create agent',exact:true});
  await create.waitFor();
  await require('@playwright/test').expect(create).toBeEnabled();
  assert.equal(await page.getByRole('heading',{name:'Setup status',exact:true}).count(),0);
  assert.equal(await page.getByText('Payout agent.',{exact:true}).count(),0);
  assert.equal(await page.locator('header').count(),1,'keep only the logo and wallet header');
  assert.equal(await page.getByRole('button',{name:'Connect wallet',exact:true}).count(),0,'member connection also serves owner signing');
  assert.equal(await page.evaluate(()=>window.walletConnects),0,'restoring a supported member wallet must not reconnect');
  assert.equal(await page.getByRole('navigation',{name:'Treasury',exact:true}).count(),0);
  await page.screenshot({path:join(out,kind==='wallet'?'single-header-desktop.png':'single-header-mobile.png'),fullPage:true});
  assert(!requests.includes('owner/prepare'),'registration must not create or sign the agent');
  await create.click();
  await page.getByText('Offline check stopped before signing.',{exact:true}).first().waitFor();
  assert.equal(prepared.signer,kind);assert.equal(prepared.action.role,'treasury');
  if(kind==='wallet')assert.equal(prepared.action.owner.account_id,'owner.near');else assert.equal(prepared.action.owner,undefined);
  assert(!requests.includes('owner/submit'));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);await page.close();
 }
}
// Proto's hosted setup keeps a new agent closed until its server first answers: the first identity reads
// after `POST /gw/agents` list the agent without access. Continue waits for access for the same account
// before opening the workspace. `after` decides what the identity reads show once the agent is reserved:
// access after three reads, a sign-out, another account, or never any access (the wait's budget runs out).
function hostedSetup(after){
 const scenario=async(browser,root)=>{
 const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(8000);
 // A fake clock lets the 30 s budget pass quickly; it otherwise flows normally.
 if(after==='timeout')await page.clock.install();
 await page.addInitScript(()=>{
  localStorage.setItem('member:selected-wallet:mainnet','fixture-wallet');
  const accounts=[{accountId:'owner.near',publicKey:'ed25519:11111111111111111111111111111111'}];
  const wallet={manifest:{id:'fixture-wallet',name:'Offline wallet',features:{signMessage:true,signDelegateActions:true},permissions:{}},getAccounts:async()=>accounts,signIn:async()=>accounts,signOut:async()=>{},signMessage:async()=>{throw Error('Unexpected signing')},signAndSendTransaction:async()=>{throw Error('Unexpected onchain action')}};
  window.addEventListener('near-selector-ready',()=>window.dispatchEvent(new CustomEvent('near-wallet-injected',{detail:wallet})));
  // Survives the navigation into the workspace: any render of the refusal is recorded.
  new MutationObserver(()=>{if([...document.querySelectorAll('h1')].some(h=>h.textContent==='Access unavailable'))sessionStorage.setItem('saw-unavailable','1');}).observe(document,{childList:true,subtree:true});
 });
 const name='own-aaaaaaaaaaaaaaaaaaaaaaaa',errors=[],reservations=[],signed=[];
 let reserved=false,reads=0;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const {hostname,pathname:p}=new URL(route.request().url());if(hostname!=='frontend.test')return route.abort();
  if(p==='/gw/me'){
   const read=reserved?++reads:0;
   const account=reserved&&after==='switch'?'other.near':'owner.near';
   const viewer=reserved&&after==='signout'?null:{account,access:reserved&&after==='access'&&read>3?{[name]:{canSign:true,canPropose:false,canVote:false,canExecute:true,canManage:true}}:{}};
   return route.fulfill({json:{selfService:true,setupAreas:['treasury'],agents:reserved&&viewer?[{name,owner:'owner.near',area:'treasury',dao:false}]:[],invoices:null,viewer}});
  }
  if(p==='/gw/agents'){reservations.push(route.request().postDataJSON());reserved=true;return route.fulfill({json:{name}});}
  if(p==='/gw/treasuries')throw new Error('The copied backend route /gw/treasuries must not be called');
  if(p.includes('/rpc/')){
   const method=p.split('/rpc/')[1];if(['owner/prepare','owner/submit'].includes(method))signed.push(method);
   const values={setup:{executor:true,agentId:null,wallet:null,owner:null,grant:null,dao:null},'owner/actions':[]};
   assert(method in values,`Unexpected RPC ${method}`);return route.fulfill({json: rpcAnswer(method, values[method])});
  }
  return route.fulfill({path:p.startsWith('/static/')?join(root,p):join(root,'index.html'),contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.startsWith('/static/')?'font/woff2':'text/html'});
 });
 await page.goto('http://frontend.test/');await page.getByRole('heading',{name:'Create your Treasury',exact:true}).waitFor();
 const cont=page.getByRole('button',{name:'Continue',exact:true});
 await cont.click();
 if(after==='access'||after==='timeout'){
  if(after==='timeout')for(let i=0;i<40&&new URL(page.url()).pathname==='/';i++){await page.clock.fastForward(5000);await page.waitForTimeout(100);}
  if(after==='access')await page.getByRole('button',{name:'Create agent',exact:true}).waitFor({timeout:15000});
  else{await page.getByRole('heading',{name:'Access unavailable',exact:true}).waitFor();await page.getByRole('button',{name:'Check access again',exact:true}).waitFor();}
  assert.equal(new URL(page.url()).pathname,`/a/${name}/`);
  if(after==='access'){
   assert(reads>3,'the workspace opened only after access arrived');
   assert.equal(await page.evaluate(()=>sessionStorage.getItem('saw-unavailable')),null,'the new workspace must not show Access unavailable');
  }
 }else{
  // A sign-out or another account ends the wait where it is: no navigation, a plain message, Continue stays off.
  const message=after==='signout'?'You signed out before the new workspace opened.':'Another account signed in before the new workspace opened.';
  await page.getByText(message,{exact:false}).waitFor();
  await page.waitForTimeout(1500);
  assert.equal(new URL(page.url()).pathname,'/','the page must not open the workspace');
  assert.equal(await page.getByRole('button',{name:'Continue',exact:true}).isDisabled(),true,'Continue stays disabled, without a progress label: the agent is already reserved');
 }
 assert.deepEqual(reservations,[{owner:'owner.near',kind:'wallet',area:'treasury'}],'exactly one reservation');
 assert.deepEqual(signed,[],'nothing is signed while waiting');
 assert.deepEqual(errors,[]);await page.close();
 };
 Object.defineProperty(scenario,'name',{value:`hostedSetup_${after}`});
 return scenario;
}
runTask([treasuryCreation,...['access','signout','switch','timeout'].map(hostedSetup)]);
