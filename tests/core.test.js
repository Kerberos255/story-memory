import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings,freshMemory,readMemory,writeMemory,normalizeDelta,commitLeaf,deriveState,pendingFloors,injectionText,messageFingerprint,addManual,editManual} from '../core.js';
const makeChat=()=>[
 {is_user:true,is_system:false,mes:'我找到一只旧怀表。'},
 {is_user:false,is_system:false,mes:'角色拾起怀表并走进图书馆。',swipe_id:0},
 {is_user:true,is_system:false,mes:'把怀表交给同伴。'},
 {is_user:false,is_system:false,mes:'同伴收下怀表，答应明日归还。',swipe_id:0}
];
const event=(summary,items=[])=>normalizeDelta({summary,items});
test('auto-summary and auto-hide default on with a three-floor protection window',()=>{
 const cfg=defaultSettings();
 assert.equal(cfg.summary.autoHide,true);
 assert.equal(cfg.autoSummary,true);
 assert.equal(cfg.summary.keepRecent,3);
});
test('NPC knowledge is an evidence-backed update on the existing character identity',()=>{
 const source='守门人听到了密令：青松。';
 const chat=[{is_user:false,mes:source,swipe_id:0},{is_user:false,mes:'守门人得知密令已失效。',swipe_id:0}];
 let mem=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({
   summary:'守门人得知密令',characters:[{op:'add',name:'守门人',knowledge:[
     {fact:'密令是青松',stance:'knows',evidence:'守门人听到了密令：青松。'},
     {fact:'不知道的秘密',stance:'knows',evidence:'本轮没有的句子'}
   ]}]
 },source));
 let state=deriveState(mem,chat);
 assert.equal(state.characters.length,1);
 assert.deepEqual(state.characters[0].knowledge.map(x=>x.fact),['密令是青松']);
 const charId=state.characters[0].entity_id;
 mem=commitLeaf(mem,1,messageFingerprint(chat[1]),normalizeDelta({
   summary:'密令失效',characters:[{op:'update',entity_id:charId,name:'老门卫',knowledge:[
     {fact:'密令是青松',stance:'knows',evidence:'守门人得知密令已失效。',op:'remove'}
   ]}]
 },chat[1].mes));
 state=deriveState(mem,chat);
 assert.equal(state.characters.length,1,'same character identity');
 assert.equal(state.characters[0].entity_id,charId);
 assert.deepEqual(state.characters[0].knowledge,[],'explicit removal revokes only this knowledge');
 assert.deepEqual(normalizeDelta({summary:'状态',items:[{name:'钥匙',evidence:'伪造证据'}]},source).delta.items,[]);
});
test('injection skips over-budget full entries instead of slicing memory or JSON',()=>{
 const cfg=defaultSettings();cfg.injection.budget=400;cfg.summary.keepRecent=0;
 cfg.injection.vector=true;
 const chat=[{is_user:false,mes:'剧情',swipe_id:0}];
 let memory=freshMemory();
 memory.manual.summaries.push({id:'manual:large',text:'极长笔记开始'+ '甲'.repeat(1600)});
 memory=commitLeaf(memory,0,messageFingerprint(chat[0]),normalizeDelta({summary:'完整短摘要',characters:[
   {op:'add',name:'甲',description:'角色描述'.repeat(45)},
   {op:'add',name:'乙',status:'在场'}
 ]}));
 const output=injectionText(memory,chat,cfg,[{text:'不可截断的长召回'.repeat(150)}]);
 assert.ok(output.includes('完整短摘要'));
 assert.ok(!output.includes('极长笔记开始'));
 assert.ok(!output.includes('不可截断的长召回'));
 assert.ok(output.length<=1200,'approximate budget is respected');
 for(const line of output.split('\n').filter(x=>x.startsWith('{')))assert.doesNotThrow(()=>JSON.parse(line));
});
test('invalid model JSON cannot mutate memory',()=>{
 const memory=freshMemory();
 assert.throws(()=>normalizeDelta({items:[]}),/summary/);
 assert.throws(()=>normalizeDelta({summary:'hi',items:{}}),/数组/);
 assert.deepEqual(memory,freshMemory());
});
test('structured changes apply once; stale swipes vanish',()=>{
 const chat=makeChat();
 let m=commitLeaf(freshMemory(),1,messageFingerprint(chat[1]),event('拾起怀表',[{op:'add',name:'怀表',quantity:1}]));
 m=commitLeaf(m,3,messageFingerprint(chat[3]),event('交给同伴',[{op:'update',name:'怀表',owner:'同伴',quantity:1}]));
 assert.equal(deriveState(m,chat).items.length,1);
 assert.equal(deriveState(m,chat).items[0].owner,'同伴');
 assert.deepEqual(pendingFloors(m,chat),[]);
 chat[3].swipe_id=1;chat[3].mes='同伴拒绝收下怀表。';
 assert.deepEqual(pendingFloors(m,chat),[3]);
 assert.equal(deriveState(m,chat).items[0].owner,undefined);
});
test('manual text is chat scoped and editable',()=>{
 const chat=makeChat(),cfg=defaultSettings();cfg.summary.keepRecent=0;
 let m=addManual(freshMemory(),'summaries','前情概要');
 const id=m.manual.summaries[0].id;
 m=editManual(m,'summaries',id,'前情概要（更正）');
 assert.match(injectionText(m,chat,cfg),/更正/);
 assert.throws(()=>editManual(m,'items','missing','x'),/不存在/);
});
test('completed chapter replaces duplicate leaf in injection',()=>{
 const chat=makeChat(),cfg=defaultSettings();cfg.summary.keepRecent=0;
 let m=commitLeaf(freshMemory(),1,messageFingerprint(chat[1]),event('古老时钟响起'));
 m.chapters.push({id:'chapter:1',children:['floor:1'],summary:'章节里记录古老时钟'});
 const rendered=injectionText(m,chat,cfg);
 assert.match(rendered,/章节里记录/);
 assert.equal((rendered.match(/古老时钟/g)||[]).length,1);
});
test('memory is saved only inside chat metadata',()=>{
 let saves=0;const ctx={chatMetadata:{},saveMetadataDebounced(){saves++;}};
 const memory=addManual(freshMemory(),'items','银色钥匙');
 writeMemory(ctx,memory);
 assert.equal(saves,1);
 assert.equal(readMemory(ctx).manual.items[0].text,'银色钥匙');
});
test('manual record deletion works without affecting other records',async()=>{
 const {removeManual}=await import('../core.js');
 let mem=addManual(freshMemory(),'items','银色钥匙');
 mem=addManual(mem,'items','青铜戒指');
 const id=mem.manual.items[0].id;
 const next=removeManual(mem,'items',id);
 assert.equal(next.manual.items.length,1);
 assert.equal(next.manual.items[0].text,'青铜戒指');
 assert.equal(mem.manual.items.length,2);
});

