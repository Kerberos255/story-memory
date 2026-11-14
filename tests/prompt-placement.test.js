import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {defaultSettings,freshMemory,addManual,injectionText} from '../core.js';

test('Story Memory uses the oldest in-chat slot, not a position relative to the main prompt',()=>{
  const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
  // ST release script.js: IN_CHAT=1 and MAX_INJECTION_DEPTH=10000.
  // A short depth breaks the chronology; IN_PROMPT can precede user presets.
  assert.match(source,/setExtensionPrompt\('story_memory_injection_v1',text,1,10000,false,0,null\)/);
  assert.doesNotMatch(source,/setExtensionPrompt\('story_memory_injection_v1',text,0,0/);
  assert.doesNotMatch(source,/setExtensionPrompt\('story_memory_injection_v1',text,1,2/);
});

test('SillyTavern in-chat depth places the archive before all retained dialogue turns',()=>{
  // Mirror the release Chat Completion algorithm: messages arrive newest-first,
  // splice at injection_depth, then reverse into chronological Chat History.
  const insert = messages=>{
    const newestFirst=[...messages].reverse();
    newestFirst.splice(10000,0,'【历史剧情记忆】');
    return newestFirst.reverse();
  };
  for(const count of [0,1,2,6,128,9500]){
    const turns=Array.from({length:count},(_,i)=>i%2?'ai'+i:'user'+i);
    const history=insert(turns);
    assert.equal(history[0],'【历史剧情记忆】');
    assert.deepEqual(history.slice(1),turns);
  }
  // This guarantee concerns ordering, not retention under context token trimming.
});

test('injected memory declares itself an older archive and gives recent dialogue precedence',()=>{
  const memory=addManual(freshMemory(),'summaries','前几章角色已经离开王城');
  const diagnostics={};
  const text=injectionText(memory,[],defaultSettings(),[],[],diagnostics);
  assert.match(text,/^【历史剧情记忆｜非新发生的对话/);
  assert.match(text,/较新的聊天记录为准/);
  assert.match(text,/【人工补充记忆】\n前几章角色已经离开王城/);
  assert.equal(diagnostics.usedTokens,Math.ceil(text.length/3));
  assert.ok(text.length<=diagnostics.budgetTokens*3);
});

test('no available memories means no injected header or placeholder message',()=>{
  assert.equal(injectionText(freshMemory(),[],defaultSettings()),'');
});

test('background injections clear previous text before asynchronously applying token-checked data',async()=>{
  const fs=await import('node:fs');
  const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
  const start=source.indexOf('function inject('),end=source.indexOf('async function injectForGeneration');
  const body=source.slice(start,end);
  assert.match(body,/setExtensionPrompt\('story_memory_injection_v1','',1,10000/);
  assert.match(body,/injectionTextWithinBudget/);
  assert.doesNotMatch(body,/injectionText\(memory\|\|peekMemory/);
});
