import test from 'node:test';
import assert from 'node:assert/strict';
import {META_KEY,SETTINGS_KEY,defaultSettings,freshMemory,normalizeDelta,commitLeaf,messageFingerprint,userFingerprint} from '../core.js';

test('pre-generation hook adds local historical evidence without any vector API',async()=>{
  const chat=[
    {is_user:true,mes:'我把蓝宝石戒指送给艾琳。'},
    {is_user:false,mes:'艾琳收下那枚戒指，约定一直佩戴。',swipe_id:0},
    {is_user:true,mes:'她现在还戴着戒指吗？'}
  ];
  const memory=commitLeaf(freshMemory(),1,messageFingerprint(chat[1]),
    normalizeDelta({summary:'艾琳收到蓝宝石戒指并答应佩戴'}),userFingerprint(chat,1));
  const settings=defaultSettings();settings.summary.keepRecent=0;
  settings.vector.enabled=false;
  const prompts=[];
  const ctx={chat,chatMetadata:{[META_KEY]:memory},
    extensionSettings:{[SETTINGS_KEY]:settings},getCurrentChatId:()=> 'hook-test',
    setExtensionPrompt:(key,text)=>prompts.push({key,text})};
  const originalDoc=globalThis.document,originalWindow=globalThis.window;
  globalThis.document={readyState:'loading',addEventListener:()=>{}};
  globalThis.window={SillyTavern:{getContext:()=>ctx}};
  try{
    await import('../index.js');
    assert.equal(typeof globalThis.storyMemoryGenerationInterceptor,'function');
    await globalThis.storyMemoryGenerationInterceptor();
    assert.equal(prompts.length,1);
    assert.equal(prompts[0].key,'story_memory_injection_v1');
    assert.match(prompts[0].text,/【相关历史】/);
    assert.match(prompts[0].text,/蓝宝石戒指/);
    assert.match(prompts[0].text,/\[原文 #1\]/);
    // Editing an old swipe invalidates the source without touching the stored original.
    chat[1].swipe_id=1;chat[1].mes='艾琳拒绝了赠礼。';
    prompts.length=0;
    await globalThis.storyMemoryGenerationInterceptor();
    assert.ok(!prompts[0].text.includes('[原文 #1]'));
  }finally{globalThis.document=originalDoc;globalThis.window=originalWindow;}
});

test('structured entity result remains in pre-generation injection even when source evidence is present',async()=>{
  const chat=[
    {is_user:false,mes:'银戒指由艾琳保管。',swipe_id:0},
    {is_user:false,mes:'艾琳把银戒指交给主角。',swipe_id:0},
    {is_user:true,mes:'现在银戒指在谁手上？'}
  ];
  let memory=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),
    normalizeDelta({summary:'戒指原本归艾琳',items:[{op:'add',name:'银戒指',owner:'艾琳'}]}));
  memory=commitLeaf(memory,1,messageFingerprint(chat[1]),
    normalizeDelta({summary:'戒指被交还',items:[{op:'update',name:'银戒指',owner:'主角'}]}));
  const settings=defaultSettings();settings.summary.keepRecent=0;
  settings.injection.inventory=false;settings.injection.characters=false;
  const prompts=[];
  const ctx={chat,chatMetadata:{[META_KEY]:memory},
    extensionSettings:{[SETTINGS_KEY]:settings},getCurrentChatId:()=> 'entity-hook-test',
    setExtensionPrompt:(key,text)=>prompts.push({key,text})};
  const originalDoc=globalThis.document,originalWindow=globalThis.window;
  globalThis.document={readyState:'loading',addEventListener:()=>{}};
  globalThis.window={SillyTavern:{getContext:()=>ctx}};
  try{
    await import('../index.js?entity-current-evidence');
    await globalThis.storyMemoryGenerationInterceptor();
    assert.equal(prompts.length,1);
    assert.match(prompts[0].text,/\[当前实体\]/);
    assert.match(prompts[0].text,/"owner":"主角"/);
    assert.ok(prompts[0].text.includes('相关历史'));
  }finally{globalThis.document=originalDoc;globalThis.window=originalWindow;}
});
