import test from 'node:test';
import assert from 'node:assert/strict';
import {
  freshMemory,commitLeaf,messageFingerprint,normalizeDelta,deriveState,
  correctEntity,clearEntityCorrection,defaultSettings,injectionText
} from '../core.js';
import {candidates} from '../vector-local.js';
import {selectHistory,lexicalSearch,sourceEvidence} from '../retrieval-local.js';
import {VectorIndexScheduler} from '../vector-index-scheduler.js';

function add(memory,chat,index,summary,delta={}){
  return commitLeaf(memory,index,messageFingerprint(chat[index]),normalizeDelta({summary,...delta}));
}
test('field-level lock retains identity and owner while newer plot updates unlocked fields',()=>{
  const chat=[
    {is_user:false,mes:'银戒指由艾琳保管。',swipe_id:0},
    {is_user:false,mes:'艾琳把银戒指交给主角，戒指变成红色。',swipe_id:0}
  ];
  let memory=add(freshMemory(),chat,0,'艾琳得到银戒指',{items:[
    {op:'add',name:'银戒指',owner:'艾琳',description:'白银',evidence:'银戒指由艾琳保管。'}]});
  const entity=deriveState(memory,chat).items[0];
  memory=correctEntity(memory,chat,'items',entity.entity_id,
    {name:'月银戒指',owner:'艾琳'}, {name:true,owner:true});
  assert.equal(deriveState(memory,chat).items[0].name,'月银戒指');
  memory=add(memory,chat,1,'戒指交接',{items:[
    {op:'update',name:'银戒指',entity_id:entity.entity_id,owner:'主角',description:'红色',evidence:'艾琳把银戒指交给主角'}]});
  let current=deriveState(memory,chat).items[0];
  assert.equal(current.name,'月银戒指');
  assert.equal(current.owner,'艾琳');
  assert.equal(current.description,'红色');
  assert.deepEqual(current.lockedFields,['name','owner']);
  assert.equal(current.lockConflicts.length,1);
  assert.equal(current.lockConflicts[0].field,'owner');
  assert.doesNotMatch(injectionText(memory,chat,defaultSettings()),/lockedFields|lockConflicts/);
  memory=correctEntity(memory,chat,'items',entity.entity_id,
    {name:'月银戒指',owner:'艾琳'}, {name:true,owner:false});
  current=deriveState(memory,chat).items[0];
  assert.equal(current.owner,'主角','unlocking stale owner should adopt latest extraction');
  assert.equal(current.name,'月银戒指');
  assert.equal(current.lockConflicts,undefined);
  memory=clearEntityCorrection(memory,'items',entity.entity_id);
  current=deriveState(memory,chat).items[0];
  assert.equal(current.name,'银戒指');
  assert.equal(current.owner,'主角');
});
test('unlocking a repeatedly reaffirmed field lock restores the latest extracted value',()=>{
  const chat=[{is_user:false,mes:'守门人曾是盟友',swipe_id:0},
    {is_user:false,mes:'守门人转而成为敌人',swipe_id:0}];
  let mem=add(freshMemory(),chat,0,'结盟',{characters:[{op:'add',name:'守门人',relationship:'朋友'}]});
  const id=deriveState(mem,chat).characters[0].entity_id;
  mem=correctEntity(mem,chat,'characters',id,{relationship:'盟友'},{relationship:true});
  mem=add(mem,chat,1,'背叛',{characters:[{op:'update',name:'守门人',entity_id:id,relationship:'敌对'}]});
  assert.equal(deriveState(mem,chat).characters[0].lockConflicts?.length,1);
  mem=correctEntity(mem,chat,'characters',id,{relationship:'盟友'},{relationship:true});
  assert.equal(deriveState(mem,chat).characters[0].lockConflicts,undefined,
    'explicit reaffirmation resolves the conflict warning');
  mem=correctEntity(mem,chat,'characters',id,{relationship:'盟友'},{relationship:false});
  assert.equal(deriveState(mem,chat).characters[0].relationship,'敌对',
    'later unlock must restore plot facts regardless of reaffirmation count');
});

