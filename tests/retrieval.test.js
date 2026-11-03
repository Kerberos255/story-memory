import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings,freshMemory,commitLeaf,messageFingerprint,userFingerprint,normalizeDelta,META_KEY,injectionText} from '../core.js';
import {searchTerms,searchIndex,lexicalSearch,selectHistory,sourceEvidence,historyEvidence,sourcePreview} from '../retrieval-local.js';

function fixture(){
  const chat=[
    {is_user:true,mes:'送给她一枚蓝宝石戒指。'},
    {is_user:false,mes:'艾琳收下银质蓝宝石戒指，答应一直戴在左手。',swipe_id:0},
    {is_user:true,mes:'回到旧城堡调查钟楼。'},
    {is_user:false,mes:'主角进入旧城堡，发现北塔的密道入口。',swipe_id:0},
    {is_user:true,mes:'说说我们的约定。'},
    {is_user:false,mes:'艾琳承认戒指的约定已经改变，决定明天归还。',swipe_id:0}
  ];
  let memory=freshMemory();
  for(const i of [1,3,5]){
    memory=commitLeaf(memory,i,messageFingerprint(chat[i]),
      normalizeDelta({summary:i===1?'艾琳收到戒指并做出承诺':i===3?'发现北塔密道': '艾琳决定归还戒指，旧约定被更改',
        items:i===1?[{op:'add',name:'蓝宝石戒指',owner:'艾琳'}]:[]
      }),userFingerprint(chat,i));
  }
  memory.chapters.push({id:'chapter:a',level:1,children:['floor:1','floor:3'],summary:'戒指赠送与城堡调查'});
  memory.chapters.push({id:'chapter:b',level:2,children:['chapter:a','floor:5'],summary:'艾琳的戒指与约定发生变化'});
  const ctx={chat,chatMetadata:{[META_KEY]:memory},getCurrentChatId:()=> 'retrieval-test-chat'};
  return {ctx,memory};
}
test('Chinese keywords find historical names and source records without embeddings',()=>{
  const {ctx,memory}=fixture(),cfg=defaultSettings();
  assert.equal(cfg.retrieval.enabled,true);
  assert.equal(cfg.vector.enabled,false);
  assert.ok(searchTerms('艾琳看着那枚蓝宝石戒指').includes('戒指'));
  const hits=lexicalSearch(ctx,memory,'那枚蓝宝石戒指',10);
  assert.ok(hits.some(x=>x.key==='floor:1'));
  assert.ok(hits.some(x=>x.key==='floor:5'));
  assert.ok(selectHistory(ctx,memory,'蓝宝石戒指',[],3).length>0);
  assert.deepEqual(selectHistory(ctx,memory,'继续',[],5),[]);
});
test('chapter source tracing follows parent links and selects relevant original floors',()=>{
  const {ctx,memory}=fixture();
  const evidence=sourceEvidence(ctx,memory,{key:'chapter:b'},'戒指',3);
  assert.ok(evidence.length);
  assert.ok(evidence.every(x=>x.index===1||x.index===5));
  assert.ok(evidence.some(x=>/戒指/.test(x.text)));
  const original=sourcePreview(ctx,memory,'chapter:a',3);
  assert.ok(original.some(x=>x.index===1));
  assert.ok(original.every(x=>x.text.includes('剧情：')));
  const hits=selectHistory(ctx,memory,'戒指',[],5);
  const traces=historyEvidence(ctx,memory,hits,'戒指',2);
  assert.ok(traces.length<=2);
  assert.equal(new Set(traces.map(x=>x.key)).size,traces.length);
  const cfg=defaultSettings();cfg.summary.keepRecent=0;
  assert.match(injectionText(memory,ctx.chat,cfg,[],traces),/【相关历史】/);
});
test('edited historical messages, stale swipes and deleted originals are never trusted',()=>{
  const {ctx,memory}=fixture();
  assert.ok(lexicalSearch(ctx,memory,'蓝宝石戒指').some(x=>x.key==='floor:1'));
  ctx.chat[1].swipe_id=2;ctx.chat[1].mes='她拒绝戒指';
  assert.ok(!lexicalSearch(ctx,memory,'蓝宝石戒指').some(x=>x.key==='floor:1'));
  assert.deepEqual(sourcePreview(ctx,memory,'floor:1'),[]);
  ctx.chat[1].swipe_id=0;ctx.chat[1].mes='艾琳收下银质蓝宝石戒指，答应一直戴在左手。';
  ctx.chat[0].mes='不再送戒指';
  assert.deepEqual(sourcePreview(ctx,memory,'floor:1'),[]);
  ctx.chat.splice(1,1);
  assert.deepEqual(sourcePreview(ctx,memory,'floor:1'),[]);
});
test('semantic hits and keyword hits combine; cached indexes rebuild on write or chat replacement',()=>{
  const {ctx,memory}=fixture();
  const before=searchIndex(ctx,memory),oldSource=before.source;
  assert.equal(searchIndex(ctx,structuredClone(memory)),before,'canonical chat index is reused');
  const hits=selectHistory(ctx,memory,'戒指',[{key:'floor:3',score:.99}],5);
  assert.ok(hits.some(x=>x.key==='floor:3'),'semantic recall contributes candidates');
  assert.equal(hits.filter(x=>x.key==='floor:1').length,1,'duplicate keyword and embedding hits merge');
  const newer=commitLeaf(memory,5,messageFingerprint(ctx.chat[5]),normalizeDelta({summary:'撤销约定，不再保留戒指'}),userFingerprint(ctx.chat,5));
  ctx.chatMetadata[META_KEY]=newer;
  const after=searchIndex(ctx,newer);
  assert.notEqual(after.source,oldSource);
  assert.ok(lexicalSearch(ctx,newer,'撤销约定',5).some(x=>x.key==='floor:5'));
  ctx.chatMetadata[META_KEY]=freshMemory();
  assert.equal(lexicalSearch(ctx,ctx.chatMetadata[META_KEY],'戒指').length,0);
});
test('locally indexed memory retains only a bounded number of chat scopes',()=>{
  const {ctx,memory}=fixture();
  for(let n=0;n<7;n++){ctx.getCurrentChatId=()=> 'chat-'+n;searchIndex(ctx,memory);}
  ctx.getCurrentChatId=()=> 'retrieval-test-chat';
  assert.ok(searchIndex(ctx,memory).docs.size>=5);
});
