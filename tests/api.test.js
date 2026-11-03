import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeHeaders,normalizeChannelUrl,makeBody,extractJSONObject,ApiFault,buildSummaryMessages} from '../api.js';
import {defaultSettings,freshMemory} from '../core.js';
test('custom headers and body parameters pass through ST Custom route',()=>{
 const api={...defaultSettings().api,mode:'custom',url:'https://example.invalid/v1',key:'synthetic-test-only',model:'sample',
   exclude:['temperature','chat_completion_source','messages'],
   headers:{'X-Project':'private-test','Connection':'drop-me'},include:{reasoning_effort:'low'}};
 const body=makeBody(api,[{role:'user',content:'hello'}]);
 assert.equal(body.chat_completion_source,'custom');
 assert.equal(body.custom_url,'https://example.invalid/v1');
 assert.equal(body.temperature,0);
 assert.equal(body.max_tokens,8192);
 assert.match(body.custom_exclude_body,/^- temperature/m);
 assert.match(body.custom_exclude_body,/^- messages/m);
 assert.equal(body.tool_choice,'none');
 assert.equal(body.messages.length,1);
 assert.equal(JSON.parse(body.custom_include_headers)['X-Project'],'private-test');
 assert.equal(JSON.parse(body.custom_include_headers).Authorization,'Bearer synthetic-test-only');
 assert.equal(JSON.parse(body.custom_include_headers).Connection,undefined);
 assert.equal(JSON.parse(body.custom_include_body).reasoning_effort,'low');
});
test('invalid headers and URL credentials are rejected',()=>{
 assert.deepEqual(normalizeHeaders({'Bad\r\nHeader':'x','Authorization':'Bearer demo','Cookie':'hi','x-opencode-session':'manual-session'}),{'x-opencode-session':'manual-session'});
 assert.throws(()=>normalizeChannelUrl('https://person:pass@some.invalid/v1'),ApiFault);
 assert.throws(()=>normalizeChannelUrl('javascript:alert(1)'),ApiFault);
});
test('extract JSON from wrapped response',()=>{
 const fenced=String.fromCharCode(96).repeat(3);
 assert.deepEqual(extractJSONObject('<thinking>checked</thinking>\n'+fenced+'json\n{"summary":"抵达小镇"}\n'+fenced),{summary:'抵达小镇'});
 assert.throws(()=>extractJSONObject('no json'),ApiFault);
});
test('summary payload is small, tool-free, independent from RP preset',()=>{
 const c=[{is_user:true,mes:'打开门'},{is_user:false,mes:'打开门后发现地图'}];
 const msgs=buildSummaryMessages(1,c,freshMemory(),defaultSettings());
 assert.deepEqual(msgs.map(x=>x.role),['system','user']);
 assert.ok(msgs[0].content.includes('JSON'));
 assert.ok(msgs[1].content.includes('地图'));
 assert.ok(!msgs[0].content.includes('NVWA'));
});

import {parseExtraBody,parseExcluded,parseHeaderLines,requestChat,DEFAULT_SUMMARY_PROMPT,DEFAULT_CHAPTER_PROMPT,DEFAULT_OVERVIEW_PROMPT,effectiveSummaryPrompt,buildChapterMessages} from '../api.js';
test('default extraction prompts defend evidence and NPC knowledge; chapter input is never clipped',()=>{
 const cfg=defaultSettings();
 assert.match(DEFAULT_SUMMARY_PROMPT,/knowledge/);
 assert.match(DEFAULT_SUMMARY_PROMPT,/原文证据/);
 assert.match(DEFAULT_SUMMARY_PROMPT,/未听见/);
 assert.match(DEFAULT_CHAPTER_PROMPT,/全部输入|所有输入/);
 assert.throws(()=>buildChapterMessages([{summary:'序章'},{summary:'后半段'.repeat(9000)}],cfg,'chapter'),/安全上限/);
});
test('additional request parameters accept concise ST-style lines and JSON',()=>{
 const params=parseExtraBody('prefix: true\nreasoning_effort: low\nmax_tokens: 8192');
 assert.deepEqual(params,{prefix:true,reasoning_effort:'low',max_tokens:8192});
 assert.deepEqual(parseExtraBody('{"prefix":false}'),{prefix:false});
 assert.deepEqual(parseExcluded('- frequency_penalty\n- presence_penalty\ntop_p'),['frequency_penalty','presence_penalty','top_p']);
 assert.deepEqual(parseHeaderLines('x-opencode-session: sillytavern\nX-Source: manual'),
   {'x-opencode-session':'sillytavern','X-Source':'manual'});
 assert.throws(()=>parseHeaderLines('Authorization: Bearer synthetic'),/不允许/);
 assert.throws(()=>parseHeaderLines('x-demo: abc\nX-DEMO: def'),/重复/);
});
test('follow main API uses ST generateRaw without calling custom endpoint',async()=>{
 const cfg=defaultSettings().api;cfg.mode='main';cfg.url='';cfg.model='';
 let options;
 const ctx={generateRaw:async arg=>{options=arg;return '{"summary":"发现遗失的灯"}';}};
 const text=await requestChat(cfg,[{role:'system',content:'提取摘要'},{role:'user',content:'故事片段'}],ctx);
 assert.match(text,/发现遗失的灯/);
 assert.deepEqual(options.prompt.map(m=>m.role),['system','user']);
 assert.equal(options.responseLength,8192);
});
test('default prompt contents and custom full replacement are exactly effective',()=>{
 const settings=defaultSettings();
 assert.equal(effectiveSummaryPrompt(settings),DEFAULT_SUMMARY_PROMPT);
 assert.match(DEFAULT_SUMMARY_PROMPT,/items/);
 assert.match(DEFAULT_SUMMARY_PROMPT,/scenes/);
 assert.match(DEFAULT_SUMMARY_PROMPT,/characters/);
 assert.match(DEFAULT_SUMMARY_PROMPT,/plans/);
 assert.match(DEFAULT_CHAPTER_PROMPT,/章节/);
 assert.match(DEFAULT_OVERVIEW_PROMPT,/长期/);
 settings.prompts.summaryFull='只返回 JSON 对象。';
 assert.equal(effectiveSummaryPrompt(settings),'只返回 JSON 对象。');
 assert.equal(buildChapterMessages([{summary:'月夜的约定'}],settings,'overview')[0].content,DEFAULT_OVERVIEW_PROMPT);
 settings.prompts.overview='长期总结自定义';
 assert.equal(buildChapterMessages([{summary:'月夜的约定'}],settings,'overview')[0].content,'长期总结自定义');
});

