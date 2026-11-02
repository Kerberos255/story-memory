import test from 'node:test';
import assert from 'node:assert/strict';
import {SummaryQueue} from '../queue.js';
import {defaultSettings,readMemory,pendingFloors} from '../core.js';
function fixture(){
 let id='chat-1',saved=0;
 const ctx={
   chat:[{is_user:true,is_system:false,mes:'找到一枚钥匙。'},{is_user:false,is_system:false,mes:'拿着钥匙走进房间。',swipe_id:0}],
   chatMetadata:{},getCurrentChatId:()=>id,getRequestHeaders:()=>({'Content-Type':'application/json'}),saveMetadataDebounced:()=>{saved++;}
 };
 const settings=defaultSettings();settings.summary.retry=0;settings.summary.chapterEvery=30;
 settings.api={...settings.api,mode:'custom',url:'http://127.0.0.1:9999/v1',key:'synthetic-test-only',model:'test-model'};
 return {ctx,settings,setChatId:newId=>{id=newId;},getSaved:()=>saved};
}
async function idle(queue){
 for(let i=0;i<100;i++){if(!queue.busy&&!queue.jobs.length)return;await new Promise(r=>setTimeout(r,10));}
 throw Error('summary queue not idle');
}
test('queue commits a validated summary and reprocessing does nothing',async()=>{
 const f=fixture(),oldFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return{ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({summary:'角色取得钥匙',items:[{op:'add',name:'钥匙',quantity:1}]})}}]})};};
 try{
   const q=new SummaryQueue(()=>f.ctx,()=>f.settings,()=>{});
   q.enqueue([1]);await idle(q);
   assert.equal(calls,1);assert.equal(readMemory(f.ctx).leaves[1].summary,'角色取得钥匙');
   q.enqueue([1]);await idle(q);assert.equal(calls,1);
   assert.equal(f.getSaved()>0,true);
 }finally{globalThis.fetch=oldFetch;}
});
test('HTTP 400 preserves pending floor, never applies partial state',async()=>{
 const f=fixture(),oldFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return{ok:false,status:400};};
 try{
   const q=new SummaryQueue(()=>f.ctx,()=>f.settings,()=>{});
   q.enqueue([1]);await idle(q);
   const memory=readMemory(f.ctx);
   assert.equal(calls,1);
   assert.equal(memory.leaves[1],undefined);
   assert.equal(memory.tasks[1].code,'upstream_http_400');
   assert.deepEqual(pendingFloors(memory,f.ctx.chat),[1]);
 }finally{globalThis.fetch=oldFetch;}
});
test('swipe changed during response cannot commit outdated memory',async()=>{
 const f=fixture(),oldFetch=globalThis.fetch;let finish;
 globalThis.fetch=()=>new Promise(resolve=>{finish=resolve;});
 try{
   const q=new SummaryQueue(()=>f.ctx,()=>f.settings,()=>{});
   q.enqueue([1]);await new Promise(r=>setTimeout(r,20));
   f.ctx.chat[1].swipe_id=1;f.ctx.chat[1].mes='人物没有拿钥匙。';
   finish({ok:true,json:async()=>({choices:[{message:{content:'{"summary":"拿到了钥匙"}'}}]})});
   await idle(q);
   assert.equal(readMemory(f.ctx).leaves[1],undefined);
 }finally{globalThis.fetch=oldFetch;}
});

