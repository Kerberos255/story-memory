import test from 'node:test';
import assert from 'node:assert/strict';
import {SummaryQueue} from '../queue.js';
import {SummaryFailureNotifier,actionableSummaryFailures} from '../notifications.js';
import {pendingGroups} from '../pending-ui.js';
import {defaultSettings,freshMemory,readMemory,writeMemory,automaticFloorIndices,messageFingerprint} from '../core.js';

function setup(count=5){
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=> 'test-memory',
    saveMetadataDebounced(){},saveChat:async()=>{},
    getRequestHeaders:()=>({'Content-Type':'application/json'})};
  for(let i=0;i<count;i++)ctx.chat.push(
    {is_user:true,mes:'用户动作 '+i},{is_user:false,mes:'剧情回复 '+i,swipe_id:0});
  const cfg=defaultSettings();cfg.summary.retry=0;cfg.summary.delayFloors=0;
  cfg.summary.autoHide=false;cfg.summary.leafBatchThreshold=0;
  cfg.api={...cfg.api,mode:'custom',url:'http://127.0.0.1:9999/v1',key:'synthetic',model:'demo'};
  return {ctx,cfg};
}
async function idle(q){for(let i=0;i<100;i++){
  if(!q.busy&&!q.jobs.length)return;
  await new Promise(r=>setTimeout(r,10));
}throw Error('queue did not finish');}
const success=()=>({ok:true,json:async()=>({choices:[{message:{content:'{"summary":"已完成"}'}}]})});

test('transient failure cools down and retries without a new chat generation',async()=>{
  const {ctx,cfg}=setup(1),old=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;if(calls===1)throw Error('network temporarily lost');return success();};
  const q=new SummaryQueue(()=>ctx,()=>cfg,()=>{});
  try{
    q.enqueueAutomatic();await idle(q);
    const mem=readMemory(ctx);
    assert.equal(calls,1);assert.equal(mem.tasks[1].status,'cooldown');
    assert.equal(mem.tasks[1].autoRetries,1);
    assert.equal(mem.tasks[1].fingerprint,messageFingerprint(ctx.chat[1]));
    mem.tasks[1].nextRetryAt=Date.now()-1;writeMemory(ctx,mem);
    q.armRetry();
    await new Promise(r=>setTimeout(r,120));await idle(q);
    assert.equal(calls,2);assert.ok(readMemory(ctx).leaves[1]);
    assert.equal(readMemory(ctx).tasks[1],undefined,'completed task is cleared');
  }finally{q.cancel();globalThis.fetch=old;}
});
test('unrecoverable HTTP response becomes actionable and cannot starve later floors',async()=>{
  const {ctx,cfg}=setup(5),old=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return {ok:false,status:401};};
  const q=new SummaryQueue(()=>ctx,()=>cfg,()=>{});
  try{
    q.enqueue([1]);await idle(q);
    assert.equal(readMemory(ctx).tasks[1].status,'failed');
    assert.deepEqual(actionableSummaryFailures(ctx,readMemory(ctx)),[1]);
    const eligible=automaticFloorIndices(readMemory(ctx),ctx.chat,0);
    assert.ok(eligible.includes(3));assert.equal(eligible.includes(1),false);
    q.enqueueAutomatic(1);await idle(q);
    assert.equal(calls,2,'automatic work advances to the next unprocessed floor');
    q.enqueue([1]);await idle(q);
    assert.equal(calls,3,'manual retry always remains possible');
  }finally{q.cancel();globalThis.fetch=old;}
});
test('stale source fingerprint cannot keep a changed floor stuck in failed state',()=>{
  const {ctx,cfg}=setup(2),m=freshMemory();
  m.tasks[1]={status:'failed',updatedAt:10,code:'timeout',
    fingerprint:messageFingerprint(ctx.chat[1])};
  assert.deepEqual(pendingGroups(m,ctx.chat,cfg).groups.failed,[1]);
  ctx.chat[1].mes='修改后的剧情';
  assert.deepEqual(pendingGroups(m,ctx.chat,cfg).groups.failed,[]);
  assert.ok(automaticFloorIndices(m,ctx.chat,0).includes(1));
});
test('interrupted task resumes as cooldown instead of permanent running',()=>{
  const {ctx,cfg}=setup(1),m=freshMemory();
  m.tasks[1]={status:'running',fingerprint:messageFingerprint(ctx.chat[1]),attempts:1};
  writeMemory(ctx,m);
  const q=new SummaryQueue(()=>ctx,()=>cfg,()=>{});
  try{
    cfg.summary.delayFloors=2; // protect this floor from immediate resubmission
    q.resume();
    const task=readMemory(ctx).tasks[1];
    assert.equal(task.status,'cooldown');assert.equal(task.code,'interrupted');
    assert.ok(task.nextRetryAt>Date.now()-1000);
  }finally{q.cancel();}
});
test('notification is nonblocking, deduplicated by chat and failure cycle',()=>{
  const {ctx}=setup(1),mem=freshMemory(),records=[];
  mem.tasks[1]={status:'failed',code:'upstream_http_401',updatedAt:1234,
    fingerprint:messageFingerprint(ctx.chat[1])};
  const previous=globalThis.sessionStorage,storage=new Map();let opened=0;
  globalThis.sessionStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const toast={warning:(message,title,options)=>{records.push({message,title,options});}};
  try{
    const first=new SummaryFailureNotifier(()=>opened++);
    first.notify(ctx,mem,toast);first.notify(ctx,mem,toast);
    new SummaryFailureNotifier(()=>opened++).notify(ctx,mem,toast);
    assert.equal(records.length,1);
    assert.equal(records[0].options.closeButton,true);
    records[0].options.onclick();assert.equal(opened,1);
    mem.tasks[1].updatedAt++;
    first.notify(ctx,mem,toast);assert.equal(records.length,2);
    delete mem.tasks[1];first.notify(ctx,mem,toast);
    mem.tasks[1]={status:'failed',updatedAt:2000,fingerprint:messageFingerprint(ctx.chat[1])};
    first.notify(ctx,mem,toast);assert.equal(records.length,3);
  }finally{globalThis.sessionStorage=previous;}
});
test('missing toast service does not mark failure as already notified',()=>{
  const {ctx}=setup(1),mem=freshMemory(),records=[];
  mem.tasks[1]={status:'failed',code:'test',updatedAt:23};
  const notifier=new SummaryFailureNotifier(()=>{});
  notifier.notify(ctx,mem,null);
  notifier.notify(ctx,mem,{warning:()=>records.push('shown')});
  assert.deepEqual(records,['shown']);
});

test('retry wakeup only processes cooled failures, not unrelated pending floors',async()=>{
  const {ctx,cfg}=setup(4),old=globalThis.fetch,mem=freshMemory();
  mem.tasks[1]={status:'cooldown',code:'network_error',autoRetries:1,attempts:1,
    fingerprint:messageFingerprint(ctx.chat[1]),nextRetryAt:Date.now()-1};
  writeMemory(ctx,mem);
  let calls=0;globalThis.fetch=async()=>{calls++;return success();};
  const q=new SummaryQueue(()=>ctx,()=>cfg,()=>{});
  try{
    q.armRetry();
    await new Promise(r=>setTimeout(r,150));await idle(q);
    assert.equal(calls,1);
    assert.ok(readMemory(ctx).leaves[1]);
    assert.equal(readMemory(ctx).leaves[3],undefined);
  }finally{q.cancel();globalThis.fetch=old;}
});
