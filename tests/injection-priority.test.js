import test from 'node:test';
import assert from 'node:assert/strict';
import {freshMemory,defaultSettings,commitLeaf,normalizeDelta,messageFingerprint,
  injectionText,injectionTextWithinBudget} from '../core.js';

function historyState(){
  const chat=[],memory=freshMemory();
  const add=(summary,{location='',items=[],scenes=[],characters=[]}={})=>{
    const index=chat.length;
    const msg={is_user:false,mes:'合成测试楼层 '+index,swipe_id:0};
    chat.push(msg);
    const data=normalizeDelta({summary,location,items,scenes,characters},msg.mes);
    const written=commitLeaf(memory,index,messageFingerprint(msg),data);
    Object.assign(memory,written);
  };
  return {chat,memory,add};
}
const config=(budget=400)=>{
  const cfg=defaultSettings();
  cfg.injection.budget=budget;
  cfg.summary.keepRecent=100; // Isolate structured state from plot summary budget.
  cfg.retrieval.enabled=true;
  cfg.injection.characters=false;
  cfg.injection.plans=false;
  return cfg;
};
const section=(text,title)=>{
  const match=text.match(new RegExp('【'+title+'】\\n([^【]*)(?:\\n\\n|$)'));
  return match?.[1]||'';
};

test('current carried item stays selected over recently added unowned items',()=>{
  const {chat,memory,add}=historyState();
  add('已有道具',{items:[{op:'add',name:'旧银钥匙',owner:'主角',description:'历史重要钥匙'}]});
  for(let i=0;i<15;i++)
    add('新增普通道具',{items:[{op:'add',name:'普通物品'+i,owner:'其他人',
      description:'一般物品资料'.repeat(18)}]});
  const cfg=config();
  cfg.retrieval.enabled=false;
  const report={},out=injectionText(memory,chat,cfg,[],[],report);
  assert.match(section(out,'物品'),/旧银钥匙/);
  assert.ok(report.sections.find(s=>s.title==='【物品】').skippedBudget>0);
});

test('most recently updated older item precedes newly created objects',()=>{
  const {chat,memory,add}=historyState();
  add('旧物品',{items:[{op:'add',name:'铜印章',status:'沉睡'}]});
  for(let i=0;i<10;i++)
    add('新物品',{items:[{op:'add',name:'新物品'+i,description:'非常冗长的物品资料'.repeat(12)}]});
  add('旧物品状态变化',{items:[{op:'update',name:'铜印章',status:'已激活'}]});
  const cfg=config();
  cfg.retrieval.enabled=false;
  const out=injectionText(memory,chat,cfg);
  assert.match(section(out,'物品'),/铜印章/);
  assert.match(section(out,'物品'),/已激活/);
});

test('latest known scene overrides creation order and falls back to recency when unknown',()=>{
  const {chat,memory,add}=historyState();
  add('旧地点',{scenes:[{op:'add',name:'城堡大厅',description:'旧地点描述'}]});
  for(let i=0;i<12;i++)
    add('探索新地点',{scenes:[{op:'add',name:'新地点'+i,description:'漫长的其他地点说明'.repeat(12)}]});
  add('回到大厅',{location:'城堡大厅'});
  const cfg=config();cfg.retrieval.enabled=false;cfg.injection.inventory=false;
  let out=injectionText(memory,chat,cfg);
  assert.match(section(out,'场景'),/城堡大厅/);
  add('移至未知地点',{location:''});
  // No falsely inferred current location; use record update recency instead.
  out=injectionText(memory,chat,cfg);
  assert.match(section(out,'场景'),/新地点11/);
});

test('reserve at least one item and scene against huge retrieved history when space allows',()=>{
  const {chat,memory,add}=historyState();
  add('走进大厅',{location:'城堡大厅',items:[
    {op:'add',name:'随身钥匙',owner:'主角',description:'很小的钥匙'},
    {op:'add',name:'无人认领的徽章',description:'历史记录'.repeat(12)}
  ],scenes:[{op:'add',name:'城堡大厅',location:'城中'}]});
  const cfg=config();
  const hits=Array.from({length:12},(_,i)=>({text:'历史资料'+i+'：'+'旧信息'.repeat(32)}));
  const report={},out=injectionText(memory,chat,cfg,[],hits,report);
  assert.ok(section(out,'相关历史').length>0,'history still gets an allocation');
  assert.match(section(out,'物品'),/随身钥匙/);
  assert.match(section(out,'场景'),/城堡大厅/);
  assert.ok(out.length<=cfg.injection.budget*3);
  assert.equal(out,injectionText(memory,chat,cfg,[],hits));
  for(const line of out.split('\n').filter(x=>x.startsWith('{')))
    assert.doesNotThrow(()=>JSON.parse(line));
  for(const item of report.sections)
    assert.equal(item.omitted,item.skippedBudget+item.skippedDuplicate+item.skippedEmpty);
});

