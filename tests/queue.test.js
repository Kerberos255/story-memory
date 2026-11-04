import test from 'node:test';
import assert from 'node:assert/strict';
import {SummaryQueue} from '../queue.js';
import {defaultSettings,freshMemory,writeMemory,readMemory,pendingFloors,messageFingerprint,deriveState} from '../core.js';
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
test('manual backfill also updates items, scenes and characters, but skips completed floors',async()=>{
  const f=fixture(),oldFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({
      summary:'角色拿着钥匙进入古堡',
      items:[{op:'add',name:'铜钥匙',owner:'主角'}],
      scenes:[{op:'add',name:'古堡大厅',description:'有高窗的大厅'}],
      characters:[{op:'add',name:'守门人',status:'看见主角进门'}]
    })}}]})};
  };
  try{
    const q=new SummaryQueue(()=>f.ctx,()=>f.settings,()=>{});
    q.enqueueMissing(5);await idle(q);
    const memory=readMemory(f.ctx),state=deriveState(memory,f.ctx.chat);
    assert.equal(calls,1);
    assert.equal(memory.leaves[1].delta.items.length,1);
    assert.equal(memory.leaves[1].delta.scenes.length,1);
    assert.equal(memory.leaves[1].delta.characters.length,1);
    assert.equal(state.items[0].name,'铜钥匙');
    assert.equal(state.scenes[0].name,'古堡大厅');
    assert.equal(state.characters[0].name,'守门人');
    q.enqueueMissing(5);await idle(q);
    assert.equal(calls,1,'completed floor is not processed again by manual backfill');
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

test('deleting a hidden generated leaf restores excluded AI and corresponding user text',async()=>{
 const {deleteGeneratedLeaf,userFingerprint,commitLeaf,normalizeDelta}=await import('../core.js');
 const f=fixture(),chat=[];
 for(let i=0;i<5;i++)chat.push({is_user:true,mes:'用户输入 '+i},{is_user:false,mes:'AI 剧情 '+i,swipe_id:0});
 f.ctx.chat=chat;
 let saves=0;f.ctx.saveChat=async()=>{saves++;};
 let mem=commitLeaf(freshMemory(),1,messageFingerprint(chat[1]),
   normalizeDelta({summary:'第一段摘要'}),userFingerprint(chat,1));
 writeMemory(f.ctx,mem);
 chat[0].is_system=true;chat[0].extra={story_memory_hidden:true};
 chat[1].is_system=true;chat[1].extra={story_memory_hidden:true};
 mem=deleteGeneratedLeaf(readMemory(f.ctx),chat,1);
 writeMemory(f.ctx,mem);
 const q=new SummaryQueue(()=>f.ctx,()=>f.settings,()=>{});
 const restored=await q.restoreStale();
 assert.equal(restored,2);
 assert.equal(saves,1);
 assert.equal(chat[0].is_system,false);
 assert.equal(chat[1].is_system,false);
 assert.ok(!pendingFloors(readMemory(f.ctx),chat).includes(1),
   'deleted floor remains skipped until explicit retry or source change');
});

test('one-floor-at-a-time manual backfill persists character and item changes',async()=>{
  const f=fixture(),oldFetch=globalThis.fetch;let call=0;
  f.ctx.chat.push({is_user:true,mes:'守门人带着大家到了大厅。'},
    {is_user:false,mes:'守门人走进古堡大厅，取出了第二件物品。',swipe_id:0});
  globalThis.fetch=async()=>{
    const data=++call===1?
      {summary:'主角拿到铜钥匙',delta:{items:[{op:'add',name:'铜钥匙',owner:'主角'}],characters:[{op:'add',name:'守门人'}]}}:
      {summary:'守门人带大家到大厅',entities:{scenes:[{op:'add',name:'古堡大厅'}],items:[{op:'add',name:'银杯'}]}};
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(data)}}]})};
  };
  try{
    const q=new SummaryQueue(()=>f.ctx,()=>f.settings,()=>{});
    q.enqueue([1]);await idle(q);
    assert.equal(call,1);
    assert.equal(deriveState(readMemory(f.ctx),f.ctx.chat).items[0]?.name,'铜钥匙');
    assert.equal(deriveState(readMemory(f.ctx),f.ctx.chat).characters[0]?.name,'守门人');
    q.enqueue([3]);await idle(q);
    assert.equal(call,2);
    const state=deriveState(readMemory(f.ctx),f.ctx.chat);
    assert.deepEqual(state.items.map(x=>x.name).sort(),['铜钥匙','银杯']);
    assert.equal(state.scenes[0]?.name,'古堡大厅');
    assert.equal(state.characters[0]?.name,'守门人');
    assert.equal(Object.keys(readMemory(f.ctx).leaves).length,2);
  }finally{globalThis.fetch=oldFetch;}
});

