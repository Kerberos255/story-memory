import test from 'node:test';
import assert from 'node:assert/strict';
import {saveSiliconFlowSecret} from '../vector-st.js';
test('embedding key is sent to SillyTavern secret vault, not to extension settings',async()=>{
 const old=globalThis.fetch;
 let endpoint='',method='',postedKey='',postedValue='';
 globalThis.fetch=async (url,options)=>{
   endpoint=url;method=options.method;
   const body=JSON.parse(options.body);
   postedKey=body.key;postedValue=body.value;
   return {ok:true,status:200};
 };
 try{
   const ctx={getRequestHeaders:()=>({'Content-Type':'application/json'}),extensionSettings:{}};
   assert.equal(await saveSiliconFlowSecret(ctx,'synthetic-key-for-test'),true);
   assert.equal(endpoint,'/api/secrets/write');
   assert.equal(method,'POST');
   assert.equal(postedKey,'api_key_siliconflow');
   assert.equal(postedValue,'synthetic-key-for-test');
   assert.deepEqual(ctx.extensionSettings,{});
 }finally{globalThis.fetch=old;}
});
test('empty key is not sent',async()=>{
 await assert.rejects(()=>saveSiliconFlowSecret({getRequestHeaders(){return {}; }},''),/请输入/);
});