test('multi-level compression preserves leaf sources and continues through L3+',async()=>{
 const {nextCompression,commitCompression,validChapters,compressionRoots,recentAiStart}=await import('../core.js');
 const cfg=defaultSettings();
 cfg.summary.leafBatchThreshold=2;cfg.summary.leafKeepRecent=1;
 cfg.summary.resummaryThreshold=2;cfg.summary.higherResummaryThreshold=2;
 const chat=[],created=[];
 let m=freshMemory();
 for(let i=0;i<20;i++){
   chat.push({is_user:true,mes:'输入 '+i},{is_user:false,mes:'剧情 '+i,swipe_id:0});
   m=commitLeaf(m,2*i+1,messageFingerprint(chat[2*i+1]),event('第'+i+'条剧情'));
 }
 let count=0;
 while(count++<45){
   const plan=nextCompression(m,chat,cfg);
   if(!plan)break;
   created.push(plan.level);
   m=commitCompression(m,chat,plan,'总结 L'+plan.level+' '+count);
 }
 assert.ok(created.includes(1),'L1 never created');
 assert.ok(created.includes(2),'L2 never created');
 assert.ok(created.includes(3),'L3 never created');
 assert.equal(Object.keys(m.leaves).length,20,'lossless leaf storage');
 assert.equal(validChapters(m,chat).length,m.chapters.length);
 assert.ok(compressionRoots(m,chat,0).length>=1);
 assert.equal(recentAiStart(chat,3),chat.length-5);
 assert.equal(recentAiStart(chat,0),chat.length);
 assert.ok(m.chapters.every(c=>c.children.length>=2));
});
test('compression continues through L10 and L11 without a hard-coded maximum',async()=>{
 const {nextCompression,commitCompression,validChapters}=await import('../core.js');
 const chat=Array.from({length:4},(_,i)=>({is_user:false,mes:'剧情'+i,swipe_id:0}));
 let memory=freshMemory();
 for(let i=0;i<chat.length;i++)memory.leaves[i]={
   id:'floor:'+i,sourceIndex:i,fingerprint:messageFingerprint(chat[i]),summary:'摘要'+i
 };
 // Small synthetic deep tree: existing chapter validation accepts one-child nodes.
 // Four independent branches at L9 allow two L10 nodes and then an L11 root.
 for(let level=1;level<=9;level++)for(let i=0;i<4;i++)memory.chapters.push({
   id:'synthetic:'+level+':'+i,level,
   children:[level===1?'floor:'+i:'synthetic:'+(level-1)+':'+i],
   summary:'已有 L'+level+' 记忆'+i
 });
 const cfg=defaultSettings();
 cfg.summary.leafBatchThreshold=2;cfg.summary.leafKeepRecent=0;
 cfg.summary.resummaryThreshold=2;cfg.summary.higherResummaryThreshold=2;
 assert.equal(validChapters(memory,chat).length,36);
 for(const expected of [10,10,11]){
   const plan=nextCompression(memory,chat,cfg);
   assert.equal(plan?.level,expected);
   memory=commitCompression(memory,chat,plan,'新生成 L'+expected);
 }
 assert.equal(validChapters(memory,chat).length,39);
 assert.equal(nextCompression(memory,chat,cfg),null);
 assert.equal(Object.keys(memory.leaves).length,4,'all source floors remain available');
});
test('compression rejects changed swipe and supports disabling each threshold',async()=>{
 const {nextCompression,commitCompression}=await import('../core.js');
 const chat=Array.from({length:6},(_,i)=>({is_user:false,mes:'场景'+i,swipe_id:0}));
 let m=freshMemory();
 for(let i=0;i<chat.length;i++)m=commitLeaf(m,i,messageFingerprint(chat[i]),event('剧情'+i));
 const cfg=defaultSettings();cfg.summary.leafBatchThreshold=2;cfg.summary.leafKeepRecent=0;
 const plan=nextCompression(m,chat,cfg);
 assert.equal(plan.level,1);
 chat[0].swipe_id=2;
 assert.throws(()=>commitCompression(m,chat,plan,'不应保存的压缩'),/压缩源已变化/);
 cfg.summary.leafBatchThreshold=0;
 assert.equal(nextCompression(m,chat,cfg),null);
});

