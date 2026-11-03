import test from 'node:test';
import assert from 'node:assert/strict';
import {embeddingEndpoint,embed,cosine,candidates,scopeId,rerankEndpoint,rerankCandidates,selectRecallHits} from '../vector-local.js';
import {defaultSettings,freshMemory,commitLeaf,messageFingerprint,normalizeDelta} from '../core.js';

test('embedding endpoint validates URLs without using ST secret vault',()=>{
 assert.equal(embeddingEndpoint('https://example.invalid/v1'),'https://example.invalid/v1/embeddings');
 assert.equal(embeddingEndpoint('https://example.invalid/v1/embeddings'),'https://example.invalid/v1/embeddings');
 assert.throws(()=>embeddingEndpoint('javascript:alert(1)'),/地址无效/);
 assert.throws(()=>embeddingEndpoint('https://id:password@example.invalid/v1'),/地址无效/);
});
test('independent vector embedding uses only provided channel key, not ST credentials',async()=>{
 const old=globalThis.fetch,settings=defaultSettings(),requests=[];
 settings.vector.key='synthetic-vector-key';settings.vector.model='BAAI/bge-m3';
 globalThis.fetch=async (url,options)=>{
   requests.push({url,options});
   return{ok:true,json:async()=>({data:[{index:0,embedding:[1,0,0]},{index:1,embedding:[0,1,0]}]})};
 };
 try{
   const vectors=await embed(settings,['第一个场景','第二个场景']);
   assert.equal(vectors.length,2);
   assert.equal(requests.length,1);
   assert.equal(requests[0].url,'https://api.siliconflow.cn/v1/embeddings');
   assert.equal(requests[0].options.headers.Authorization,'Bearer synthetic-vector-key');
   assert.equal(JSON.parse(requests[0].options.body).model,'BAAI/bge-m3');
   assert.equal(cosine(vectors[0],vectors[1]),0);
 }finally{globalThis.fetch=old;}
});
test('rerank reuses embedding provider credentials but uses dedicated endpoint and model',async()=>{
 const cfg=defaultSettings();cfg.vector.key='synthetic-rerank-key';cfg.vector.rerankEnabled=true;
 assert.equal(cfg.vector.rerankModel,'BAAI/bge-reranker-v2-m3');
 assert.equal(rerankEndpoint(cfg.vector.url),'https://api.siliconflow.cn/v1/rerank');
 assert.equal(rerankEndpoint('https://example.invalid/v1/embeddings'),'https://example.invalid/v1/rerank');
 assert.throws(()=>rerankEndpoint('javascript:evil()'),/地址无效/);
 const old=globalThis.fetch,logs=[];
 globalThis.fetch=async (url,options)=>{
   logs.push({url,options});
   return {ok:true,json:async()=>({results:[{index:0,relevance_score:0.12},{index:1,relevance_score:0.93}]})};
 };
 try{
   const candidates=[{key:'a',text:'古城',score:0.92},{key:'b',text:'重要旧约定',score:0.78},{key:'c',text:'其他事件',score:0.70}];
   const ranked=await rerankCandidates(cfg,'重要旧约定',candidates);
   assert.deepEqual(ranked.map(x=>x.key),['b','a','c']);
   assert.equal(ranked[0].rerankScore,0.93);
   assert.equal(logs[0].url,'https://api.siliconflow.cn/v1/rerank');
   const body=JSON.parse(logs[0].options.body);
   assert.equal(body.model,'BAAI/bge-reranker-v2-m3');
   assert.deepEqual(body.documents,['古城','重要旧约定','其他事件']);
   assert.equal(body.top_n,3);
   assert.ok(logs[0].options.headers.Authorization.startsWith('Bearer '));
 }finally{globalThis.fetch=old;}
});
test('rerank malformed output and upstream errors fail safely for vector fallback',async()=>{
 const cfg=defaultSettings();cfg.vector.key='synthetic-key';cfg.vector.rerankEnabled=true;
 const old=globalThis.fetch,rows=[{key:'a',text:'正文',score:0.9}];
 try{
   globalThis.fetch=async()=>({ok:true,json:async()=>({results:[{index:5,relevance_score:0.9}]})});
   await assert.rejects(rerankCandidates(cfg,'查询',rows),/不合法/);
   globalThis.fetch=async()=>({ok:false,status:404});
   await assert.rejects(rerankCandidates(cfg,'查询',rows),/HTTP 404/);
   cfg.vector.rerankEnabled=false;
   assert.deepEqual(await rerankCandidates(cfg,'查询',rows),rows);
 }finally{globalThis.fetch=old;}
});
test('rerank failure falls back to ranked vector candidates and respects final Top-K',async()=>{
 const cfg=defaultSettings();cfg.vector.key='synthetic-key';cfg.vector.rerankEnabled=true;
 cfg.vector.topK=2;cfg.vector.rerankCandidates=3;
 const rows=[{key:'one',text:'第一项',score:.9},{key:'two',text:'第二项',score:.8},{key:'three',text:'第三项',score:.7}];
 const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return {ok:false,status:503};};
 try{
   assert.deepEqual((await selectRecallHits(cfg,'查询',rows)).map(x=>x.key),['one','two']);
   assert.equal(calls,1);
   cfg.vector.rerankEnabled=false;
   assert.deepEqual((await selectRecallHits(cfg,'查询',rows)).map(x=>x.key),['one','two']);
   assert.equal(calls,1,'disabled rerank must not make network requests');
 }finally{globalThis.fetch=old;}
});
test('vector candidates use valid original and compressed summaries, not stale swipes',()=>{
 const cfg=defaultSettings();
 const ctx={chat:[{is_user:false,mes:'打开宝箱',swipe_id:0}],getCurrentChatId:()=> 'test-chat'};
 let memory=commitLeaf(freshMemory(),0,messageFingerprint(ctx.chat[0]),normalizeDelta({summary:'得到钥匙'}));
 assert.deepEqual(candidates(ctx,memory).map(x=>x.text),['得到钥匙']);
 assert.ok(scopeId(ctx,cfg).endsWith(':'));
 ctx.chat[0].swipe_id=1;
 assert.equal(candidates(ctx,memory).length,0);
});
