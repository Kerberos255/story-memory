import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings,freshMemory,commitLeaf,messageFingerprint,normalizeDelta,deriveState} from '../core.js';
import {ApiFault,DEFAULT_SUMMARY_PROMPT,DEFAULT_CHAPTER_PROMPT,DEFAULT_RESUMMARY2_PROMPT,
  DEFAULT_OVERVIEW_PROMPT,composeL0Prompt,parseL0Response,buildSummaryMessages,
  effectiveSummaryPrompt,EXTRACTION_KINDS} from '../api.js';
import {summarizeFloor} from '../summary-workflow.js';

const chat=[{is_user:true,mes:'记下今天的事'},
  {is_user:false,mes:'人物安娜在城堡取走银钥匙，决定明天调查。',swipe_id:0}];
const memory=()=>{
  let m=commitLeaf(freshMemory(),0,messageFingerprint(chat[1]),normalizeDelta({
    summary:'旧档案',items:[{op:'add',name:'旧物品'}],scenes:[{op:'add',name:'旧场景'}],
    characters:[{op:'add',name:'旧人物'}],plans:[{op:'add',name:'旧计划'}]
  }));
  // Build a distinct earlier source so the entity catalog can be verified.
  const earlier=[{is_user:false,mes:'旧物品、旧场景、旧人物和旧计划。',swipe_id:0},...chat];
  m=commitLeaf(freshMemory(),0,messageFingerprint(earlier[0]),normalizeDelta({
    summary:'四项旧档案',items:[{op:'add',name:'旧物品'}],scenes:[{op:'add',name:'旧场景'}],
    characters:[{op:'add',name:'旧人物'}],plans:[{op:'add',name:'旧计划'}]
  }));
  return {m,earlier};
};

test('all 16 extraction combinations generate correct L0 instructions and omit disabled catalogs',()=>{
 const {m,earlier}=memory();
 for(let mask=0;mask<16;mask++){
   const settings=defaultSettings();
   for(let i=0;i<EXTRACTION_KINDS.length;i++)
     settings.extraction[EXTRACTION_KINDS[i]]=Boolean(mask&(1<<i));
   const prompt=composeL0Prompt(settings);
   const messages=buildSummaryMessages(2,earlier,m,settings);
   assert.equal(messages[0].content,prompt);
   assert.equal(messages.length,2);
   for(const [kind,tag,source] of [
     ['items','【物品 items】','已登记物品'],
     ['scenes','【场景 scenes】','已登记场景'],
     ['characters','【人物 characters】','已登记人物'],
     ['plans','【计划 plans】','已登记计划']
   ]){
     assert.equal(prompt.includes(tag),settings.extraction[kind],kind+' module mask '+mask);
     assert.equal(prompt.includes('"'+kind+'"'),settings.extraction[kind],kind+' JSON mask '+mask);
     assert.equal(messages[1].content.includes(source),settings.extraction[kind],
       kind+' catalog mask '+mask);
   }
   const sampleStart=prompt.indexOf('{\n');
   assert.ok(sampleStart>=0,'generated JSON schema is present');
   const example=JSON.parse(prompt.slice(sampleStart));
   assert.deepEqual(Object.keys(example).filter(k=>EXTRACTION_KINDS.includes(k)),
     EXTRACTION_KINDS.filter(k=>settings.extraction[k]));
   assert.match(prompt,/固定输出协议/);
 }
});

