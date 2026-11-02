import test from 'node:test';
import assert from 'node:assert/strict';
import {embeddingEndpoint,embed,cosine,candidates,scopeId} from '../vector-local.js';
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
   assert.equal(requests[0].options.headers.Authorization,['Bearer',settings.vector.key].join(' '));
   assert.equal(JSON.parse(requests[0].options.body).model,'BAAI/bge-m3');
   assert.equal(cosine(vectors[0],vectors[1]),0);
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
