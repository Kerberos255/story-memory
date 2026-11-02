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