test('legacy source cap is ignored; a network failure still keeps the floor pending',async()=>{
  const f=fixture(),oldFetch=globalThis.fetch;let sent=0;
  f.settings.summary.maxInputChars=2000;
  f.ctx.chat[1].mes='正文关键开头：'+('很长的故事。'.repeat(340))+'结尾决定：归还钥匙。';
  globalThis.fetch=async()=>{sent++;throw Error('API must not be called for oversized input');};
  try{
    const q=new SummaryQueue(()=>f.ctx,()=>f.settings,()=>{});
    q.enqueue([1]);await idle(q);
    const mem=readMemory(f.ctx);
    assert.equal(sent,1);
    assert.equal(mem.leaves[1],undefined);
    assert.equal(mem.tasks[1].status,'failed');
    assert.equal(mem.tasks[1].code,'network_error');
    assert.deepEqual(pendingFloors(mem,f.ctx.chat),[1]);
  }finally{globalThis.fetch=oldFetch;}
});

test('manual queue commits long floor entities only after all extraction and merge calls finish',async()=>{
  const f=fixture(),previousFetch=globalThis.fetch;
  f.ctx.chat[0].mes='玩家第一次开口。';
  f.ctx.chat[1].mes='开头拿到蓝色地图。'+('在山路上行走。'.repeat(3400))+'最后遇见引路人。';
  const sent=[];
  globalThis.fetch=async (_url,{body})=>{
    const payload=JSON.parse(body),content=payload.messages[1].content;
    sent.push(content);
    const merge=payload.messages[0].content.includes('同一楼层按时间顺序提取');
    const story=merge?{summary:'携带蓝色地图，在山路最后遇见引路人。'}:
      content.includes('原文 1/')?
        {summary:'拿到蓝色地图',items:[{op:'add',name:'蓝色地图'}]}:
        content.includes('最后遇见引路人。')?
          {summary:'遇见引路人',characters:[{op:'add',name:'引路人'}]}:
          {summary:'山路经过'};
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(story)}}]})};
  };
  try{
    const q=new SummaryQueue(()=>f.ctx,()=>f.settings,()=>{});
    q.enqueue([1]);await idle(q);
    const memory=readMemory(f.ctx),state=deriveState(memory,f.ctx.chat);
    assert.ok(sent.length>=3);
    assert.equal(memory.leaves[1].sourceComplete,true);
    assert.ok(memory.leaves[1].sourceParts.length>1);
    assert.ok(sent.some(x=>x.includes('开头拿到蓝色地图。')));
    assert.ok(sent.some(x=>x.includes('最后遇见引路人。')));
    assert.ok(state.items.some(x=>x.name==='蓝色地图'));
    assert.ok(state.characters.some(x=>x.name==='引路人'));
    assert.equal(memory.tasks[1],undefined);
  }finally{globalThis.fetch=previousFetch;}
});


test('deleting a covered AI message restores its orphaned hidden user input',async()=>{
  let saves=0;
  const ctx={chat:[{is_user:true,is_system:true,mes:'打算进入塔楼',extra:{story_memory_hidden:true}}],
    chatMetadata:{},getCurrentChatId:()=> 'orphaned-input',saveChat:async()=>{saves++;}};
  const q=new SummaryQueue(()=>ctx,defaultSettings,()=>{});
  const restored=await q.restoreStale();
  assert.equal(restored,1);
  assert.equal(saves,1);
  assert.equal(ctx.chat[0].is_system,false);
  assert.equal(ctx.chat[0].extra.story_memory_hidden,undefined);
});
