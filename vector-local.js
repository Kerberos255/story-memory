// Standalone browser-side embeddings, completely independent from SillyTavern's secret vault.
// Cache is rebuildable; canonical summaries always remain in chat metadata.
import {hashText,leafValid,validChapters} from './core.js';
const DB='story-memory-embeddings-v1',TABLE='entries';
let opening;
function db(){
  if(typeof indexedDB==='undefined')throw Error('当前浏览器不支持向量索引存储');
  if(!opening)opening=new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB,1);
    req.onupgradeneeded=()=>{
      if(!req.result.objectStoreNames.contains(TABLE))req.result.createObjectStore(TABLE,{keyPath:'id'});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(Error('向量索引无法打开'));
  }).catch(e=>{opening=null;throw e;});
  return opening;
}
async function rows(prefix){
  const database=await db();
  return new Promise((resolve,reject)=>{
    const store=database.transaction(TABLE,'readonly').objectStore(TABLE);
    const range=typeof IDBKeyRange!=='undefined'?IDBKeyRange.bound(prefix,prefix+'\uffff'):undefined;
    const req=store.getAll(range);
    req.onsuccess=()=>resolve(req.result.filter(x=>x.id.startsWith(prefix)));
    req.onerror=()=>reject(Error('向量索引读取失败'));
  });
}
async function write(additions=[],removals=[]){
  if(!additions.length&&!removals.length)return;
  const database=await db();
  return new Promise((resolve,reject)=>{
    const tx=database.transaction(TABLE,'readwrite'),store=tx.objectStore(TABLE);
    for(const id of removals)store.delete(id);
    for(const item of additions)store.put(item);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(Error('向量索引保存失败'));
  });
}
export function embeddingEndpoint(url){
  let u;
  try{u=new URL(String(url||'').trim());}catch{throw Error('请填写有效的 Embedding API 地址');}
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('Embedding API 地址无效');
  const base=u.href.replace(/\/+$/,'').replace(/\/(?:embeddings|rerank|chat\/completions)$/i,'');
  return base+'/embeddings';
}
export async function embed(settings,texts,signal){
  if(!texts?.length)return [];
  const cfg=settings.vector||{};
  if(!cfg.key?.trim()||!cfg.model?.trim())throw Error('请配置独立向量 API Key 和模型');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  const cancel=()=>controller.abort();
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    const response=await fetch(embeddingEndpoint(cfg.url),{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.key.trim()},
      body:JSON.stringify({model:cfg.model,input:texts}),signal:controller.signal
    });
    if(!response.ok)throw Error('Embedding 请求失败（HTTP '+response.status+'）');
    const result=await response.json();
    if(!Array.isArray(result?.data))throw Error('Embedding 返回格式错误');
    const sorted=[...result.data].sort((a,b)=>a.index-b.index);
    if(sorted.length!==texts.length)throw Error('Embedding 返回数量不一致');
    return sorted.map(x=>{
      const v=x.embedding;
      if(!Array.isArray(v)||!v.length||v.length>8192||!v.every(Number.isFinite))throw Error('Embedding 向量不合法');
      return v;
    });
  }catch(e){
    if(controller.signal.aborted&&!signal?.aborted)throw Error('Embedding 请求超时');
    if(e instanceof TypeError)throw Error('Embedding 连接失败，请检查跨域 CORS 和地址');
    throw e;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
function normalized(v){
  const length=Math.hypot(...v);
  return v.map(n=>length?n/length:0);
}
export function cosine(a,b){
  if(a.length!==b.length)return -1;
  let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]*b[i];return sum;
}
/** Standard /v1/rerank endpoint, sharing the independent embedding provider credentials. */
export function rerankEndpoint(url){
  return embeddingEndpoint(url).replace(/\/embeddings$/,'/rerank');
}
export async function rerankCandidates(settings,query,ranked,signal){
  if(!ranked?.length||!settings.vector?.rerankEnabled)return ranked||[];
  const cfg=settings.vector;
  if(!cfg.key?.trim()||!cfg.rerankModel?.trim())throw Error('请配置重排模型和向量 API Key');
  if(signal?.aborted)throw Error('重排已取消');
  const controller=new AbortController(),cancel=()=>controller.abort();
  const timer=setTimeout(()=>controller.abort(),12000);
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    const response=await fetch(rerankEndpoint(cfg.url),{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.key.trim()},
      body:JSON.stringify({model:cfg.rerankModel.trim(),query:String(query).slice(-1800),
        documents:ranked.map(x=>String(x.text||'').slice(0,2400)),
        top_n:ranked.length,return_documents:false}),signal:controller.signal
    });
    if(!response.ok)throw Error('重排请求失败（HTTP '+response.status+'）');
    const data=await response.json();
    if(!Array.isArray(data?.results)||!data.results.length)throw Error('重排结果无效');
    const seen=new Set(),sorted=[];
    for(const hit of data.results){
      const i=hit?.index,score=hit?.relevance_score;
      if(!Number.isInteger(i)||i<0||i>=ranked.length||seen.has(i)||!Number.isFinite(score))
        throw Error('重排结果索引或分数不合法');
      seen.add(i);sorted.push({...ranked[i],rerankScore:score});
    }
    // Some providers return partial rankings. Retain all missing candidates in vector order.
    return [...sorted.sort((a,b)=>b.rerankScore-a.rerankScore),...ranked.filter((_,i)=>!seen.has(i))];
  }finally{
    clearTimeout(timer);signal?.removeEventListener('abort',cancel);
  }
}
export function scopeId(ctx,settings){
  const chat=ctx?.getCurrentChatId?.();
  if(!chat)throw Error('请先打开聊天');
  const scope=[ctx.groupId||'',ctx.characterId||'',chat,settings.vector?.url||'',settings.vector?.model||''].join('|');
  return hashText(scope)+hashText([...scope].reverse().join(''))+':';
}
export function candidates(ctx,memory){
  const result=[];
  for(const [key,leaf] of Object.entries(memory.leaves||{})){
    const i=Number(key);
    if(!leafValid(memory,ctx.chat,i))continue;
    result.push({key:'floor:'+i,text:leaf.summary});
  }
  for(const chapter of validChapters(memory,ctx.chat||[])){
    result.push({key:chapter.id,text:chapter.summary});
  }
  return result.filter(x=>x.text?.trim());
}
export async function indexSummaries(ctx,memory,settings,signal){
  if(!settings.vector?.enabled)return 0;
  const prefix=scopeId(ctx,settings),records=candidates(ctx,memory);
  const stored=await rows(prefix),lookup=new Map(stored.map(x=>[x.id,x]));
  const desired=new Set(records.map(x=>prefix+x.key));
  // A new model uses a different namespace; stale old-model cache remains inert.
  const stale=stored.filter(x=>!desired.has(x.id)).map(x=>x.id);
  const changed=records.filter(row=>{
    const cached=lookup.get(prefix+row.key);
    return !cached||cached.hash!==hashText(row.text);
  });
  let count=0;
  for(let i=0;i<changed.length;i+=6){
    if(signal?.aborted)break;
    const batch=changed.slice(i,i+6),vectors=await embed(settings,batch.map(x=>x.text),signal);
    if(prefix!==scopeId(ctx,settings))return count;
    await write(batch.map((item,j)=>({
      id:prefix+item.key,hash:hashText(item.text),key:item.key,text:item.text,vector:normalized(vectors[j])
    })));
    count+=batch.length;
  }
  if(prefix===scopeId(ctx,settings))await write([],stale);
  return count;
}
/** Cheap preselection and fail-open rerank, independently testable without IndexedDB. */
export async function selectRecallHits(settings,query,ranked,signal){
  const limit=Math.max(1,Math.min(10,Number(settings.vector?.topK)||5));
  if(!settings.vector?.rerankEnabled||ranked.length<2)return ranked.slice(0,limit);
  const pool=Math.max(limit,Math.min(30,Number(settings.vector.rerankCandidates)||15));
  try{return (await rerankCandidates(settings,query,ranked.slice(0,pool),signal)).slice(0,limit);}
  catch{return ranked.slice(0,limit);} // Never lose vector candidates if rerank is unavailable.
}
export async function recall(ctx,memory,settings,query,signal){
  if(!settings.vector?.enabled||!query?.trim())return [];
  const prefix=scopeId(ctx,settings),current=new Map(candidates(ctx,memory).map(x=>[x.key,x.text]));
  const [q]=await embed(settings,[query.slice(-1800)],signal),target=normalized(q);
  const cached=await rows(prefix);
  const threshold=Math.max(-1,Math.min(1,Number(settings.vector.threshold)||0.35));
  const ranked=cached.filter(row=>current.get(row.key)===row.text)
    .map(row=>({text:row.text,score:cosine(target,row.vector),key:row.key}))
    .filter(row=>row.score>=threshold).sort((a,b)=>b.score-a.score);
  return selectRecallHits(settings,query,ranked,signal);
}
