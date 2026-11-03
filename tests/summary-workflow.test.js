import test from 'node:test';
import assert from 'node:assert/strict';
import {floorSource,splitSource,summarizeFloor,summarizeChapter} from '../summary-workflow.js';
import {defaultSettings,freshMemory,commitLeaf,messageFingerprint,userFingerprint,hideReadyIndices} from '../core.js';
import {makeBody,requestChat,ApiFault} from '../api.js';

test('source splitting preserves every original character including long user inputs and surrogate pairs',()=>{
  const source='【用户】\n'+('第一件礼物。'.repeat(3200))+'😀'+('第二段变化。'.repeat(1700))+'【最后约定】';
  const parts=splitSource(source,4000);
  assert.ok(parts.length>2);
  assert.equal(parts.join(''),source);
  assert.ok(parts.every(part=>part.length<=4000));
  assert.equal(parts[0].startsWith('【用户】'),true);
  assert.equal(parts.at(-1).endsWith('【最后约定】'),true);
  assert.equal(parts.filter(part=>part.includes('😀')).length,1);
});

test('blank output cap does not override either provider or main API, while explicit override still works',async()=>{
  const base=defaultSettings().api;
  assert.equal(base.maxTokens,null);
  const custom={...base,mode:'custom',url:'https://example.invalid/v1',key:'synthetic-test-only',model:'synthetic'};
  const body=makeBody(custom,[{role:'user',content:'hello'}]);
  assert.equal(Object.hasOwn(body,'max_tokens'),false);
  assert.equal(makeBody({...custom,maxTokens:4096},[{role:'user',content:'hello'}]).max_tokens,4096);
  assert.throws(()=>makeBody({...custom,maxTokens:5},[{role:'user',content:'hello'}]),ApiFault);
  const calls=[],ctx={generateRaw:async payload=>{calls.push(payload);return '{"summary":"OK"}';}};
  await requestChat({...base,mode:'main'},[{role:'user',content:'hello'}],ctx);
  await requestChat({...base,mode:'main',maxTokens:5000},[{role:'user',content:'hello'}],ctx);
  assert.equal(Object.hasOwn(calls[0],'responseLength'),false);
  assert.equal(calls[1].responseLength,5000);
});

test('long floor summarizes each chunk and keeps its earliest item and latest character states',async()=>{
  const fullAi='起始：守门人送出铜钥匙。'+('城堡长廊与细雨。'.repeat(3600))+'结局：艾琳接过银盒。';
  const chat=[{is_user:true,mes:'玩家答应调查。'},{is_user:false,mes:fullAi,swipe_id:0}];
  const ctx={chat,getCurrentChatId:()=> 'multi-floor'};
  const settings=defaultSettings(),prompts=[];settings.api.mode='main';
  ctx.generateRaw=async ({prompt})=>{
    const text=prompt[1].content;prompts.push(text);
    if(prompt[0].content.includes('同一楼层按时间顺序提取')){
      return JSON.stringify({summary:'起始得到铜钥匙，最终艾琳接过银盒。'});
    }
    if(text.includes('原文 1/')){
      return JSON.stringify({summary:'守门人送出铜钥匙',items:[{op:'add',name:'铜钥匙',
        evidence:'守门人送出铜钥匙'}]});
    }
    if(text.includes('结局：艾琳接过银盒。')){
      return JSON.stringify({summary:'艾琳收到银盒',characters:[{op:'add',name:'艾琳'}],
        items:[{op:'add',name:'银盒',evidence:'艾琳接过银盒'}]});
    }
    return JSON.stringify({summary:'走过长廊',scenes:[{op:'add',name:'城堡长廊'}]});
  };
  const outcome=await summarizeFloor(1,ctx,freshMemory(),settings);
  assert.ok(prompts.length>2,'several source requests plus a final merge');
  assert.ok(prompts[0].includes('起始：守门人送出铜钥匙。'));
  assert.ok(prompts.some(p=>p.includes('结局：艾琳接过银盒。')));
  assert.ok(outcome.sourceParts.length>1);
  assert.match(outcome.summary,/铜钥匙/);
  assert.deepEqual(outcome.delta.items.map(x=>x.name),['铜钥匙','银盒']);
  assert.ok(outcome.delta.characters.some(x=>x.name==='艾琳'));
  assert.ok(outcome.delta.scenes.some(x=>x.name==='城堡长廊'));
  const committed=commitLeaf(freshMemory(),1,messageFingerprint(chat[1]),outcome,userFingerprint(chat,1),true);
  assert.equal(committed.leaves[1].sourceComplete,true);
  assert.equal(committed.leaves[1].sourceParts.length,outcome.sourceParts.length);
  settings.summary.keepRecent=0;settings.summary.delayFloors=0;
  assert.deepEqual(hideReadyIndices(committed,chat,settings),[0,1],
    'after full verified multi-request coverage, original messages can be hidden safely');
  const legacy=commitLeaf(freshMemory(),1,messageFingerprint(chat[1]),outcome,userFingerprint(chat,1));
  assert.deepEqual(hideReadyIndices(legacy,chat,settings),[],
    'legacy summaries lack proof of full coverage and must not hide oversized original text');
});

