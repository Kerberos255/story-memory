// Local search index and source tracing. Kept in memory and rebuilt from chat metadata.
import {META_KEY,leafValid,validChapters,floorUserMessages} from './core.js';

const snapshots=new Map(),MAX_SCOPES=2;
const STOP=new Set(['继续','然后','接着','好的','好吧','嗯','哦','啊','再说','开始','下一步','现在','怎么','什么','那个','这个','这里','那里','就是','还是','我们','你们','他们','她们','一个','一下','已经','可以','没有','是否','时候','如果','因为','所以','知道','觉得','一点']);
const ngram=(text)=>{
  const result=new Set(),chunks=String(text||'').normalize('NFKC').toLowerCase()
    .match(/[\p{Script=Han}]{2,}|[a-z0-9_]{2,}/gu)||[];
  for(const chunk of chunks.slice(0,1000)){
    if(STOP.has(chunk))continue;
    if(!/[\p{Script=Han}]/u.test(chunk)){result.add(chunk);continue;}
    if(chunk.length<=4)result.add(chunk);
    for(let i=0;i<chunk.length-1;i++){
      const word=chunk.slice(i,i+2);
      if(!STOP.has(word))result.add(word);
    }
  }
  return [...result].slice(0,250);
};
export const searchTerms=text=>ngram(String(text||'').slice(-1100));
function scope(ctx){
  const id=ctx?.getCurrentChatId?.();
  return id?[ctx.groupId||'',ctx.characterId||'',id].join('|'):'';
}
function content(row,kind){
  if(kind==='chapter')return String(row.summary||'');
  const details=[];
  for(const values of Object.values(row.delta||{})){
    if(!Array.isArray(values))continue;
    for(const item of values.slice(0,35)){
      if(item?.name)details.push([item.name,item.description,item.owner,item.location,item.status,
        ...(Array.isArray(item.knowledge)?item.knowledge.map(k=>k?.fact):[])].filter(Boolean).join(' '));
    }
  }
  return [String(row.summary||''),...details].join(' ').slice(0,4500);
}
function allDocs(memory){
  const next=new Map();
  for(const [id,leaf] of Object.entries(memory.leaves||{})){
    if(!leaf?.summary)continue;
    const i=Number(id);if(!Number.isInteger(i)||i<0)continue;
    const key='floor:'+i;
    next.set(key,{key,summary:leaf.summary,searchText:content(leaf,'floor'),kind:'floor',sourceIndex:i});
  }
  for(const c of memory.chapters||[]){
    if(!c?.id||!c.summary)continue;
    next.set(c.id,{key:c.id,summary:c.summary,searchText:content(c,'chapter'),kind:'chapter'});
  }
  return next;
}
function reconcile(previous,memory){
  const index=previous||{docs:new Map(),postings:new Map(),revision:-1,source:null};
  if(index.source===memory)return index;
  const fresh=allDocs(memory);
  for(const [key,row] of index.docs){
    const next=fresh.get(key);
    if(next&&next.searchText===row.searchText&&next.summary===row.summary)continue;
    for(const term of row.terms){
      const posting=index.postings.get(term);posting?.delete(key);
      if(!posting?.size)index.postings.delete(term);
    }
    index.docs.delete(key);
  }
  for(const [key,row] of fresh){
    if(index.docs.has(key))continue;
    const terms=ngram(row.searchText);
    index.docs.set(key,{...row,terms});
    for(const term of terms){
      if(!index.postings.has(term))index.postings.set(term,new Set());
      index.postings.get(term).add(key);
    }
  }
  index.revision=memory.revision;index.source=memory;
  return index;
}
export function searchIndex(ctx,memory){
  const key=scope(ctx),source=ctx?.chatMetadata?.[META_KEY]||memory;
  if(!key)return reconcile(null,source);
  const existing=snapshots.get(key);
  const updated=reconcile(existing,source);
  snapshots.delete(key);snapshots.set(key,updated);
  while(snapshots.size>MAX_SCOPES)snapshots.delete(snapshots.keys().next().value);
  return updated;
}
function validKey(key,memory,chat,chapters){
  if(key.startsWith('floor:')){
    const n=Number(key.slice(6));
    return Number.isInteger(n)&&leafValid(memory,chat,n);
  }
  return chapters.has(key);
}
function rankWords(index,terms){
  const scores=new Map(),count=index.docs.size;
  for(const term of terms){
    const set=index.postings.get(term);if(!set)continue;
    const idf=Math.log(1+(count+1)/(set.size+1));
    for(const id of set)scores.set(id,(scores.get(id)||0)+idf);
  }
  return scores;
}
export function lexicalSearch(ctx,memory,query,limit=18){
  const terms=searchTerms(query);
  if(!terms.length)return [];
  const idx=searchIndex(ctx,memory),chat=ctx?.chat||[];
  const chapters=new Set(validChapters(memory,chat).map(x=>x.id));
  const scored=rankWords(idx,terms);
  return [...scored].sort((a,b)=>b[1]-a[1])
    .filter(([key])=>validKey(key,memory,chat,chapters))
    .slice(0,Math.max(1,Math.min(40,limit)))
    .map(([key,score])=>({...idx.docs.get(key),score}));
}
/** Combine lexical and semantic candidates without a second model request. */
export function selectHistory(ctx,memory,query,semantic=[],limit=5){
  const terms=searchTerms(query);
  if(!terms.length)return [];
  const idx=searchIndex(ctx,memory),lex=lexicalSearch(ctx,memory,query,30);
  const valid=new Set(validChapters(memory,ctx.chat||[]).map(x=>x.id));
  const merged=new Map();
  const include=(key,rank,source)=>{
    const row=idx.docs.get(key);
    if(!row||!validKey(key,memory,ctx.chat||[],valid))return;
    const prev=merged.get(key)||{...row,rank:0,from:[]};
    prev.rank+=1/(12+rank)*(source==='keyword'?1.2:1);
    prev.from.push(source);merged.set(key,prev);
  };
  lex.forEach((r,i)=>include(r.key,i,'keyword'));
  semantic.forEach((r,i)=>include(r.key,i,'semantic'));
  return [...merged.values()].sort((a,b)=>b.rank-a.rank)
    .slice(0,Math.max(1,Math.min(10,Number(limit)||5)));
}
function childFloor(key,memory,idx,terms,limit=3){
  const chapters=new Map((memory.chapters||[]).map(c=>[c.id,c]));
  const picked=[],seen=new Set(),queue=[key];
  let visited=0;
  while(queue.length&&visited++<220&&picked.length<48){
    const id=queue.shift();
    if(seen.has(id))continue;seen.add(id);
    if(id.startsWith('floor:')){
      const i=Number(id.slice(6));
      if(Number.isInteger(i))picked.push(i);
      continue;
    }
    const chapter=chapters.get(id);
    if(!chapter)continue;
    const children=[...(chapter.children||[])].sort((a,b)=>{
      const A=idx.docs.get(a),B=idx.docs.get(b);
      const score=x=>x?terms.reduce((n,t)=>n+(x.searchText.toLowerCase().includes(t)?1:0),0):0;
      return score(B)-score(A);
    });
    queue.unshift(...children);
  }
  return picked.slice(0,Math.max(3,limit*7));
}
function excerpt(text,terms,maxChars){
  const source=String(text||'').trim();
  if(!source)return '';
  const lower=source.toLowerCase();
  const found=terms.map(term=>lower.indexOf(term)).filter(i=>i>=0);
  if(!found.length)return '';
  const point=Math.min(...found),start=Math.max(0,point-100),end=Math.min(source.length,start+maxChars);
  return (start?'…':'')+source.slice(start,end)+(end<source.length?'…':'');
}
/** Lookup a small number of original messages, requiring a verified source and relevant wording. */
export function sourceEvidence(ctx,memory,hit,query,maxFloors=3){
  const terms=searchTerms(query);
  if(!terms.length)return [];
  const idx=searchIndex(ctx,memory),chat=ctx.chat||[];
  const chapters=new Set(validChapters(memory,chat).map(x=>x.id));
  if(!validKey(hit.key,memory,chat,chapters))return [];
  const sources=childFloor(hit.key,memory,idx,terms,maxFloors);
  const matches=[];
  for(const i of sources){
    if(!leafValid(memory,chat,i))continue;
    const msg=chat[i];
    if(!msg||typeof msg.mes!=='string')continue;
    const user=floorUserMessages(chat,i).map(m=>String(m.mes||'')).join('\n');
    const full=(user?'用户：'+user+'\n':'')+'剧情：'+msg.mes;
    const amount=terms.reduce((score,t)=>score+(full.toLowerCase().includes(t)?1:0),0);
    if(!amount)continue;
    const text=excerpt(full,terms,480);
    if(text)matches.push({index:i,text,score:amount});
  }
  return matches.sort((a,b)=>b.score-a.score||b.index-a.index)
    .slice(0,Math.max(1,Math.min(5,maxFloors)));
}
export function historyEvidence(ctx,memory,hits,query,maxSources=3){
  const output=[],used=new Set();
  for(const hit of hits){
    if(output.length>=maxSources)break;
    const candidates=sourceEvidence(ctx,memory,hit,query,maxSources);
    for(const source of candidates){
      if(output.length>=maxSources)break;
      if(used.has(source.index))continue;
      used.add(source.index);
      output.push({key:'source:'+source.index,text:'[原文 #'+source.index+'] '+source.text});
    }
  }
  return output;
}
/** The manual source viewer preserves complete text and pages through all descendants. */
export function sourcePreview(ctx,memory,key,limit=5,offset=0){
  const chat=ctx?.chat||[];
  const chapters=new Set(validChapters(memory,chat).map(x=>x.id));
  if(!validKey(key,memory,chat,chapters))return [];
  const chapterById=new Map((memory.chapters||[]).map(c=>[c.id,c]));
  const pageSize=Math.max(1,Math.min(20,Math.trunc(Number(limit)||5)));
  const skip=Math.max(0,Math.trunc(Number(offset)||0));
  const visited=new Set(),stack=[key],rows=[];
  let matched=0;
  while(stack.length&&rows.length<pageSize){
    const id=stack.pop();
    if(visited.has(id))continue;
    visited.add(id);
    if(id.startsWith('floor:')){
      const index=Number(id.slice(6));
      if(!Number.isInteger(index)||!leafValid(memory,chat,index))continue;
      if(matched++<skip)continue;
      rows.push({index,
        text:[...floorUserMessages(chat,index).map(m=>'用户：'+String(m.mes||'')),
          '剧情：'+String(chat[index]?.mes||'')].join('\n')
      });
      continue;
    }
    const chapter=chapterById.get(id);
    if(!chapter)continue;
    // Traverse source chapters in their original chronological order.
    for(let i=chapter.children.length-1;i>=0;i--)stack.push(chapter.children[i]);
  }
  return rows;
}