test('auto pipeline delays three AI floors and hides only confirmed older floors',async()=>{
 const f=fixture(),oldFetch=globalThis.fetch;
 const chat=[];
 for(let i=0;i<5;i++)chat.push({is_user:true,mes:'用户 '+i},{is_user:false,mes:'AI 回复 '+i,swipe_id:0});
 f.ctx.chat=chat;
 let saved=0,calls=0;
 f.ctx.saveChat=async()=>{saved++;};
 f.settings.autoSummary=true;f.settings.summary.delayFloors=3;f.settings.summary.keepRecent=3;
 f.settings.summary.autoHide=true;
 globalThis.fetch=async()=>{
   calls++;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({summary:'合成剧情 '+calls})}}]})};
 };
 try{
   const q=new SummaryQueue(()=>f.ctx,()=>f.settings,()=>{});
   q.enqueueAutomatic();await idle(q);
   const mem=readMemory(f.ctx);
   assert.equal(calls,2);
   assert.deepEqual(Object.keys(mem.leaves).map(Number).sort((a,b)=>a-b),[1,3]);
   assert.equal(saved>=1,true);
   assert.equal(chat[1].is_system,true);assert.equal(chat[3].is_system,true);
   assert.equal(chat[0].is_system,true);assert.equal(chat[2].is_system,true);
   assert.equal(Boolean(chat[5].is_system),false);
   assert.equal(pendingFloors(mem,chat).length,3);
 }finally{globalThis.fetch=oldFetch;}
});
test('hide save failure reverts all original visibility flags',async()=>{
 const f=fixture(),oldFetch=globalThis.fetch;
 const chat=[];
 for(let i=0;i<4;i++)chat.push({is_user:true,mes:'用户 '+i},{is_user:false,mes:'AI 回复 '+i});
 f.ctx.chat=chat;
 f.ctx.saveChat=async()=>{throw Error('synthetic-save-failure');};
 f.settings.summary.autoHide=true;
 globalThis.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:'{"summary":"剧情完成"}'}}]})});
 try{
   const q=new SummaryQueue(()=>f.ctx,()=>f.settings,()=>{});
   q.enqueue([1]);await idle(q);
   assert.ok(readMemory(f.ctx).leaves[1]);
   assert.equal(chat[1].is_system,false);
   assert.equal(chat[0].is_system,false);
   assert.equal(chat[1].extra?.story_memory_hidden,undefined);
   assert.match(q.hideError,/未保存/);
 }finally{globalThis.fetch=oldFetch;}
});

test('editing hidden source restores user and AI visibility, triggering resummary',async()=>{
 const f=fixture(),oldFetch=globalThis.fetch;
 const chat=[];
 for(let i=0;i<4;i++)chat.push({is_user:true,mes:'用户 '+i},{is_user:false,mes:'AI 回复 '+i,swipe_id:0});
 f.ctx.chat=chat;
 let saved=0;f.ctx.saveChat=async()=>{saved++;};
 f.settings.summary.autoHide=true;
 globalThis.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:'{"summary":"旧剧情摘要"}'}}]})});
 try{
   const q=new SummaryQueue(()=>f.ctx,()=>f.settings,()=>{});
   q.enqueue([1]);await idle(q);
   assert.equal(chat[1].is_system,true);assert.equal(chat[0].is_system,true);
   chat[0].mes='修改后的用户信息';
   assert.ok(pendingFloors(readMemory(f.ctx),chat).includes(1));
   const restored=await q.restoreStale();
   assert.equal(restored,2);
   assert.equal(chat[0].is_system,false);
   assert.equal(chat[1].is_system,false);
   assert.equal(chat[1].extra?.story_memory_hidden,undefined);
   assert.equal(saved>=2,true);
 }finally{globalThis.fetch=oldFetch;}
});

test('user message edited during API request cannot commit stale summary or hide content',async()=>{
 const f=fixture(),oldFetch=globalThis.fetch;
 let finish;
 f.settings.summary.autoHide=true;
 f.ctx.saveChat=async()=>{throw Error('hide should never be called');};
 globalThis.fetch=()=>new Promise(resolve=>{finish=resolve;});
 try{
   const q=new SummaryQueue(()=>f.ctx,()=>f.settings,()=>{});
   q.enqueue([1]);
   await new Promise(r=>setTimeout(r,20));
   f.ctx.chat[0].mes='用户已更改问题';
   finish({ok:true,json:async()=>({choices:[{message:{content:'{"summary":"基于旧问题的摘要"}'}}]})});
   await idle(q);
   assert.equal(readMemory(f.ctx).leaves[1],undefined);
   assert.equal(Boolean(f.ctx.chat[0].is_system),false);
   assert.equal(Boolean(f.ctx.chat[1].is_system),false);
 }finally{globalThis.fetch=oldFetch;}
});