test('narrative remains first and can exhaust the budget; disabled sections get no reserve',()=>{
  const {chat,memory,add}=historyState();
  add('主线剧情关键抉择。'.repeat(35),{
    location:'城堡大厅',items:[{op:'add',name:'随身物品',owner:'主角'}],
    scenes:[{op:'add',name:'城堡大厅'}]
  });
  const cfg=config();cfg.summary.keepRecent=0;
  const report={},out=injectionText(memory,chat,cfg,[],[],report);
  assert.match(out,/主线剧情关键抉择/);
  assert.ok(out.length<=1200);
  cfg.injection.scenes=false;
  const disabled=injectionText(memory,chat,cfg);
  assert.doesNotMatch(disabled,/【场景】/);
});

test('host tokenizer shrink is still bounded and reports actual selected entries',async()=>{
  const {chat,memory,add}=historyState();
  add('主线承诺',{location:'旅馆',items:[{op:'add',name:'记录本',owner:'主角'}],
    scenes:[{op:'add',name:'旅馆'}]});
  const cfg=config();
  cfg.summary.keepRecent=0;
  const report={};
  const text=await injectionTextWithinBudget(memory,chat,cfg,[],[],
    async value=>({tokens:Math.ceil(value.length/1.6),estimated:false}),report);
  assert.ok(report.usedTokens<=400);
  assert.match(text,/主线承诺/);
  assert.equal(report.usedTokens,Math.ceil(text.length/1.6));
  const again=await injectionTextWithinBudget(memory,chat,cfg,[],[],
    async value=>({tokens:Math.ceil(value.length/1.6),estimated:false}));
  assert.equal(text,again,'token budget selection must be deterministic');
});

test('explicit player backpack location counts as held, but an NPC-owned item does not',()=>{
  const {chat,memory,add}=historyState();
  add('早期背包',{items:[
    {op:'add',name:'口袋里的怀表',location:'主角的口袋'},
    {op:'add',name:'旅馆老板的怀表',owner:'旅馆老板',location:'老板口袋'}
  ]});
  for(let i=0;i<50;i++)
    add('后续收集',{items:[{op:'add',name:'普通道具'+i,
      description:'冗长的库存资料'.repeat(22)}]});
  const cfg=config();cfg.retrieval.enabled=false;
  const out=injectionText(memory,chat,cfg);
  assert.match(section(out,'物品'),/口袋里的怀表/);
  assert.doesNotMatch(section(out,'物品'),/旅馆老板的怀表/);
});

test('an old current scene survives the 45-entity shortlist',()=>{
  const {chat,memory,add}=historyState();
  add('在大厅',{scenes:[{op:'add',name:'旧城区图书馆',description:'重要地点'}]});
  for(let i=0;i<52;i++)
    add('经过其他场景',{scenes:[{op:'add',name:'无关地点'+i,
      description:'较长的远方地点说明'.repeat(8)}]});
  add('重新进入图书馆',{location:'旧城区图书馆'});
  const cfg=config();cfg.retrieval.enabled=false;cfg.injection.inventory=false;
  const report={},out=injectionText(memory,chat,cfg,[],[],report);
  assert.match(section(out,'场景'),/旧城区图书馆/);
  const stats=report.sections.find(x=>x.title==='【场景】');
  assert.ok(stats.selected<=45);
});

test('no extra capacity cannot displace higher-priority plots or overrun the budget',()=>{
  const {chat,memory,add}=historyState();
  add('主线剧情重大进展。'.repeat(50),{
    location:'议会大厅',
    items:[{op:'add',name:'公函',owner:'主角',description:'内容较长'.repeat(50)}],
    scenes:[{op:'add',name:'议会大厅',description:'空间详细描述'.repeat(50)}]
  });
  const cfg=config();cfg.summary.keepRecent=0;
  const report={},out=injectionText(memory,chat,cfg,[],[],report);
  assert.match(out,/主线剧情重大进展/);
  assert.ok(out.length<=1200);
  assert.equal(report.sections.at(0).title,'【剧情摘要】');
  for(const part of report.sections)
    assert.equal(part.omitted,part.skippedBudget+part.skippedDuplicate+part.skippedEmpty);
});