test('failure during a later source chunk does not expose incomplete floor records',async()=>{
  const chat=[{is_user:true,mes:'开始'},{is_user:false,mes:'开端。'+('长剧情内容。'.repeat(2600))+'结尾。'}];
  const ctx={chat,getCurrentChatId:()=> 'multi-failure'},settings=defaultSettings();
  let requests=0;
  ctx.generateRaw=async ()=>{
    requests++;
    if(requests===2)throw Error('synthetic remote interruption');
    return JSON.stringify({summary:'第一段完成',items:[{op:'add',name:'钥匙'}]});
  };
  const memory=freshMemory();
  await assert.rejects(()=>summarizeFloor(1,ctx,memory,settings),/主 API 生成失败/);
  assert.ok(requests>=2);
  assert.deepEqual(memory.leaves,{});
  assert.equal(memory.revision,0);
});

test('chapter summaries over the old size threshold are processed in ordered batches',async()=>{
  const rows=Array.from({length:9},(_,i)=>({summary:'第'+i+'幕：'+('事件发生。'.repeat(620))+'第'+i+'幕结尾。'}));
  const seen=[],ctx={generateRaw:async ({prompt})=>{
    seen.push(prompt[1].content);
    return '这是一份简洁的阶段摘要：第'+seen.length+'部分。';
  }};
  const text=await summarizeChapter(rows,defaultSettings(),'chapter',ctx);
  assert.match(text,/阶段摘要/);
  assert.ok(seen.length>2);
  assert.ok(seen.some(x=>x.includes('第0幕：')));
  assert.ok(seen.some(x=>x.includes('第8幕结尾。')));
  assert.ok(seen.at(-1).includes('第1部分')||seen.at(-1).includes('阶段摘要'));
});

test('chunking a single large chapter entry keeps its beginning and ending',async()=>{
  const source='开头设下约定。'+('详细历史。'.repeat(4200))+'最后约定被解除。';
  const seen=[],ctx={generateRaw:async ({prompt})=>{
    seen.push(prompt[1].content);
    return '这一段保留了主要剧情和因果。';
  }};
  const result=await summarizeChapter([{summary:source}],defaultSettings(),'overview',ctx);
  assert.ok(result);
  assert.ok(seen.some(s=>s.includes('开头设下约定。')));
  assert.ok(seen.some(s=>s.includes('最后约定被解除。')));
});

test('verified context-length rejection automatically splits the affected part again',async()=>{
  const oldFetch=globalThis.fetch;
  const settings=defaultSettings();
  settings.api={...settings.api,mode:'custom',url:'https://example.invalid/v1',
    model:'synthetic',key:'synthetic-test-only'};
  const ctx={chat:[{is_user:true,mes:'开始'},{is_user:false,mes:'开头。'+('长段故事。'.repeat(1900))+'终点。'}],
    getRequestHeaders:()=>({'Content-Type':'application/json'})};
  let tooLarge=0,succeeded=0;
  globalThis.fetch=async (_url,{body})=>{
    const request=JSON.parse(body);
    const content=request.messages[1].content;
    if(content.length>6000){tooLarge++;return {ok:false,status:413};}
    succeeded++;
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({
      summary:'根据分段确认的剧情',items:[{op:'add',name:'记录册'}]
    })}}]})};
  };
  try{
    const result=await summarizeFloor(1,ctx,freshMemory(),settings);
    assert.ok(tooLarge>0);
    assert.ok(succeeded>1);
    assert.ok(result.sourceParts.length>1);
    assert.equal(result.delta.items.length,result.sourceParts.length);
  }finally{globalThis.fetch=oldFetch;}
});
