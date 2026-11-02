// Minimal ST-proxied OpenAI compatible client. Never log headers, keys, or story text.
import {floorUserMessages,leafValid} from './core.js';
const HOP=new Set(['host','connection','cookie','set-cookie','content-length','transfer-encoding','proxy-authorization','proxy-authenticate','origin','referer','authorization','x-api-key','api-key','x-auth-token','x-goog-api-key']);
export class ApiFault extends Error {
  constructor(message,status=0,code='api_error'){super(message);this.name='ApiFault';this.status=status;this.code=code;}
}
export function normalizeHeaders(headers) {
  const out={};
  if(!headers||typeof headers!=='object'||Array.isArray(headers))return out;
  for(const [name,value] of Object.entries(headers)){
    if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(name)||HOP.has(name.toLowerCase()))continue;
    if(typeof value!=='string'||/[\r\n]/.test(value)||value.length>2048||/^Bearer\s/i.test(value))continue;
    out[name]=value;
  }
  return out;
}
export function normalizeChannelUrl(value) {
  let url;try{url=new URL(String(value||'').trim());}catch{throw new ApiFault('副 API 地址无效');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new ApiFault('副 API 地址无效');
  return url.href.replace(/\/+$/,'');
}
export function parseExtraBody(value) {
  if(!value||!String(value).trim())return {};
  const s=String(value).trim();
  if(s.startsWith('{')) {
    const parsed=JSON.parse(s);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new ApiFault('附加主体参数需要 JSON 对象');
    return parsed;
  }
  const parsed={};
  for(const raw of s.split(/\r?\n/)){
    const line=raw.trim();if(!line||line.startsWith('#'))continue;
    const m=line.match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
    if(!m)throw new ApiFault('参数格式应为 名称: 值');
    const key=m[1],val=m[2].trim();
    if(['__proto__','prototype','constructor'].includes(key))throw new ApiFault('参数名不允许：'+key);
    try{parsed[key]=JSON.parse(val);}catch{parsed[key]=val.replace(/^["']|["']$/g,'');}
  }
  return parsed;
}
export function parseExcluded(value) {
  return String(value||'').split(/[\r\n,]+/).map(x=>x.trim().replace(/^-\s*/,'' )).filter(Boolean);
}
export function parseHeaderLines(value) {
  if(!String(value||'').trim())return {};
  const result={};
  for(const line of String(value).split(/\r?\n/)){
    if(!line.trim())continue;
    const m=line.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,99})\s*:\s*(.*)$/);
    if(!m)throw new ApiFault('标头格式应为 名称: 内容');
    if(Object.keys(result).some(k=>k.toLowerCase()===m[1].toLowerCase()))throw new ApiFault('标头重复：'+m[1]);
    const accepted=normalizeHeaders({[m[1]]:m[2]});
    if(!Object.keys(accepted).length)throw new ApiFault('不允许此标头：'+m[1]);
    result[m[1]]=m[2];
  }
  return result;
}
export function makeBody(channel,messages) {
  const url=normalizeChannelUrl(channel.url);
  if(!channel.model?.trim())throw new ApiFault('请设置副 API 模型');
  // A standalone channel must never fall back to the host's active Custom key.
  if(!channel.key?.trim())throw new ApiFault('请先配置摘要 API 密钥');
  const headers={...normalizeHeaders(channel.headers),Authorization:'Bearer '+channel.key.trim()};
  const include=channel.include&&typeof channel.include==='object'&&!Array.isArray(channel.include)?structuredClone(channel.include):{};
  const body={
    chat_completion_source:'custom',custom_url:url,
    custom_include_headers:JSON.stringify(headers),custom_include_body:JSON.stringify(include),
    custom_exclude_body:(Array.isArray(channel.exclude)?channel.exclude:[])
      .filter(name=>typeof name==='string'&&/^[a-zA-Z_][\w.-]{0,99}$/.test(name))
      .map(name=>'- '+name).join('\n'),
    model:channel.model.trim(),messages,stream:false,tool_choice:'none',
    temperature:Number.isFinite(Number(channel.temperature))?Number(channel.temperature):0,
    max_tokens:Math.max(256,Math.min(65536,Math.trunc(Number(channel.maxTokens)??8192)||8192))
  };
  // ST applies custom_exclude_body against the final upstream request; do not remove
  // local body fields, which would bypass ST's actual parameter exclusion logic.
  return body;
}
function pullText(data) {
  const value=data?.choices?.[0]?.message?.content??data?.choices?.[0]?.text??data?.content;
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.map(x=>typeof x?.text==='string'?x.text:'').join('');
  return '';
}
export async function requestChat(channel,messages,ctx,externalSignal) {
  if(channel?.mode==='main'){
    if(externalSignal?.aborted)throw new ApiFault('请求已取消',0,'cancelled');
    if(typeof ctx?.generateRaw!=='function')throw new ApiFault('当前酒馆不支持跟随主 API');
    try{
      const text=await ctx.generateRaw({prompt:messages,responseLength:Math.max(256,Math.min(65536,Number(channel.maxTokens)||8192))});
      if(externalSignal?.aborted)throw new ApiFault('请求已取消',0,'cancelled');
      if(typeof text!=='string'||!text.trim())throw new ApiFault('主 API 返回空内容',502,'empty_response');
      return text.trim();
    }catch(err){
      if(err instanceof ApiFault)throw err;
      throw new ApiFault('主 API 生成失败，请检查当前连接和提示词',422,'main_api_error');
    }
  }
  const body=makeBody(channel,messages);
  if(!ctx?.getRequestHeaders)throw new ApiFault('SillyTavern 上下文未就绪');
  const controller=new AbortController();
  const timeout=Math.max(10,Math.min(300,Number(channel.timeout)||90))*1000;
  const t=setTimeout(()=>controller.abort(),timeout);
  const onAbort=()=>controller.abort();externalSignal?.addEventListener('abort',onAbort,{once:true});
  try{
    const response=await fetch('/api/backends/chat-completions/generate',{
      method:'POST',headers:ctx.getRequestHeaders(),body:JSON.stringify(body),signal:controller.signal
    });
    if(!response.ok)throw new ApiFault('副 API 返回 HTTP '+response.status,response.status,'upstream_http_'+response.status);
    const json=await response.json().catch(()=>{throw new ApiFault('副 API 返回无效 JSON',502,'invalid_api_response');});
    // Some ST proxy paths wrap upstream 4xx in a 200 JSON error. Never retry unknown policy errors.
    if(json?.error)throw new ApiFault('副 API 返回错误',422,'upstream_rejected');
    const content=pullText(json).trim();
    if(!content)throw new ApiFault('副 API 返回空内容',502,'empty_response');
    return content;
  }catch(err){
    if(externalSignal?.aborted)throw new ApiFault('请求已取消',0,'cancelled');
    if(controller.signal.aborted)throw new ApiFault('副 API 请求超时',504,'timeout');
    if(err instanceof ApiFault)throw err;
    throw new ApiFault('副 API 网络传输失败',502,'network_error');
  }finally{clearTimeout(t);externalSignal?.removeEventListener('abort',onAbort);}
}
export function extractJSONObject(response) {
  const text=String(response||'').trim().replace(/<thinking>[\s\S]*?<\/thinking>/gi,'');
  try{return JSON.parse(text);}catch{}
  let first=-1,depth=0,quoted=false,escape=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(first<0){if(ch==='{'){first=i;depth=1;}continue;}
    if(quoted){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')quoted=false;}
    else if(ch==='"')quoted=true;
    else if(ch==='{')depth++;
    else if(ch==='}'&&--depth===0){try{return JSON.parse(text.slice(first,i+1));}catch{break;}}
  }
  throw new ApiFault('摘要未返回可解析 JSON',422,'invalid_summary_json');
}
export const DEFAULT_SUMMARY_PROMPT=[
  '【角色】你负责维护互动小说的事实记忆。只对本次提供的用户发言和 AI 剧情进行摘要，不扮演人物、不续写、不评价剧情。',
  '【来源边界】区分「本轮新剧情」和「以前的摘要」。已有摘要只用于去重与理解因果，不得当作本轮新事件重复登记。',
  '【剧情摘要】按事件发生顺序描述关键行动、对话意图、冲突、决定、结果与转折。明确谁做了什么、如何影响谁，以及仍然悬而未决的问题。',
  '【真实性】以原文为准，区分已发生事实、人物主观认知、传闻与推测。模糊的时间、地点、姓名不要自行补全。',
  '【时间 time】只记录原文明确提供的剧情时间；完整日期与时刻统一 YYYY/MM/DD HH:mm，范围统一 YYYY/MM/DD HH:mm–HH:mm。不要添加星期、地点、装饰符号。只有时刻则用 HH:mm 或 HH:mm–HH:mm，时间不明确则留空。地点单独填写 location。',
  '【物品 items】只记录本轮确实发生的取得、交付、消耗、遗失或状态变化；写明归属 owner、存放地点 location、证据确凿的数量 quantity。已有物品没有变化就不更新。',
  '【场景 scenes】只记录重要的新地点、环境变化和地点间关系；角色的短暂位移可以写进剧情摘要，必要时在 characters.location 更新。',
  '【人物 characters】只记录人物的可核实身份、状态、所在位置、关系变化及其知情范围。不要根据一句情绪化对白擅自量化好感度。',
  '【计划 plans】保留承诺、约定、正在执行的计划、已结束的任务与长期伏笔；status 表示当前进度，kind 为 plan 或 suspense。',
  '【变更操作】op=add 表示新出现，update 表示原记录被改变，remove 仅在原文明确删除、失去或终止时使用。不得重复结算同一事件。',
  '【内容处理】忽略对话外的控制标签、思考过程和格式噪声。只概括符合服务规则、对剧情连续性必要的非露骨事实。',
  '【输出】严格输出一个合法 JSON 对象，不包含 Markdown 围栏、解释、思考标签或任何工具调用。必填 summary。',
  'JSON 字段示例（不是必须填满所有字段）：',
  '{"summary":"按时间顺序整理本轮剧情","time":"有依据时填写故事时间","location":"有依据时填写当前地点",',
  '"items":[{"op":"add","name":"物品名称","quantity":1,"owner":"持有者","location":"存放地点","description":"物品变化"}],',
  '"scenes":[{"op":"update","name":"地点名称","location":"上级地点","description":"环境或结构变化"}],',
  '"characters":[{"op":"update","name":"人物名称","location":"当前位置","relationship":"关系变化","status":"当前状态","description":"人物背景与认知变化"}],',
  '"plans":[{"op":"add","name":"约定或悬念","kind":"plan","status":"未完成","description":"来源与进度"}]}',
  '没有变化的 items、scenes、characters、plans 可以省略或输出空数组。数量与状态不能凭空推断。'
].join('\n');
export const DEFAULT_CHAPTER_PROMPT=[
  '你是剧情章节记忆整理员。把以下按时间顺序排列的楼层摘要归纳成一个章节。',
  '只陈述来源中出现的事件和因果，保留人物关系、关键决定、物品交接、地点变化及尚未解决的计划。',
  '避免复述不重要的对白，不增添新情节，时间或人物认知不确定时保持原状。',
  '输出简洁、连续的中文章节正文，不要 JSON、思考过程或格式说明。'
].join('\n');
export const DEFAULT_RESUMMARY2_PROMPT=[
  '你是剧情二次总结整理员。将相邻章节总结进一步压缩，保留跨章节人物关系和关键因果。',
  '保留对后续剧情有影响的承诺、行动后果、未解决悬念与物品状态；删除重复描述。',
  '只使用提供的内容，不编造新事件。输出简洁的连续中文正文，不要 JSON。'
].join('\n');
export const DEFAULT_OVERVIEW_PROMPT=[
  '你是长期剧情档案整理员。将多个章节总结整合成长期剧情概览。',
  '保留贯穿故事的主线、关系转折、重要物品与线索、长期计划及未解决的伏笔。',
  '对于已经结束的阶段进行压缩，避免人物状态或事件因果前后矛盾。',
  '只依赖提供的章节，不臆测后续。输出清晰精炼的中文正文，不要 JSON 或解释。'
].join('\n');
export function effectiveSummaryPrompt(settings) {
  const full=settings.prompts?.summaryFull?.trim();
  if(full)return full;
  const extras=settings.prompts?.summary?.trim()?.slice(0,6000);
  return DEFAULT_SUMMARY_PROMPT+(extras?'\n\n【补充要求】\n'+extras:'');
}
export function effectiveChapterPrompt(settings,kind='chapter') {
  return settings.prompts?.[kind]?.trim()||(kind==='overview'?DEFAULT_OVERVIEW_PROMPT:kind==='resummary2'?DEFAULT_RESUMMARY2_PROMPT:DEFAULT_CHAPTER_PROMPT);
}
export function buildSummaryMessages(index,chat,memory,settings){
  const msg=chat[index];
  if(!msg||msg.is_user||(msg.is_system&&!msg.extra?.story_memory_hidden)||!msg.mes?.trim())throw new ApiFault('楼层不是有效 AI 剧情');
  const preceding=floorUserMessages(chat,index).map(u=>String(u.mes||'')).join('\n\n').slice(-6000);
  const prior=Object.keys(memory.leaves||{}).map(Number).filter(i=>i<index&&leafValid(memory,chat,i)).sort((a,b)=>a-b).slice(-3).map(i=>memory.leaves[i]?.summary||'').join('\n').slice(-3500);
  const maxChars=Math.max(2000,Math.min(30000,Number(settings.summary?.maxInputChars)||16000));
  const source='【本轮用户输入】\n'+preceding+'\n\n【本轮 AI 剧情】\n'+String(msg.mes).slice(-maxChars);
  const instruction=effectiveSummaryPrompt(settings).slice(0,14000);
  return [{role:'system',content:instruction},{role:'user',content:'【已有摘要，仅供去重】\n'+prior+'\n\n'+source}];
}
export function buildChapterMessages(entries,settings,kind='chapter'){
  const rule=effectiveChapterPrompt(settings,kind);
  return [{role:'system',content:rule},{role:'user',content:entries.map((e,i)=>'['+(i+1)+'] '+(e.time?'('+e.time+') ':'')+e.summary).join('\n\n').slice(0,25000)}];
}

/** Fetch remote models through ST's Custom proxy using only this channel's API key. */
export async function listSummaryModels(ctx,{url,key='',headers={}}){
  if(!ctx?.getRequestHeaders)throw new ApiFault('酒馆尚未就绪');
  const customUrl=normalizeChannelUrl(url);
  if(!key.trim())throw new ApiFault('请先输入摘要 API 密钥');
  const customHeaders={...normalizeHeaders(headers),Authorization:'Bearer '+key.trim()};
  const response=await fetch('/api/backends/chat-completions/status',{
    method:'POST',headers:ctx.getRequestHeaders(),cache:'no-store',
    body:JSON.stringify({
      chat_completion_source:'custom',
      custom_url:customUrl,custom_include_headers:JSON.stringify(customHeaders)
    })
  });
  if(!response.ok)throw new ApiFault('模型列表获取失败（HTTP '+response.status+'）',response.status,'model_list_failed');
  const data=await response.json();
  if(!Array.isArray(data?.data))throw new ApiFault('服务端未返回标准模型列表，可手动输入模型 ID',422,'model_list_invalid');
  return [...new Set(data.data.map(x=>typeof x?.id==='string'?x.id.trim():'')
    .filter(x=>x.length>0&&x.length<=256))].sort((a,b)=>a.localeCompare(b));
}