test('automatic summary delays the newest three AI replies and counts user messages correctly',async()=>{
 const {automaticFloorIndices,hideReadyIndices,recentAiStart,userFingerprint,normalizeDelta,commitLeaf}=await import('../core.js');
 const chat=[];
 for(let i=0;i<5;i++)chat.push({is_user:true,mes:'用户'+i},
   {is_user:false,mes:'AI'+i,swipe_id:0});
 const cfg=defaultSettings(),mem0={version:1,leaves:{},chapters:[],manual:{summaries:[],items:[],scenes:[],characters:[]},tasks:{},revision:0};
 assert.equal(recentAiStart(chat,3),5);
 assert.deepEqual(automaticFloorIndices(mem0,chat,3),[1,3]);
 assert.deepEqual(automaticFloorIndices(mem0,chat,0),[1,3,5,7,9]);
 let mem=mem0;
 for(let i of [1,3])mem=commitLeaf(mem,i,messageFingerprint(chat[i]),normalizeDelta({summary:'摘要 '+i}),userFingerprint(chat,i));
 cfg.summary.autoHide=true;
 assert.deepEqual(hideReadyIndices(mem,chat,cfg),[0,1,2,3]);
 cfg.summary.autoHide=false;
 assert.deepEqual(hideReadyIndices(mem,chat,cfg),[]);
 cfg.summary.autoHide=true;
 chat[3].swipe_id=1;
 assert.deepEqual(hideReadyIndices(mem,chat,cfg),[0,1]);
});
test('hidden AI messages preserve leaf fingerprints; a manual unhide is respected',async()=>{
 const {hideReadyIndices,userFingerprint,normalizeDelta,commitLeaf,automaticFloorIndices}=await import('../core.js');
 const chat=[];
 for(let i=0;i<5;i++)chat.push({is_user:true,mes:'对话'+i},{is_user:false,mes:'回复'+i,swipe_id:0});
 let m=freshMemory();
 m=commitLeaf(m,1,messageFingerprint(chat[1]),normalizeDelta({summary:'原始有效摘要'}),userFingerprint(chat,1));
 const settings=defaultSettings();settings.summary.autoHide=true;
 const [user,ai]=hideReadyIndices(m,chat,settings);
 assert.deepEqual([user,ai],[0,1]);
 chat[1].extra={story_memory_hidden:true};chat[1].is_system=true;
 chat[0].extra={story_memory_hidden:true};chat[0].is_system=true;
 assert.equal(messageFingerprint(chat[1]),m.leaves[1].fingerprint);
 assert.ok(!automaticFloorIndices(m,chat,3).includes(1));
 assert.equal(injectionText(m,chat,settings).includes('原始有效摘要'),true);
 chat[1].is_system=false; // User performed /unhide
 assert.ok(!hideReadyIndices(m,chat,settings).includes(1),'do not re-hide user-unhidden message');
});

