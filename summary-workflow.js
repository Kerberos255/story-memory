// Request-sized chunks are internal safeguards, not model limits or user settings.
import {ApiFault,requestChat,buildSummaryMessages,buildChapterMessages,
  parseL0Response,repairL0Messages} from './api.js';
import {floorUserMessages,normalizeDelta,hashText} from './core.js';

const SOURCE_CHUNK=14000,MERGE_INPUT=13000,MAX_PARTS=64;

export function floorSource(chat,index){
  const users=floorUserMessages(chat,index).map(row=>String(row.mes||'')).join('\n\n');
  const ai=String(chat?.[index]?.mes||'');
  return '【本轮用户输入】\n'+users+'\n\n【本轮 AI 剧情】\n'+ai;
}

/** Preserve all source characters in order, preferring paragraph and sentence boundaries. */
export function splitSource(text,maxChars=SOURCE_CHUNK){
  const raw=String(text||''),chunks=[];
  if(!raw.length)return [];
  const limit=Math.max(1000,Math.trunc(maxChars)||SOURCE_CHUNK);
  for(let start=0;start<raw.length;){
    let end=Math.min(raw.length,start+limit);
    if(end<raw.length){
      const slice=raw.slice(start,end);
      let stop=-1;
      for(const mark of ['\n\n','\n','。','！','？','；','.','!','?']){
        const at=slice.lastIndexOf(mark);
        if(at>stop && at>limit*0.58)stop=at+mark.length;
      }
      if(stop>0)end=start+stop;
      // Never split a surrogate pair across requests.
      if(end<raw.length && /[\uD800-\uDBFF]/.test(raw[end-1]))end--;
    }
    if(end<=start)throw new ApiFault('无法分段处理此楼层正文',422,'source_chunk_error');
    chunks.push(raw.slice(start,end));start=end;
    if(chunks.length>MAX_PARTS)throw new ApiFault('本楼层内容过于庞大，请拆成几个楼层再整理',422,'too_many_source_parts');
  }
  return chunks;
}

const MERGE_PROMPT=[
  '你是剧情记忆整理员。将同一楼层按时间顺序提取的连续分段摘要合并为一条连贯的剧情摘要。',
  '每一段都必须核对，保留开头、中间和结尾的关键行动、人物反应、角色关系与知情变化、物品状态、重要承诺、悬念和最终结果。',
  '分清事实、角色传闻、未完成计划及实际结果。不得创造新事件，不把未发生的事写成已发生。',
  '只输出合法 JSON 对象，唯一字段为 summary。尽量简洁，避免重复，不能遗漏最终结局。'
].join('\n');

function packSections(sections,limit=MERGE_INPUT){
  const groups=[],current=[];let count=0;
  for(const section of sections){
    const size=section.length+32;
    if(current.length && (count+size>limit || current.length>=6)){
      groups.push([...current]);current.length=0;count=0;
    }
    current.push(section);count+=size;
  }
  if(current.length)groups.push(current);
  return groups;
}
async function combineNarratives(sections,settings,ctx,signal){
  let current=sections.map(String);
  for(let depth=0;depth<8;depth++){
    if(current.length===1&&current[0].length<=8000)return current[0];
    const groups=packSections(current),next=[];
    for(const group of groups){
      if(signal?.aborted)throw new ApiFault('请求已取消',0,'cancelled');
      const source=group.map((s,i)=>'【连续片段 '+(i+1)+'】\n'+s).join('\n\n');
      const answer=await requestChat(settings.api,[
        {role:'system',content:MERGE_PROMPT},
        {role:'user',content:source}
      ],ctx,signal);
      // Long-floor merges use the same strict single-object parser as L0.
      // Never choose the first of several JSON samples as the real narrative.
      let parsed;
      try{parsed=parseL0Response(answer,settings);}
      catch(err){
        if(!(err instanceof ApiFault)||
          !['invalid_summary_json','invalid_summary_shape'].includes(err.code)||
          answer.length>16000||signal?.aborted)throw err;
        const fixed=await requestChat(settings.api,[
          {role:'system',content:'只修复 JSON 格式，不重新总结或新增事实。输出恰好一个合法 JSON 对象，唯一字段 summary，必须为原有摘要正文。'},
          {role:'user',content:'【待修复的合并摘要输出】\n'+answer}
        ],ctx,signal);
        parsed=parseL0Response(fixed,settings);
      }
      next.push(parsed.summary.trim());
    }
    if(next.length>=current.length && next.join('').length>=current.join('').length)
      throw new ApiFault('模型没有缩短合并摘要，请尝试调整模型输出设置',422,'unmerged_summary');
    current=next;
  }
  throw new ApiFault('长篇摘要未能压缩到适合保存的长度',422,'summary_merge_depth');
}

