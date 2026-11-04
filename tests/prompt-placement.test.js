import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {defaultSettings,freshMemory,addManual,injectionText} from '../core.js';

test('Story Memory places the summary after the main prompt, outside the live chat sequence',()=>{
  const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
  // Position 0 = IN_PROMPT (after main prompt and before Chat History).
  // Position 1 + depth 2 would split the last two turns.
  assert.match(source,/setExtensionPrompt\('story_memory_injection_v1',text,0,0,false,0,null\)/);
  assert.doesNotMatch(source,/setExtensionPrompt\('story_memory_injection_v1',text,1,2/);
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