test('custom L0 writing prompt stays byte-identical and gets a separate protected output contract',()=>{
 const settings=defaultSettings();
 const custom='自定义剧情规则：含 {JSON} 示例和多个引号 ""。\n示例 {"summary":"不要复制"}';
 settings.prompts.summaryFull=custom;
 settings.extraction.items=false;
 settings.extraction.plans=false;
 const actual=composeL0Prompt(settings);
 assert.ok(actual.startsWith(custom+'\n\n'));
 assert.equal(settings.prompts.summaryFull,custom);
 assert.doesNotMatch(actual,/"items":\s*\[/);
 assert.doesNotMatch(actual,/"plans":\s*\[/);
 assert.match(actual,/固定输出协议/);
 const same=defaultSettings();
 same.prompts.summaryFull=DEFAULT_SUMMARY_PROMPT;
 same.extraction.items=false;
 assert.doesNotMatch(composeL0Prompt(same),/【物品 items】/);
 assert.equal(effectiveSummaryPrompt(same),DEFAULT_SUMMARY_PROMPT);
 assert.equal(DEFAULT_CHAPTER_PROMPT.includes('人物'),true);
 assert.equal(DEFAULT_RESUMMARY2_PROMPT.includes('人物'),true);
 assert.equal(DEFAULT_OVERVIEW_PROMPT.includes('物品'),true);
});

test('strict L0 parser rejects multi-object replies, malformed shapes and arbitrary wrapper prose',()=>{
 const s=defaultSettings();
 assert.equal(parseL0Response('{"summary":"合理摘要"}',s).summary,'合理摘要');
  assert.equal(parseL0Response([String.fromCharCode(96).repeat(3)+'json','{"summary":"合法围栏"}',String.fromCharCode(96).repeat(3)].join('\n'),s).summary,'合法围栏');
 assert.throws(()=>parseL0Response('{"summary":"示例"}\n{"summary":"真实"}',s),
   e=>e instanceof ApiFault&&e.code==='multiple_summary_json');
 assert.throws(()=>parseL0Response('说明文字\n{"summary":"真实"}',s),
   e=>e instanceof ApiFault&&e.code==='invalid_summary_json');
 assert.throws(()=>parseL0Response('{"summary":"正常","items":{}}',s),
   e=>e instanceof ApiFault&&e.code==='invalid_summary_shape');
 assert.throws(()=>parseL0Response('{"summary":"按时间顺序总结本轮剧情"}',s),
   e=>e instanceof ApiFault&&e.code==='invalid_summary_shape');
 assert.throws(()=>parseL0Response('{"summary":"","items":[]}',s),
   e=>e instanceof ApiFault&&e.code==='invalid_summary_shape');
 assert.throws(()=>parseL0Response('{"summary":"正常","time":4}',s),
   e=>e instanceof ApiFault&&e.code==='invalid_summary_shape');
 const disabled=defaultSettings();disabled.extraction.items=false;
 assert.equal(parseL0Response('{"summary":"正常","items":{}}',disabled).summary,'正常',
   'disabled category must be ignored even if model emitted an invalid value');
});

test('disabled extraction never saves entities even when custom prompt and model demand them',async()=>{
 const settings=defaultSettings();settings.api.mode='main';
 settings.extraction.items=false;settings.extraction.characters=false;
 settings.prompts.summaryFull='输出 items、characters 等所有 JSON 数组！';
 const ctx={chat,getCurrentChatId:()=> 'l0-blocking',
   generateRaw:async()=>JSON.stringify({summary:'安娜拿了钥匙并决定调查。',
     items:[{op:'add',name:'银钥匙'}],characters:[{op:'add',name:'安娜'}],
     scenes:[{op:'add',name:'城堡'}],plans:[{op:'add',name:'调查'}]})};
 const result=await summarizeFloor(1,ctx,freshMemory(),settings);
 assert.equal(result.delta.items.length,0);
 assert.equal(result.delta.characters.length,0);
 assert.deepEqual(result.delta.scenes.map(x=>x.name),['城堡']);
 assert.deepEqual(result.delta.plans.map(x=>x.name),['调查']);
 assert.match(result.summary,/安娜/);
 // Switching off future extraction never erases older saved records.
 const old=commitLeaf(freshMemory(),1,messageFingerprint(chat[1]),
   normalizeDelta({summary:'旧档案',items:[{op:'add',name:'旧银钥匙'}]}));
 assert.ok(deriveState(old,chat).items.some(x=>x.name==='旧银钥匙'));
});

test('one targeted JSON format repair succeeds without writing raw malformed output',async()=>{
 const settings=defaultSettings(),prompts=[];settings.api.mode='main';
 const ctx={chat,getCurrentChatId:()=> 'l0-repair',
   generateRaw:async({prompt})=>{
     prompts.push(prompt);
     return prompts.length===1?'说明\n{"summary":"修好了"}':'{"summary":"修好了"}';
   }};
 const result=await summarizeFloor(1,ctx,freshMemory(),settings);
 assert.equal(prompts.length,2);
 assert.match(prompts[1][0].content,/只负责修复/);
 assert.equal(result.summary,'修好了');
});

test('ambiguous multiple objects never trigger format repair or commit',async()=>{
 const settings=defaultSettings();let calls=0;settings.api.mode='main';
 const ctx={chat,getCurrentChatId:()=> 'l0-ambiguity',
   generateRaw:async()=>{calls++;return '{"summary":"示例"}\n{"summary":"真实"}';}};
 const mem=freshMemory();
 await assert.rejects(()=>summarizeFloor(1,ctx,mem,settings),
   e=>e instanceof ApiFault&&e.code==='multiple_summary_json');
 assert.equal(calls,1);
 assert.deepEqual(mem.leaves,{});
});

test('bad repair stays an error and cannot persist a partial floor',async()=>{
 const settings=defaultSettings();let calls=0;settings.api.mode='main';
 const ctx={chat,getCurrentChatId:()=> 'l0-failed-repair',
   generateRaw:async()=>{calls++;return '错误JSON\n{"summary":'}};
 const mem=freshMemory();
 await assert.rejects(()=>summarizeFloor(1,ctx,mem,settings),
   e=>e instanceof ApiFault&&e.code==='invalid_summary_json');
 assert.equal(calls,2,'a single repair attempt only');
 assert.deepEqual(mem.leaves,{});
});

test('long-floor merge rejects multiple JSON objects instead of silently taking the first',async()=>{
 const settings=defaultSettings();settings.api.mode='main';
 const longChat=[{is_user:true,mes:'把旧事件合并'},
   {is_user:false,mes:'剧情事件不断发生。'.repeat(4200),swipe_id:0}];
 let merges=0,repairs=0;
 const ctx={chat:longChat,getCurrentChatId:()=> 'long-merge-strict',
   generateRaw:async({prompt})=>{
     const system=prompt[0].content;
     if(system.includes('同一楼层按时间顺序提取')){
       merges++;
       return '{"summary":"示例合并"}\n{"summary":"真实合并"}';
     }
     if(system.includes('只修复 JSON 格式'))repairs++;
     return '{"summary":"某一段的正确摘要"}';
   }};
 await assert.rejects(()=>summarizeFloor(1,ctx,freshMemory(),settings),
   err=>err instanceof ApiFault&&err.code==='multiple_summary_json');
 assert.equal(merges,1);
 assert.equal(repairs,0,'ambiguous merge cannot be repaired by silently choosing a JSON');
});

test('long-floor merge repairs a single malformed JSON once',async()=>{
 const settings=defaultSettings();settings.api.mode='main';
 const longChat=[{is_user:true,mes:'把旧事件合并'},
   {is_user:false,mes:'剧情事件不断发生。'.repeat(4200),swipe_id:0}];
 let repairs=0;
 const ctx={chat:longChat,getCurrentChatId:()=> 'long-merge-repair',
   generateRaw:async({prompt})=>{
     const system=prompt[0].content;
     if(system.includes('同一楼层按时间顺序提取'))return '说明：{"summary":"合并完毕"}';
     if(system.includes('只修复 JSON 格式')){repairs++;return '{"summary":"合并完毕"}';}
     return '{"summary":"某一段的正确摘要"}';
   }};
 const result=await summarizeFloor(1,ctx,freshMemory(),settings);
 assert.equal(repairs,1);
 assert.equal(result.summary,'合并完毕');
});
