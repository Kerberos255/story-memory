// SillyTavern native vector API adapter. Keys are stored by ST server, never by this plugin.
import {hashText,messageFingerprint} from './core.js';
export function collectionId(ctx){
  const id=[ctx?.groupId||'',ctx?.characterId||'',ctx?.getCurrentChatId?.()||''].join('|');
  if(!ctx?.getCurrentChatId?.())throw Error('请先打开有效聊天');
  return 'story_memory_'+hashText(id)+hashText([...id].reverse().join(''));
}
function stBase(ctx,settings){
  if(!ctx?.getRequestHeaders)throw Error('酒馆尚未就绪');
  return {collectionId:collectionId(ctx),source:'siliconflow',
    siliconflow_endpoint:'cn',model:settings.vector?.model||'Qwen/Qwen3-Embedding-8B'};
}
async function call(ctx,endpoint,data,signal) {
  const resp=await fetch('/api/vector/'+endpoint,{
    method:'POST',headers:ctx.getRequestHeaders(),body:JSON.stringify(data),signal
  });
  if(!resp.ok)throw Error('酒馆向量服务 HTTP '+resp.status+'（请检查酒馆中的 Embedding 密钥与模型）');
  if(endpoint==='insert'||endpoint==='delete')return null;
  const json=await resp.json();
  return json;
}
function eligible(ctx,memory) {
  const items=[];
  for(const [key,leaf] of Object.entries(memory.leaves||{})){
    const index=Number(key),msg=ctx.chat?.[index];
    if(!leaf||!Number.isInteger(index)||messageFingerprint(msg)!==leaf.fingerprint)continue;
    // Stable positive 32-bit hash matches ST vector store's numeric hash format.
    const hash=parseInt(hashText(index+':'+leaf.fingerprint+':'+leaf.summary),16)>>>0;
    items.push({hash,text:leaf.summary,index});
  }
  return items;
}
export async function indexSummaries(ctx,memory,settings,signal){
  if(!settings.vector?.enabled)return 0;
  const config=stBase(ctx,settings),current=eligible(ctx,memory);
  const saved=await call(ctx,'list',config,signal);
  if(!Array.isArray(saved))throw Error('酒馆向量索引返回格式不正确');
  const desired=new Set(current.map(x=>x.hash)),existing=new Set(saved.map(Number));
  const stale=[...existing].filter(x=>!desired.has(x));
  if(stale.length)await call(ctx,'delete',{...config,hashes:stale},signal);
  const missing=current.filter(x=>!existing.has(x.hash));
  let count=0;
  for(let i=0;i<missing.length;i+=6){
    if(signal?.aborted)break;
    const batch=missing.slice(i,i+6);
    await call(ctx,'insert',{...config,items:batch},signal);count+=batch.length;
  }
  return count;
}
export async function recall(ctx,memory,settings,query,signal){
  if(!settings.vector?.enabled||!query?.trim())return [];
  const config=stBase(ctx,settings),valid=eligible(ctx,memory);
  const whitelist=new Set(valid.map(x=>x.hash));
  const response=await call(ctx,'query',{...config,searchText:query.slice(-1800),
    topK:Math.max(1,Math.min(10,Number(settings.vector.topK)||5)),
    threshold:Math.max(0,Math.min(1,Number(settings.vector.threshold)||0.35))},signal);
  if(!response||!Array.isArray(response.metadata))return [];
  return response.metadata
    .filter(x=>whitelist.has(Number(x.hash)))
    .map(x=>({text:String(x.text||'').slice(0,8000),index:Number(x.index)}));
}

/**
 * Save a user-entered embedding key directly into SillyTavern's server-side
 * secret vault. The extension never reads existing secrets or persists the
 * submitted value in its own settings.
 */
export async function saveSiliconFlowSecret(ctx,value){
  if(!ctx?.getRequestHeaders)throw Error('酒馆尚未就绪');
  if(typeof value!=='string'||!value.trim())throw Error('请输入密钥');
  const response=await fetch('/api/secrets/write',{
    method:'POST',
    headers:ctx.getRequestHeaders(),
    body:JSON.stringify({key:'api_key_siliconflow',value:value.trim()})
  });
  if(!response.ok)throw Error('密钥未保存，请检查酒馆权限或接口');
  return true;
}
