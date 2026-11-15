// Dependency-free Edge/Chromium browser smoke + responsive screenshots.
// Run manually on Windows with: node tests/browser-smoke.mjs
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm,access,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const project=resolve(fileURLToPath(new URL('..',import.meta.url)));
const edge=process.env.EDGE_PATH||join(process.env['PROGRAMFILES(X86)']||process.env.ProgramFiles||'',
  'Microsoft','Edge','Application','msedge.exe');
await access(edge);
const profile=await mkdtemp(join(tmpdir(),'sm-edge-profile-'));
const shots=join(tmpdir(),'story-memory-ui-shots');
await mkdir(shots,{recursive:true});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    const path=resolve(project,'.'+decodeURIComponent(url.pathname));
    if(!path.startsWith(project+sep))throw Error('blocked path');
    const data=await readFile(path);
    const contentType={'.js':'text/javascript','.html':'text/html','.css':'text/css'}[extname(path)]||'text/plain';
    res.writeHead(200,{'Content-Type':contentType+'; charset=utf-8','Cache-Control':'no-store'});
    res.end(data);
  }catch{res.writeHead(404);res.end('not found');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port+'/tests/browser-harness.html';
const browser=spawn(edge,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
 '--remote-debugging-port=0','--remote-allow-origins=*','--user-data-dir='+profile,url],{stdio:'ignore'});
let ws=null,serial=0;
const pending=new Map();
function rpc(method,params={}){
  return new Promise((resolve,reject)=>{
    const id=++serial;
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},12000);
    pending.set(id,{done:data=>{clearTimeout(timer);resolve(data);},
      fail:error=>{clearTimeout(timer);reject(error);}});
    ws.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression){
  const reply=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(reply.exceptionDetails)throw Error('Browser JS: '+reply.exceptionDetails.text+' '+JSON.stringify(reply.exceptionDetails.exception||{}));
  return reply.result?.value;
}
const evalFn=(fn,...args)=>evaluate('(()=>{'+browserRoot.toString()+';'+navigate.toString()+
  ';return ('+fn.toString()+')('+args.map(x=>JSON.stringify(x)).join(',')+');})()');