test('checkpoint replay matches full replay after source edits, leaf replacements, alias and correction changes',()=>{
  const chat=[],memory=freshMemory();
  for(let i=0;i<270;i++){
    chat.push({is_user:false,mes:'剧情'+i,swipe_id:0});
    const change=i%11===0?{characters:[{op:i===0?'add':'update',name:'守门人',
      status:'状态'+i,evidence:'剧情'+i}]}:{};
    const normalized=normalizeDelta({summary:'第'+i+'幕',...change});
    memory.leaves[i]={id:'floor:'+i,sourceIndex:i,fingerprint:messageFingerprint(chat[i]),
      summary:normalized.summary,delta:normalized.delta};
  }
  assert.ok(deriveState(memory,chat).characters.length);
  const expected=()=>deriveState(memory,chat.slice());
  assert.deepEqual(deriveState(memory,chat),expected());
  chat[44].mes='修改了旧剧情';
  assert.deepEqual(deriveState(memory,chat),expected(),
    'a source changed before the cached checkpoint must invalidate it');
  memory.leaves[44]={...memory.leaves[44],fingerprint:messageFingerprint(chat[44]),summary:'修订第44幕'};
  assert.deepEqual(deriveState(memory,chat),expected());
  memory.entityAliases={characters:{守门人:{name:'守门人',to:'守门人'}}};
  assert.deepEqual(deriveState(memory,chat),expected(),'alias settings invalidate the checkpoint');
  const entity=deriveState(memory,chat).characters[0];
  const corrected=correctEntity(memory,chat,'characters',entity.entity_id,{status:'用户确认'});
  assert.equal(deriveState(corrected,chat).characters[0].status,'用户确认');
  assert.equal(deriveState(memory,chat).characters[0].status,entity.status);
});
test('current entity facts and knowledge participate in local recall while stale swipes are excluded',()=>{
  const chat=[
    {is_user:false,mes:'艾琳得知北塔藏着密道。',swipe_id:0},
    {is_user:false,mes:'艾琳把戒指交给主角。',swipe_id:0}
  ];
  let memory=add(freshMemory(),chat,0,'艾琳得知北塔秘密',{characters:[
    {op:'add',name:'艾琳',knowledge:[{fact:'北塔有密道',stance:'knows',evidence:'北塔藏着密道'}]}]});
  memory=add(memory,chat,1,'戒指完成交接',{items:[
    {op:'add',name:'银戒指',owner:'主角',evidence:'戒指交给主角'}]});
  const ctx={chat,chatMetadata:{story_memory_v1:memory},getCurrentChatId:()=> 'next-stage-local'};
  const docs=candidates(ctx,memory);
  const entity=docs.find(x=>x.key.startsWith('entity:characters:'));
  assert.ok(entity?.text.includes('北塔有密道'));
  assert.ok(docs.some(x=>x.key.startsWith('entity:items:')&&x.text.includes('主角')));
  const local=selectHistory(ctx,memory,'艾琳知道北塔的秘密吗',[],8);
  assert.ok(local.some(x=>x.kind==='entity'&&x.summary.includes('北塔有密道')));
  const source=sourceEvidence(ctx,memory,local.find(x=>x.kind==='entity'),'北塔',3);
  assert.ok(source.some(x=>x.index===0));
  chat[0].swipe_id=1;chat[0].mes='艾琳不知道密道';
  const revised=selectHistory(ctx,memory,'艾琳知道北塔的秘密吗',[],8);
  assert.ok(!revised.some(x=>x.kind==='entity'&&x.summary.includes('北塔有密道')));
  assert.ok(!candidates(ctx,memory).some(x=>x.text.includes('北塔有密道')));
  assert.ok(!lexicalSearch(ctx,memory,'北塔有密道').some(x=>x.key==='floor:0'));
});
test('background indexer batches, defers retries and does not call APIs while vector is disabled',async()=>{
  let enabled=true;
  const settings=defaultSettings();settings.vector.enabled=true;
  const memory=freshMemory(),ctx={getCurrentChatId:()=> 'scheduler-test',chatMetadata:{story_memory_v1:memory}};
  const seen=[],scripted=[2,2,0];
  const scheduler=new VectorIndexScheduler(()=>ctx,()=>({...settings,enabled}),
    async (_ctx,_memory,_cfg,signal,options)=>{
      seen.push({signal,options});return scripted.shift()??0;
    },{delay:1,pace:1,batch:2});
  scheduler.schedule();
  await new Promise(r=>setTimeout(r,45));
  assert.equal(seen.length,3);
  assert.ok(seen.every(x=>x.options.maxRecords===2));
  assert.ok(seen.every(x=>x.options.full===true));
  enabled=false;
  scheduler.schedule();
  await new Promise(r=>setTimeout(r,12));
  assert.equal(seen.length,3,'disabled memory never triggers an embedding request');
  scheduler.cancel();
});
test('background indexer aborts in-flight work after chat changes and never retries failed jobs immediately',async()=>{
  let finish,called=0;
  const settings=defaultSettings();settings.vector.enabled=true;
  const memory=freshMemory(),ctx={getCurrentChatId:()=> 'scheduler-switch',chatMetadata:{story_memory_v1:memory}};
  const scheduler=new VectorIndexScheduler(()=>ctx,()=>settings,
    async (_ctx,_memory,_cfg,signal)=>{called++;await new Promise(resolve=>{finish=resolve;});return signal.aborted?0:1;},
    {batch:2,delay:1,pace:1});
  scheduler.dirty=true;
  const pending=scheduler.flush();
  assert.equal(called,1);
  scheduler.cancel();
  finish();
  await pending;
  assert.equal(called,1);
  const failure=new VectorIndexScheduler(()=>ctx,()=>settings,async()=>{throw Error('test-api-down');},
    {delay:1,batch:1,pace:1});
  failure.dirty=true;
  await failure.flush();
  assert.match(failure.lastError,/test-api-down/);
  failure.cancel();
});