test('edited user text invalidates leaf; oversized source cannot be auto-hidden',async()=>{
 const {leafValid,userFingerprint,hideReadyIndices,staleHiddenIndices}=await import('../core.js');
 const chat=[];
 for(let i=0;i<5;i++)chat.push({is_user:true,mes:'用户 '+i},{is_user:false,mes:'回复 '+i});
 let memory=freshMemory();
 memory=commitLeaf(memory,1,messageFingerprint(chat[1]),normalizeDelta({summary:'旧剧情'}),userFingerprint(chat,1));
 const cfg=defaultSettings();cfg.summary.autoHide=true;
 assert.deepEqual(hideReadyIndices(memory,chat,cfg),[0,1]);
 chat[0].mes='修改过的用户输入';
 assert.equal(leafValid(memory,chat,1),false);
 assert.deepEqual(pendingFloors(memory,chat).includes(1),true);
 assert.deepEqual(hideReadyIndices(memory,chat,cfg),[]);
 chat[0].mes='用户 0';
 chat[0].is_system=true;chat[0].extra={story_memory_hidden:true};
 chat[1].is_system=true;chat[1].extra={story_memory_hidden:true};
 chat[1].mes='新剧情';
 assert.deepEqual(staleHiddenIndices(memory,chat),[0,1]);
 chat[1].mes='回复 0';
 chat[0].is_system=false;chat[1].is_system=false;
 chat[0].mes='超长'.repeat(3100);
 memory=commitLeaf(memory,1,messageFingerprint(chat[1]),normalizeDelta({summary:'截断材料'}),userFingerprint(chat,1));
 assert.deepEqual(hideReadyIndices(memory,chat,cfg),[]);
 chat[0].mes='用户 0';chat[1].mes='超长'.repeat(9000);
 memory=commitLeaf(memory,1,messageFingerprint(chat[1]),normalizeDelta({summary:'截断 AI'}),userFingerprint(chat,1));
 assert.deepEqual(hideReadyIndices(memory,chat,cfg),[]);
});