/** A floor is committed only after every piece and its merge have succeeded. */
export async function summarizeFloor(index,ctx,memory,settings,signal,options={}){
  const source=floorSource(ctx.chat,index);
  // The checkpoint contains only completed normalized parts and source offsets.
  // Both source and prompt/config changes invalidate it; partial data is never a leaf.
  const signature=hashText(source)+':'+source.length+':'+hashText(JSON.stringify({
    api:settings.api,prompts:settings.prompts,extraction:settings.extraction,
    revision:memory.revision
  }));
  let chunks=splitSource(source),results=[];
  const saved=options.resume;
  if(saved?.version===1&&saved.signature===signature&&Array.isArray(saved.lengths)&&
    saved.lengths.length>1&&saved.lengths.length<=MAX_PARTS&&
    saved.lengths.every(n=>Number.isInteger(n)&&n>0)&&
    saved.lengths.reduce((n,x)=>n+x,0)===source.length&&
    Array.isArray(saved.results)&&saved.results.length<=saved.lengths.length&&
    saved.results.every(x=>x&&typeof x.summary==='string'&&x.delta&&
      ['items','scenes','characters','plans'].every(k=>Array.isArray(x.delta[k])))){
    let offset=0;
    chunks=saved.lengths.map(len=>{const part=source.slice(offset,offset+len);offset+=len;return part;});
    results=structuredClone(saved.results);
  }
  const checkpoint=async()=>{
    if(typeof options.onCheckpoint!=='function'||chunks.length<2||chunks.length>16)return;
    const value={version:1,signature,lengths:chunks.map(x=>x.length),
      results:structuredClone(results),updatedAt:Date.now()};
    // Bound chat metadata growth; oversized tasks still work without checkpoints.
    if(JSON.stringify(value).length<=120000)await options.onCheckpoint(value);
  };
  for(let i=results.length;i<chunks.length;i++){
    if(signal?.aborted)throw new ApiFault('请求已取消',0,'cancelled');
    const bridge=i?'【上一段末尾（仅供衔接，不要重复提取）】\n'+chunks[i-1].slice(-180)+'\n':'';
    const previous=results.length?'【已提取前段摘要（仅供衔接）】\n'+results.at(-1).summary.slice(-900)+'\n':'';
    const part=chunks.length===1?chunks[i]:
      '【本楼层原文 '+(i+1)+'/'+chunks.length+'，按顺序处理此段】\n'+bridge+previous+chunks[i];
    try{
      const messages=buildSummaryMessages(index,ctx.chat,memory,settings,part);
      const raw=await requestChat(settings.api,messages,ctx,signal);
      let parsed;
      try{parsed=parseL0Response(raw,settings);}
      catch(err){
        // One targeted format-only retry. Never repair ambiguous multi-object output,
        // excessively large responses, upstream errors, or a cancelled request.
        if(!(err instanceof ApiFault)||
          !['invalid_summary_json','invalid_summary_shape'].includes(err.code)||
          raw.length>16000||signal?.aborted)throw err;
        const repaired=await requestChat(settings.api,repairL0Messages(raw,settings),ctx,signal);
        parsed=parseL0Response(repaired,settings);
      }
      results.push(normalizeDelta(parsed,source,settings.extraction));
      await checkpoint();
    }catch(err){
      // Only retry when the upstream clearly reports a context/payload-length issue.
      const sizeError=err instanceof ApiFault&&['request_too_large','context_length_exceeded'].includes(err.code);
      if(sizeError&&chunks[i].length>2000&&chunks.length<MAX_PARTS){
        const smaller=splitSource(chunks[i],Math.floor(chunks[i].length/2));
        if(smaller.length>1&&chunks.length-1+smaller.length<=MAX_PARTS){
          chunks.splice(i,1,...smaller);i--;continue;
        }
      }
      throw err;
    }
  }
  if(!results.length)throw new ApiFault('楼层正文为空',422,'empty_source');
  if(results.length===1 && results[0].summary.length<=8000)
    return {...results[0],sourceParts:null};
  const summary=await combineNarratives(results.map(item=>item.summary),settings,ctx,signal);
  const delta={items:[],scenes:[],characters:[],plans:[]};
  for(const result of results)for(const kind of Object.keys(delta))delta[kind].push(...result.delta[kind]);
  const lastNonempty=name=>results.map(result=>result[name]).filter(Boolean).at(-1)||'';
  return {summary,time:lastNonempty('time'),location:lastNonempty('location'),delta,
    sourceParts:results.map(result=>result.summary)};
}

/** Multi-pass chapters avoid a fixed input-length failure. No partial chapter is saved. */
export async function summarizeChapter(rows,settings,kind,ctx,signal){
  let stage=rows.map(row=>({...row,summary:String(row.summary||'')}));
  for(let depth=0;depth<8;depth++){
    if(signal?.aborted)throw new ApiFault('请求已取消',0,'cancelled');
    const total=stage.reduce((n,r)=>n+String(r.summary||'').length+60,0);
    if(total<=20000){
      const answer=String(await requestChat(settings.api,buildChapterMessages(stage,settings,kind),ctx,signal)).trim();
      if(answer.length<=12000)return answer;
      // A large model response is another source to compress, never a value to truncate.
      if(depth>0&&stage.length===1&&answer.length>=String(stage[0].summary||'').length)
        throw new ApiFault('分层总结没有缩短内容，请调整模型输出',422,'chapter_no_progress');
      stage=[{summary:answer}];
      continue;
    }
    const groups=packSections(stage.map(row=>(row.time?'('+row.time+') ':'')+String(row.summary||'')),12000),next=[];
    for(const entries of groups){
      // Oversized individual old summaries can be split without discarding characters.
      const pieces=entries.flatMap(value=>splitSource(value,9000));
      for(const group of packSections(pieces,12000)){
        const batch=group.map(summary=>({summary}));
        const result=await requestChat(settings.api,buildChapterMessages(batch,settings,kind),ctx,signal);
        next.push({summary:String(result||'')});
      }
    }
    if(next.length>=stage.length && next.reduce((n,r)=>n+r.summary.length,0)>=stage.reduce((n,r)=>n+r.summary.length,0))
      throw new ApiFault('章节总结没有缩短内容，请检查摘要模型',422,'chapter_no_progress');
    stage=next;
  }
  throw new ApiFault('章节内容仍然过长，请检查模型输出',422,'chapter_merge_depth');
}
