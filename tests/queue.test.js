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