const screenshots=[];
async function capture(name){
  const result=await rpc('Page.captureScreenshot',{format:'jpeg',quality:65,captureBeyondViewport:false});
  const target=join(shots,name+'.jpg');
  await writeFile(target,Buffer.from(result.data,'base64'));
  screenshots.push(target);
}
async function viewport(width,height){
  await rpc('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await sleep(120);
}
function browserRoot(){
  const root=document.getElementById('story-memory-host')?.shadowRoot;
  if(!root)throw Error('missing shadow root');
  return root;
}
function navigate(tab){
  const root=browserRoot();
  const btn=[...root.querySelectorAll('.sm-nav-item')].find(x=>x.textContent.trim()===tab);
  if(!btn)throw Error('missing nav: '+tab);
  btn.click();
  return root.querySelector('h2')?.textContent;
}
function checkTabsAndPreview(){
  const root=browserRoot(),headings=[];
  for(const tab of ['摘要','物品','场景','角色','计划','设置'])
    headings.push({tab,heading:navigate(tab)});
  navigate('角色');
  const card=root.querySelector('.sm-record');
  if(!card)throw Error('missing character card');
  const lazyBefore=Boolean(card.querySelector('.sm-entity-drawer-root'));
  card.open=true;card.dispatchEvent(new Event('toggle'));
  const lazyAfter=Boolean(card.querySelector('.sm-entity-drawer-root'));
  const tab=[...card.querySelectorAll('.sm-entity-tab')].find(x=>x.textContent.startsWith('人工纠错'));
  tab?.click();
  const correction=Boolean(card.querySelector('.sm-entity-correction-fields'));
  navigate('设置');
  const preview=[...root.querySelectorAll('button')].find(x=>x.textContent==='预览发送内容');
  if(!preview)throw Error('missing injection preview');
  preview.click();
  const modal=root.querySelector('.sm-injection-modal');
  return {headings,lazyBefore,lazyAfter,correction,preview:Boolean(modal),
    footer:Boolean(modal?.querySelector('.sm-record-modal-footer')),
    reader:Boolean(modal?.querySelector('[aria-label="发送预览内容"]'))};
}
function closePreviewAndToggleTheme(){
  const root=browserRoot();
  root.querySelector('.sm-record-modal-close')?.click();
  root.querySelector('.sm-top-actions .sm-icon-button')?.click();
  return root.querySelector('.sm-dialog').dataset.theme;
}
function openRole(){
  const root=browserRoot();
  navigate('角色');
  const card=root.querySelector('.sm-record');
  card.open=true;card.dispatchEvent(new Event('toggle'));
  return {open:card.open,tabs:root.querySelectorAll('.sm-entity-tab').length,
    theme:root.querySelector('.sm-dialog').dataset.theme};
}
function openPreview(){
  const root=browserRoot();
  navigate('设置');
  root.querySelector('.sm-injection-modal .sm-record-modal-close')?.click();
  const preview=[...root.querySelectorAll('button')].find(x=>x.textContent==='预览发送内容');
  preview?.click();
  return Boolean(root.querySelector('.sm-injection-modal'));
}
function layoutCheck(){
  const root=browserRoot(),panel=root.querySelector('.sm-injection-modal');
  const footer=panel.querySelector('.sm-record-modal-footer').getBoundingClientRect();
  const bounds=panel.getBoundingClientRect();
  return {width:innerWidth,footerWithin:footer.bottom<=bounds.bottom+2,
    horizontalOverflow:document.documentElement.scrollWidth>innerWidth+2};
}
try{
  let devtoolsPort=0;
  for(let i=0;i<100;i++){
    try{
      const content=await readFile(join(profile,'DevToolsActivePort'),'utf8');
      devtoolsPort=Number(content.split(/\r?\n/)[0]);if(devtoolsPort)break;
    }catch{}
    await sleep(100);
  }
  if(!devtoolsPort)throw Error('Edge DevTools did not start');
  let target=null;
  for(let i=0;i<60;i++){
    const pages=await fetch('http://127.0.0.1:'+devtoolsPort+'/json/list').then(r=>r.json()).catch(()=>[]);
    target=pages.find(p=>p.type==='page'&&p.url.includes('browser-harness.html'));
    if(target)break;
    await sleep(150);
  }
  if(!target)throw Error('Browser harness page missing');
  ws=new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('message',event=>{
    const message=JSON.parse(String(event.data)),waiting=pending.get(message.id);
    if(!waiting)return;
    pending.delete(message.id);
    if(message.error)waiting.fail(Error(JSON.stringify(message.error)));
    else waiting.done(message.result);
  });
  await new Promise((resolve,reject)=>{
    ws.addEventListener('open',resolve,{once:true});
    ws.addEventListener('error',reject,{once:true});
  });
  await rpc('Runtime.enable');await rpc('Page.enable');
  let ready=false;
  for(let i=0;i<80;i++){
    ready=await evaluate('Boolean(window.smReady)').catch(()=>false);
    if(ready)break;
    await sleep(100);
  }
  if(!ready)throw Error('SillyTavern mock page failed to mount');
  await viewport(1365,768);
  const checks=await evalFn(checkTabsAndPreview);
  assert.deepEqual(checks.headings.map(x=>x.tab),['摘要','物品','场景','角色','计划','设置']);
  assert.equal(checks.lazyBefore,false);
  assert.equal(checks.lazyAfter,true);
  assert.equal(checks.correction,true);
  assert.equal(checks.preview,true);
  assert.equal(checks.footer,true);
  assert.equal(checks.reader,true);
  await sleep(160);await capture('desktop-dark-preview');
  assert.equal(await evalFn(closePreviewAndToggleTheme),'light');
  await capture('desktop-light-settings');
  const role=await evalFn(openRole);
  assert.equal(role.open,true);assert.equal(role.theme,'light');
  await capture('desktop-light-character');
  await viewport(390,844);await capture('mobile-light-character');
  assert.equal(await evalFn(closePreviewAndToggleTheme),'dark');
  await capture('mobile-dark-character');
  await viewport(320,568);
  assert.equal(await evalFn(openPreview),true);
  await sleep(100);
  const narrow=await evalFn(layoutCheck);
  assert.equal(narrow.footerWithin,true);
  assert.equal(narrow.horizontalOverflow,false);
  await capture('small-dark-preview');
  console.log(JSON.stringify({passed:true,checks,narrow,screenshots}));
}finally{
  ws?.close();browser.kill();
  await new Promise(resolve=>server.close(resolve));
  await rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:100}).catch(()=>{});
}