test('story timestamp canonicalization preserves uncertain times and unifies known date ranges',async()=>{
 const {formatStoryTime}=await import('../core.js');
 assert.equal(formatStoryTime('2026/7/11 星期六 06:22-06:29'),'2026/07/11 · 06:22–06:29');
 assert.equal(formatStoryTime('2026/7/11 06:15-06:22'),'2026/07/11 · 06:15–06:22');
 assert.equal(formatStoryTime('[2026/7/11 | 星期六 | 06:48]'),'2026/07/11 · 06:48');
 assert.equal(formatStoryTime('2026-07-11T06:48'),'2026/07/11 · 06:48');
 assert.equal(formatStoryTime('深夜'),'深夜');
 assert.equal(formatStoryTime('2026/2/30 09:00'),'2026/2/30 09:00');
 assert.equal(normalizeDelta({summary:'过程',time:'2026/7/11 星期六 06:22-06:29'}).time,
   '2026/07/11 · 06:22–06:29');
});
test('generated summary editing preserves structured facts and invalidates higher-level conclusions',async()=>{
 const {editGeneratedLeaf,deleteGeneratedLeaf,resumeGeneratedFloor,leafValid,validChapters}=await import('../core.js');
 const chat=makeChat();
 let mem=commitLeaf(freshMemory(),1,messageFingerprint(chat[1]),
   normalizeDelta({summary:'旧摘要',time:'2026/7/11 06:22-06:29',items:[{op:'add',name:'钥匙',owner:'角色'}]}));
 mem.chapters.push({id:'chapter:1',level:1,children:['floor:1'],summary:'旧章节'});
 const revised=editGeneratedLeaf(mem,chat,1,{summary:'修改过的事实',time:'2026/7/11 星期六 06:22-06:29',location:'小巷'});
 assert.equal(revised.leaves[1].summary,'修改过的事实');
 assert.equal(revised.leaves[1].time,'2026/07/11 · 06:22–06:29');
 assert.equal(revised.leaves[1].delta.items[0].name,'钥匙');
 assert.equal(revised.chapters.length,0);
 assert.equal(mem.chapters.length,1,'source value remains immutable');
 assert.equal(leafValid(revised,chat,1),true);
 const removed=deleteGeneratedLeaf(revised,chat,1);
 assert.equal(removed.leaves[1],undefined);
 assert.equal(deriveState(removed,chat).items.length,0,'deleted extraction should disappear');
 assert.ok(!pendingFloors(removed,chat).includes(1),'explicit delete should suppress regeneration');
 const reenabled=resumeGeneratedFloor(removed,1);
 assert.ok(pendingFloors(reenabled,chat).includes(1),'explicit retry reopens the floor');
 chat[1].mes='剧情文本已修改';
 assert.ok(pendingFloors(removed,chat).includes(1),'changed source can be automatically summarized');
 assert.throws(()=>resumeGeneratedFloor(reenabled,1),/未标记/);
 assert.throws(()=>editGeneratedLeaf(removed,chat,1,{summary:'非法'}),/变化/);
});
test('manually edited or deleted chapter invalidates ancestors without removing original floors',async()=>{
 const {editGeneratedChapter,deleteGeneratedChapter,nextCompression,commitCompression}=await import('../core.js');
 const chat=Array.from({length:4},(_,i)=>({is_user:false,mes:'事件'+i}));
 let mem=freshMemory();
 for(let i=0;i<4;i++)mem=commitLeaf(mem,i,messageFingerprint(chat[i]),normalizeDelta({summary:'事件摘要 '+i}));
 const cfg=defaultSettings();cfg.summary.leafBatchThreshold=2;cfg.summary.leafKeepRecent=0;cfg.summary.resummaryThreshold=2;
 let plan=nextCompression(mem,chat,cfg);
 mem=commitCompression(mem,chat,plan,'第一阶段');
 const first=mem.chapters[0].id;
 plan=nextCompression(mem,chat,cfg);mem=commitCompression(mem,chat,plan,'第二阶段');
 const second=mem.chapters[1].id;
 plan=nextCompression(mem,chat,cfg);
 mem=commitCompression(mem,chat,plan,'阶段总览');
 assert.equal(mem.chapters.length,3);
 const edited=editGeneratedChapter(mem,chat,first,'第一阶段修正');
 assert.equal(edited.chapters.length,2,'parent conclusion must be dropped');
 assert.ok(edited.chapters.some(c=>c.id===second));
 assert.equal(edited.chapters.find(c=>c.id===first).summary,'第一阶段修正');
 const deleted=deleteGeneratedChapter(edited,chat,first);
 assert.equal(Object.keys(deleted.leaves).length,4);
 assert.equal(deleted.chapters.length,1);
 assert.ok(deleted.skippedPlans.some(s=>s.includes('floor:0')&&s.includes('floor:1')));
 assert.equal(mem.chapters.length,3,'prior state not mutated');
});

