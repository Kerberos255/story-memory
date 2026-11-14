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

test('main API 503 enters cooldown while a permanent 401 remains manual-only',async()=>{
  const {ctx,cfg}=setup(1);
  cfg.api={...defaultSettings().api,mode:'main'};
  let calls=0;
  ctx.generateRaw=async()=>{calls++;throw Object.assign(Error('provider error'),{status:calls===1?503:401});};
  const q=new SummaryQueue(()=>ctx,()=>cfg,()=>{});
  try{
    q.enqueueAutomatic();await idle(q);
    const first=readMemory(ctx).tasks[1];
    assert.equal(first.status,'cooldown');
    assert.equal(first.code,'upstream_http_503');
    assert.equal(first.autoRetries,1);
    const task=readMemory(ctx);task.tasks[1].nextRetryAt=Date.now()-1;writeMemory(ctx,task);
    q.armRetry();await new Promise(r=>setTimeout(r,130));await idle(q);
    assert.equal(readMemory(ctx).tasks[1].status,'failed');
    assert.equal(readMemory(ctx).tasks[1].code,'upstream_http_401');
  }finally{q.cancel();}
});
test('explicitly restore hidden source text only when auto-hide is disabled, with rollback on save failure',async()=>{
  const {ctx,cfg}=setup(1);
  const message=ctx.chat[1],user=ctx.chat[0];
  for(const m of [user,message]){m.is_system=true;m.extra={story_memory_hidden:true};}
  let saves=0;ctx.saveChat=async()=>{saves++;};
  const q=new SummaryQueue(()=>ctx,()=>cfg,()=>{});
  try{
    cfg.summary.autoHide=true;
    await assert.rejects(()=>q.restoreAllHidden(),/关闭/);
    assert.equal(message.is_system,true);
    cfg.summary.autoHide=false;
    assert.equal(await q.restoreAllHidden(),2);
    assert.equal(message.is_system,false);
    assert.equal(user.is_system,false);
    assert.equal(message.extra.story_memory_hidden,undefined);
    assert.equal(saves,1);
    for(const m of [user,message]){m.is_system=true;m.extra={story_memory_hidden:true};}
    ctx.saveChat=async()=>{throw Error('disk unavailable');};
    assert.equal(await q.restoreAllHidden(),0);
    assert.equal(message.is_system,true,'failure rolls back in-memory visibility');
    assert.equal(user.extra.story_memory_hidden,true);
  }finally{q.cancel();}
});
test('queue retains checkpoint across transient failure and reuses completed chunks',async()=>{
  const {ctx,cfg}=setup(1);
  cfg.api={...defaultSettings().api,mode:'main'};
  ctx.chat[1].mes='开篇。'+('漫长的调查故事。'.repeat(2500))+'结尾。';
  let segment1=0,segment2=0,failed=false;
  ctx.generateRaw=async({prompt})=>{
    const txt=prompt[1].content;
    if(prompt[0].content.includes('同一楼层按时间顺序提取'))
      return JSON.stringify({summary:'最终整合'});
    if(txt.includes('原文 1/'))segment1++;
    else segment2++;
    if(txt.includes('原文 2/')&&!failed){failed=true;throw Object.assign(Error('503'),{status:503});}
    return JSON.stringify({summary:'已完成片段'});
  };
  const q=new SummaryQueue(()=>ctx,()=>cfg,()=>{});
  try{
    q.enqueue([1]);await idle(q);
    const task=readMemory(ctx).tasks[1];
    assert.equal(task.status,'cooldown');
    assert.equal(task.code,'upstream_http_503');
    assert.equal(task.checkpoint?.results.length,1);
    assert.equal(readMemory(ctx).leaves[1],undefined);
    q.enqueue([1]);await idle(q);
    assert.ok(readMemory(ctx).leaves[1]);
    assert.equal(segment1,1,'successful first part must not be retried');
    assert.ok(segment2>=2);
    assert.equal(readMemory(ctx).tasks[1],undefined);
  }finally{q.cancel();}
});

test('failed chapter compression reports an error and manual retry preserves all leaf sources',async()=>{
  const {ctx,cfg}=setup(1),memory=freshMemory();
  const {messageFingerprint}=await import('../core.js');
  cfg.api={...defaultSettings().api,mode:'main'};
  cfg.summary.leafBatchThreshold=12;cfg.summary.leafKeepRecent=0;
  ctx.chat=Array.from({length:12},(_,i)=>({is_user:false,mes:'剧情 '+i,swipe_id:0}));
  ctx.chat.forEach((msg,i)=>{
    memory.leaves[i]={id:'floor:'+i,sourceIndex:i,fingerprint:messageFingerprint(msg),
      summary:'第'+i+'楼关键剧情',delta:{items:[],scenes:[],characters:[],plans:[]}};
  });
  writeMemory(ctx,memory);
  let requests=0;
  ctx.generateRaw=async()=>{
    requests++;
    return requests<=2?'夸张重复的长摘要。'.repeat(1600):'最终精炼的全部剧情结论。';
  };
  const q=new SummaryQueue(()=>ctx,()=>cfg,()=>{});
  try{
    await q.maybeChapter(ctx.getCurrentChatId());
    const interrupted=readMemory(ctx);
    assert.equal(interrupted.chapters.length,0);
    assert.equal(Object.keys(interrupted.leaves).length,12,'failure does not delete source leaves');
    assert.equal(interrupted.chapterError?.code,'chapter_no_progress');
    assert.ok(interrupted.chapterPauseUntil>Date.now());
    assert.equal(await q.retryChapters(),true);
    const fixed=readMemory(ctx);
    assert.equal(fixed.chapters.length,1);
    assert.equal(fixed.chapters[0].summary,'最终精炼的全部剧情结论。');
    assert.equal(fixed.chapterError,undefined);
    assert.equal(fixed.chapterPauseUntil,0);
  }finally{q.cancel();}
});

test('manual chapter retry exposes busy state until compression finishes',async()=>{
  const {ctx,cfg}=setup(1),q=new SummaryQueue(()=>ctx,()=>cfg,()=>{});
  let finish;
  q.maybeChapter=()=>new Promise(resolve=>{finish=resolve;});
  const running=q.retryChapters();
  assert.equal(q.chapterRetryBusy,true);
  await assert.rejects(()=>q.retryChapters(),/正在整理楼层/);
  finish();
  assert.equal(await running,true);
  assert.equal(q.chapterRetryBusy,false);
  q.cancel();
});
