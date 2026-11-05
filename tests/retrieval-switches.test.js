import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings,freshMemory,commitLeaf,messageFingerprint,userFingerprint,normalizeDelta,META_KEY,SETTINGS_KEY} from '../core.js';

test('generation injects history when enabled despite a legacy disabled-injection flag',async()=>{
  const chat=[
    {is_user:true,mes:'送给她一枚蓝宝石戒指。'},
    {is_user:false,mes:'艾琳收下银质蓝宝石戒指，答应一直戴在左手。',swipe_id:0},
    {is_user:true,mes:'回到旧城堡调查钟楼。'},
    {is_user:false,mes:'主角进入旧城堡，发现北塔的密道入口。',swipe_id:0},
    {is_user:true,mes:'说说我们的约定。'},
    {is_user:false,mes:'艾琳承认戒指的约定已经改变，决定明天归还。',swipe_id:0},
    {is_user:true,mes:'蓝宝石戒指的约定后来怎样了？'}
  ];
  let memory=freshMemory();
  for(const i of [1,3,5]){
    memory=commitLeaf(memory,i,messageFingerprint(chat[i]),
      normalizeDelta({summary:i===1?'艾琳收到戒指并做出承诺':i===3?'发现北塔密道':'艾琳决定归还蓝宝石戒指，旧约定被更改'}),userFingerprint(chat,i));
  }
  const settings=defaultSettings();
  settings.injection.retrieval=false;
  settings.injection.vector=false;
  settings.retrieval.enabled=true;
  settings.vector.enabled=false;
  const calls=[];
  const ctx={chat,chatMetadata:{[META_KEY]:memory},
    extensionSettings:{[SETTINGS_KEY]:settings},
    getCurrentChatId:()=> 'legacy-retrieval-chat',
    setExtensionPrompt:(...args)=>calls.push(args)};
  const previous={window:globalThis.window,document:globalThis.document,
    interceptor:globalThis.storyMemoryGenerationInterceptor};
  try{
    globalThis.window={SillyTavern:{getContext:()=>ctx}};
    // Keep boot deferred; exercise the actual generation interceptor only.
    globalThis.document={readyState:'loading',addEventListener(){}};
    await import('../index.js?retrieval-switches-integration');
    assert.equal(typeof globalThis.storyMemoryGenerationInterceptor,'function');
    await globalThis.storyMemoryGenerationInterceptor([],0,null,'normal');
    assert.equal(calls.length,1);
    assert.equal(calls[0][0],'story_memory_injection_v1');
    assert.match(calls[0][1],/【相关历史】/);
    assert.match(calls[0][1],/戒指/);
    assert.equal(calls[0][2],1);
    assert.equal(calls[0][3],10000);
  }finally{
    globalThis.window=previous.window;
    globalThis.document=previous.document;
    if(previous.interceptor===undefined)delete globalThis.storyMemoryGenerationInterceptor;
    else globalThis.storyMemoryGenerationInterceptor=previous.interceptor;
  }
});