test('IndexedDB auto batches update only changed embeddings and prune stale swipe data',async()=>{
  const previous={fetch:globalThis.fetch,indexedDB:globalThis.indexedDB,IDBKeyRange:globalThis.IDBKeyRange};
  const values=new Map(),sent=[];
  const request=compute=>{
    const req={};
    queueMicrotask(()=>{
      try{req.result=compute();req.onsuccess?.({target:req});}
      catch(e){req.error=e;req.onerror?.({target:req});}
    });return req;
  };
  const db={objectStoreNames:{contains:()=>true},
    transaction:()=>{
      const tx={};
      tx.objectStore=()=>({
        getAll:range=>request(()=>[...values.values()].filter(x=>!range||(x.id>=range.min&&x.id<=range.max))),
        put:x=>{values.set(x.id,x);queueMicrotask(()=>tx.oncomplete?.());},
        delete:id=>{values.delete(id);queueMicrotask(()=>tx.oncomplete?.());}
      });
      return tx;
    }};
  globalThis.indexedDB={open:()=>request(()=>db)};
  globalThis.IDBKeyRange={bound:(min,max)=>({min,max})};
  globalThis.fetch=async(_url,options)=>{
    const input=JSON.parse(options.body).input;
    sent.push(input);
    return {ok:true,json:async()=>({data:input.map((_,index)=>({index,embedding:[1,0,0]}))})};
  };
  try{
    const api=await import('../vector-local.js?next-stage-db-check');
    const chat=[{is_user:false,mes:'艾琳捡起银戒指。',swipe_id:0}];
    let memory=add(freshMemory(),chat,0,'艾琳得到戒指',{
      items:[{op:'add',name:'银戒指',owner:'艾琳'}]
    });
    const ctx={chat,chatMetadata:{story_memory_v1:memory},getCurrentChatId:()=> 'db-automatic-check'};
    const settings=defaultSettings();settings.vector.enabled=true;settings.vector.key='test-only';
    const calls=[];
    for(let i=0;i<5;i++){
      const n=await api.indexSummaries(ctx,memory,settings,null,{full:true,maxRecords:1});
      calls.push(n);if(!n)break;
    }
    assert.deepEqual(calls,[1,1,0]);
    assert.equal(values.size,2);
    const before=sent.length;
    assert.equal(await api.indexSummaries(ctx,memory,settings),0);
    assert.equal(sent.length,before,'unchanged records must not incur embedding costs');
    memory=add(memory,chat,0,'艾琳交给主角',{
      items:[{op:'add',name:'银戒指',owner:'主角'}]
    });
    ctx.chatMetadata.story_memory_v1=memory;
    const n=await api.indexSummaries(ctx,memory,settings);
    assert.equal(n,2,'changed entity and floor need fresh vectors');
    assert.equal(values.size,2,'no obsolete duplicate embeddings');
    assert.ok([...values.values()].some(x=>x.key.startsWith('entity:')&&x.text.includes('主角')));
    chat[0].swipe_id=1;chat[0].mes='这条剧情已被替换。';
    await api.indexSummaries(ctx,memory,settings);
    assert.equal(values.size,0,'stale swipe vectors must be pruned');
  }finally{
    globalThis.fetch=previous.fetch;globalThis.indexedDB=previous.indexedDB;globalThis.IDBKeyRange=previous.IDBKeyRange;
  }
});
