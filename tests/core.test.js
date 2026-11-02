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