import {listSummaryModels} from '../api.js';
test('model refresh uses only standalone key and leaves main API untouched',async()=>{
 const oldFetch=globalThis.fetch;
 let request;
 globalThis.fetch=async(url,options)=>{
   request={url,body:JSON.parse(options.body)};
   return {ok:true,json:async()=>({data:[{id:'model-b'},{id:'model-a'},{id:'model-a'}]})};
 };
 try{
   const ctx={getRequestHeaders:()=>({'Content-Type':'application/json'})};
   const models=await listSummaryModels(ctx,{
     url:'https://summary.example.invalid/v1',
     key:'synthetic-summary-key',
     headers:{'x-opencode-session':'custom-session'}
   });
   assert.deepEqual(models,['model-a','model-b']);
   assert.equal(request.url,'/api/backends/chat-completions/status');
   assert.equal(request.body.chat_completion_source,'custom');
   assert.equal(request.body.custom_url,'https://summary.example.invalid/v1');
   assert.equal(request.body.secret_id,undefined);
   const h=JSON.parse(request.body.custom_include_headers);
   assert.equal(h.Authorization,'Bearer synthetic-summary-key');
   assert.equal(h['x-opencode-session'],'custom-session');
 }finally{globalThis.fetch=oldFetch;}
});
test('standalone channel refuses missing keys, and defaults to main API',()=>{
 const settings=defaultSettings();
 assert.equal(settings.api.mode,'main');
 assert.equal(settings.api.key,'');
 assert.throws(()=>makeBody({...settings.api,mode:'custom',url:'https://summary.example.invalid/v1',model:'model-a'},
   [{role:'user',content:'test'}]),/密钥/);
});

test('max tokens is configurable up to 65536, temperature 0 remains explicit',()=>{
 const api={...defaultSettings().api,mode:'custom',url:'https://example.invalid/v1',key:'synthetic-test-only',model:'sample',maxTokens:65536,temperature:0};
 const body=makeBody(api,[{role:'user',content:'test'}]);
 assert.equal(body.max_tokens,65536);
 assert.equal(body.temperature,0);
});

test('summary request provides bounded prior entity IDs without leaking later story state',async()=>{
 const {commitLeaf,normalizeDelta,messageFingerprint}=await import('../core.js');
 const chat=[
  {is_user:false,mes:'拾取一把银钥匙'},
  {is_user:false,mes:'钥匙移交给同伴'},
  {is_user:false,mes:'后续才遇见一位新人物'}
 ];
 let mem=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({
   summary:'获得道具',items:[{op:'add',name:'银钥匙',owner:'守卫'}],
   scenes:[{op:'add',name:'东侧走廊'}],
   characters:[{op:'add',name:'旅人'}]
 }));
 mem=commitLeaf(mem,2,messageFingerprint(chat[2]),normalizeDelta({
   summary:'后来才出现的人物',characters:[{op:'add',name:'后来才出现的访客'}]
 }));
 const req=buildSummaryMessages(1,chat,mem,defaultSettings());
 assert.equal(req.length,2);
 assert.ok(req[1].content.includes('已登记物品'));
 assert.ok(req[1].content.includes('银钥匙'));
 assert.match(req[1].content,/items:0:[a-f0-9]{8}/);
 assert.ok(req[1].content.includes('东侧走廊'));
 assert.ok(req[1].content.includes('旅人'));
 assert.ok(!req[1].content.includes('后来才出现的访客'));
 assert.ok(req[0].content.includes('稳定身份'));
});