test('existing entity IDs reconcile differently named items without changing canonical name',async()=>{
 const {mergeEntities,unmergeEntity}=await import('../core.js');
 const chat=[{is_user:false,mes:'拾起银钥匙'},{is_user:false,mes:'守卫交出那把钥匙'}];
 let mem=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({
   summary:'发现钥匙',items:[{op:'add',name:'银钥匙',owner:'守卫',quantity:1}]
 }));
 const entityId=deriveState(mem,chat).items[0].entity_id;
 assert.match(entityId,/^items:0:[a-f0-9]{8}$/);
 mem=commitLeaf(mem,1,messageFingerprint(chat[1]),normalizeDelta({
   summary:'钥匙转交',items:[{op:'update',entity_id:entityId,name:'守卫的钥匙',owner:'旅人',quantity:1}]
 }));
 const [item]=deriveState(mem,chat).items;
 assert.equal(deriveState(mem,chat).items.length,1);
 assert.equal(item.name,'银钥匙');
 assert.equal(item.owner,'旅人');
 assert.deepEqual(item.aliases,['守卫的钥匙']);
 const original=structuredClone(mem);
 const rederived=deriveState(mem,chat);
 assert.deepEqual(rederived.items,deriveState(mem,chat).items);
 assert.deepEqual(mem,original,'deriving state must not rewrite chat memory');
});
test('scenes and characters use stable IDs; same-named types remain distinct',()=>{
 const chat=[{is_user:false,mes:'地点与人物出现'},{is_user:false,mes:'称呼改变'}];
 let mem=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({
   summary:'出现',
   scenes:[{op:'add',name:'东侧走廊',location:'旧宅'}],
   characters:[{op:'add',name:'守门人',status:'在场'}],
   items:[{op:'add',name:'守门人',description:'写有此名字的徽章'}]
 }));
 const state=deriveState(mem,chat);
 mem=commitLeaf(mem,1,messageFingerprint(chat[1]),normalizeDelta({
   summary:'更多信息',
   scenes:[{op:'update',entity_id:state.scenes[0].entity_id,name:'东廊',description:'灯光变暗'}],
   characters:[{op:'update',entity_id:state.characters[0].entity_id,name:'老门卫',status:'离开'}],
 }));
 const now=deriveState(mem,chat);
 assert.equal(now.scenes.length,1);
 assert.equal(now.scenes[0].name,'东侧走廊');
 assert.equal(now.scenes[0].description,'灯光变暗');
 assert.equal(now.characters.length,1);
 assert.equal(now.characters[0].name,'守门人');
 assert.equal(now.characters[0].status,'离开');
 assert.equal(now.items.length,1,'a name shared with a character must not collide');
});
test('different named objects are not fuzzy-merged; unknown IDs cannot force identity',()=>{
 const chat=[{is_user:false,mes:'两把钥匙'},{is_user:false,mes:'另外一把'}];
 let mem=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({summary:'两把钥匙',
   items:[{op:'add',name:'银钥匙',quantity:1},{op:'add',name:'铜钥匙',quantity:1}]}));
 const fake='items:999:deadbeef';
 mem=commitLeaf(mem,1,messageFingerprint(chat[1]),normalizeDelta({summary:'新的描述',
   items:[{op:'update',name:'钥匙扣上的钥匙',entity_id:fake,owner:'旅人'}]}));
 assert.equal(deriveState(mem,chat).items.length,3);
 assert.equal(normalizeDelta({summary:'a',items:[{name:'a',entity_id:'characters:bad'}]}).delta.items[0].entity_id,undefined);
});
test('manual alias merge works for existing records and can be reverted independently per kind',async()=>{
 const {mergeEntities,unmergeEntity}=await import('../core.js');
 const chat=[{is_user:false,mes:'道具出现'},{is_user:false,mes:'同一件道具的新称呼'}];
 let mem=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({summary:'拾起物品',
   items:[{op:'add',name:'银色钥匙',owner:'旅人',quantity:1}],
   scenes:[{op:'add',name:'银色钥匙',description:'房间代号'}]}));
 mem=commitLeaf(mem,1,messageFingerprint(chat[1]),normalizeDelta({summary:'物品位置变化',
   items:[{op:'update',name:'旅人的钥匙',location:'背包',quantity:1}],
   scenes:[{op:'add',name:'旅人的钥匙',description:'另一房间代号'}]}));
 const before=deriveState(mem,chat);
 assert.equal(before.items.length,2);
 assert.equal(before.scenes.length,2);
 const merged=mergeEntities(mem,chat,'items',before.items[1].entity_id,before.items[0].entity_id);
 assert.equal(deriveState(merged,chat).items.length,1);
 assert.equal(deriveState(merged,chat).items[0].name,'银色钥匙');
 assert.equal(deriveState(merged,chat).items[0].location,'背包');
 assert.equal(deriveState(merged,chat).scenes.length,2);
 assert.equal(Object.keys(mem.entityAliases).length,0);
 const undone=unmergeEntity(merged,'items','旅人的钥匙');
 assert.equal(deriveState(undone,chat).items.length,2);
 assert.throws(()=>mergeEntities(mem,chat,'items',before.items[0].entity_id,before.items[0].entity_id),/不同/);
});
test('remove by known entity ID updates tracked identity rather than creating another item',()=>{
 const chat=[{is_user:false,mes:'添加物品'},{is_user:false,mes:'物品遗失'}];
 let mem=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({
   summary:'获得',items:[{op:'add',name:'旧钥匙'}]}));
 const id=deriveState(mem,chat).items[0].entity_id;
 mem=commitLeaf(mem,1,messageFingerprint(chat[1]),normalizeDelta({
   summary:'遗失',items:[{op:'remove',name:'随身钥匙',entity_id:id}]}));
 assert.equal(deriveState(mem,chat).items.length,0);
});