test('unsummarized user handoff marks previous owner and scene state as unverified',()=>{
  const {chat,memory,add}=historyState();
  add('主角进入城堡大厅并持有银钥匙',{location:'城堡大厅',
    items:[{op:'add',name:'银钥匙',owner:'主角',location:'背包',quantity:1}],
    scenes:[{op:'add',name:'城堡大厅',status:'有人驻守'}]});
  chat.push({is_user:true,mes:'我把钥匙交给卫兵，离开城堡大厅来到森林'});
  const cfg=config(16000);cfg.summary.keepRecent=0;
  const out=injectionText(memory,chat,cfg);
  assert.match(out,/记录时持有者":"主角"/);
  assert.match(out,/记录时位置":"背包"/);
  assert.match(out,/记录时数量":1/);
  assert.doesNotMatch(out,/"owner":"主角"/);
  assert.match(section(out,'场景'),/状态待核对/);
  assert.match(out,/以新原文为准/);
  assert.doesNotMatch(out,/"owner":"卫兵"/,
    'the injector must not infer the new owner from unsummarized prose');
});

test('unprocessed AI reply also marks prior item states stale',()=>{
  const {chat,memory,add}=historyState();
  add('持有的旧道具',{items:[{op:'add',name:'旧灯笼',owner:'主角',status:'点亮'}]});
  chat.push({is_user:false,mes:'卫兵接过旧灯笼',swipe_id:0});
  const out=injectionText(memory,chat,config(16000));
  assert.match(out,/"记录时持有者":"主角"/);
  assert.match(out,/"记录时状态":"点亮"/);
  assert.doesNotMatch(out,/"owner":"主角"/);
});

test('after committing the newer confirmed change stale labels disappear',()=>{
  const {chat,memory,add}=historyState();
  add('持有银钥匙',{items:[{op:'add',name:'银钥匙',owner:'主角'}]});
  chat.push({is_user:true,mes:'我把钥匙交给卫兵'});
  const ai={is_user:false,mes:'卫兵确认接过银钥匙',swipe_id:0};
  chat.push(ai);
  const next=commitLeaf(memory,2,messageFingerprint(ai),normalizeDelta({
    summary:'卫兵接过银钥匙',items:[{op:'update',name:'银钥匙',owner:'卫兵'}]}));
  const out=injectionText(next,chat,config(16000));
  assert.match(out,/"owner":"卫兵"/);
  assert.doesNotMatch(out,/记录时持有者|最新剧情尚未全部摘要/);
});

test('personal names from host context retain old player-held items above 45 candidates',()=>{
  const {chat,memory,add}=historyState();
  add('古旧物件',{items:[
    {op:'add',name:'早期护符',owner:'云青'},
    {op:'add',name:'另一人的护符',owner:'云青的朋友'}
  ]});
  for(let i=0;i<52;i++)
    add('后续道具',{items:[{op:'add',name:'道具'+i,owner:'不明'}]});
  const cfg=config(16000);cfg.retrieval.enabled=false;
  const withPersona=injectionText(memory,chat,cfg,[],[],null,null,'云青');
  const withoutPersona=injectionText(memory,chat,cfg,[],[],null,null,'');
  assert.match(section(withPersona,'物品'),/早期护符/);
  assert.doesNotMatch(section(withPersona,'物品'),/另一人的护符/);
  assert.doesNotMatch(section(withoutPersona,'物品'),/早期护符/);
});

test('manual records stay user-authored while stale automatic records get warnings',()=>{
  const {chat,memory,add}=historyState();
  add('最初记录',{items:[{op:'add',name:'旧火把',owner:'主角'}]});
  memory.manual.items.push({id:'manual:1',text:'用户确认：随身携带指南针'});
  chat.push({is_user:true,mes:'后来事件尚未整理'});
  const out=injectionText(memory,chat,config(16000));
  assert.match(out,/用户确认：随身携带指南针/);
  assert.match(out,/旧火把/);
  assert.match(out,/记录时持有者/);
});

test('host persona propagates through the token-checked injection and both host callers',async()=>{
  const {chat,memory,add}=historyState();
  add('旧物',{items:[{op:'add',name:'玩家的斗篷',owner:'云青'}]});
  for(let i=0;i<51;i++)add('普通物',{items:[{op:'add',name:'普通记事本'+i}]});
  const cfg=config(16000),count=async text=>({tokens:Math.ceil(text.length/3),estimated:false});
  const payload=await injectionTextWithinBudget(memory,chat,cfg,[],[],count,null,'云青');
  assert.match(payload,/玩家的斗篷/);
  assert.ok(payload.length<=cfg.injection.budget*3);
});