test('canonical entity reference preserves item identity across descriptions and owners',async()=>{
 const {mergeEntities,unmergeEntity}=await import('../core.js');
 const chat=Array.from({length:3},(_,i)=>({is_user:false,mes:'剧情'+i}));
 let memory=freshMemory();
 const first=normalizeDelta({summary:'物品首次出现',items:[{op:'add',name:'纯棉内裤',owner:'星',quantity:1}]});
 memory=commitLeaf(memory,0,messageFingerprint(chat[0]),first);
 const known=deriveState(memory,chat).items[0];
 assert.match(known.entity_id,/^items:0:[a-f0-9]{8}$/);
 memory=commitLeaf(memory,1,messageFingerprint(chat[1]),normalizeDelta({summary:'后续发展',items:[
  {op:'update',entity_id:known.entity_id,name:'星的内裤',location:'星右脚踝',description:'移动位置'}
 ]}));
 let items=deriveState(memory,chat).items;
 assert.equal(items.length,1);
 assert.equal(items[0].entity_id,known.entity_id);
 assert.equal(items[0].name,'纯棉内裤');
 assert.deepEqual(items[0].aliases,['星的内裤']);
 memory=commitLeaf(memory,2,messageFingerprint(chat[2]),normalizeDelta({summary:'又有一件不同物品',items:[
  {op:'add',name:'另一件内裤',owner:'星',quantity:1}
 ]}));
 items=deriveState(memory,chat).items;
 assert.equal(items.length,2,'similar items may actually be different objects');
 const merged=mergeEntities(memory,chat,'items',items[1].entity_id,items[0].entity_id);
 assert.equal(deriveState(merged,chat).items.length,1,'manual explicit merge reunifies legacy aliases');
 assert.equal(deriveState(memory,chat).items.length,2,'original memory preserved');
 assert.equal(deriveState(unmergeEntity(merged,'items','另一件内裤'),chat).items.length,2);
});
test('scene and character IDs avoid duplicate records without mixing categories',async()=>{
 const chat=Array.from({length:2},(_,i)=>({is_user:false,mes:'故事'+i}));
 let memory=freshMemory();
 memory=commitLeaf(memory,0,messageFingerprint(chat[0]),normalizeDelta({summary:'初始',
  scenes:[{op:'add',name:'街道十字路口'},{op:'add',name:'十字路口旁酒馆'}],
  characters:[{op:'add',name:'林静'},{op:'add',name:'林静的妹妹'}]
 }));
 const current=deriveState(memory,chat);
 memory=commitLeaf(memory,1,messageFingerprint(chat[1]),normalizeDelta({summary:'称呼变化',
  scenes:[{op:'update',entity_id:current.scenes[0].entity_id,name:'路口',status:'雨中'}],
  characters:[{op:'update',entity_id:current.characters[0].entity_id,name:'林老师',status:'平静'}]
 }));
 const result=deriveState(memory,chat);
 assert.equal(result.scenes.length,2);
 assert.equal(result.characters.length,2);
 assert.equal(result.scenes[0].name,'街道十字路口');
 assert.equal(result.characters[0].name,'林静');
 assert.equal(result.characters[1].name,'林静的妹妹');
 assert.equal(result.scenes[0].status,'雨中');
 assert.equal(result.characters[0].status,'平静');
});
