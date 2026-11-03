// Minimal ST-proxied OpenAI compatible client. Never log headers, keys, or story text.
import {floorUserMessages,leafValid,deriveState} from './core.js';
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
  const think=String(channel.thinkLevel??'auto').trim().toLowerCase();
  if(!['auto','low','medium','high','max'].includes(think))throw new ApiFault('思考等级无效');
  // Custom OpenAI-compatible route: pass only explicitly selected effort.
  // Auto leaves all existing provider/advanced settings untouched.
  if(think!=='auto')include.reasoning_effort=think;
  const body={
    chat_completion_source:'custom',custom_url:url,
    custom_include_headers:JSON.stringify(headers),custom_include_body:JSON.stringify(include),
    custom_exclude_body:(Array.isArray(channel.exclude)?channel.exclude:[])
      .filter(name=>typeof name==='string'&&/^[a-zA-Z_][\w.-]{0,99}$/.test(name))
      .map(name=>'- '+name).join('\n'),
    model:channel.model.trim(),messages,stream:false,tool_choice:'none',
    temperature:Number.isFinite(Number(channel.temperature))?Number(channel.temperature):0
  };
  // A blank limit defers to the provider's or SillyTavern's response setting.
  if(channel.maxTokens!==null&&channel.maxTokens!==undefined&&String(channel.maxTokens).trim()!==''){
    const cap=Number(channel.maxTokens);
    if(!Number.isInteger(cap)||cap<256||cap>65536)throw new ApiFault('输出上限应为 256 到 65536 的整数');
    body.max_tokens=cap;
  }
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
      const options={prompt:messages};
      if(channel.maxTokens!==null&&channel.maxTokens!==undefined&&String(channel.maxTokens).trim()!==''){
        const cap=Number(channel.maxTokens);
        if(!Number.isInteger(cap)||cap<256||cap>65536)throw new ApiFault('输出上限应为 256 到 65536 的整数');
        options.responseLength=cap;
      }
      const text=await ctx.generateRaw(options);
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
    if(!response.ok)throw new ApiFault('副 API 返回 HTTP '+response.status,response.status,
      response.status===413?'request_too_large':'upstream_http_'+response.status);
    const json=await response.json().catch(()=>{throw new ApiFault('副 API 返回无效 JSON',502,'invalid_api_response');});
    // Some ST proxy paths wrap upstream 4xx in a 200 JSON error. Never retry unknown policy errors.
    if(json?.error){
      const code=String(json.error.code||'');
      if(['context_length_exceeded','context_window_exceeded'].includes(code))
        throw new ApiFault('请求超出模型上下文',422,'context_length_exceeded');
      throw new ApiFault('副 API 返回错误',422,'upstream_rejected');
    }
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
  '【剧情摘要】按「用户的行动或话语 → 其他人物/AI 的反应 → 确认结果或仍未解决的问题」整理本轮事件。记录对话双方的实际行为，不把用户指令或传闻写成已完成剧情。',
  '【事实边界】区分叙事已经确认、人物声称/误信/怀疑、将来计划、条件性承诺、已发生结果。「打算做」不等于「已经做」，「停止瞄准」不等于「解除武装」。原文无依据就保留未知，禁止补造时间、数字、人物知识或好感。',
  '【持续事实】一次性动作只进 summary；状态表记录结束后仍有效的身份、归属、关系、任务、人物知情等。首次明确出现且对后续剧情有意义的人物、重要物品、重要场景，即使暂无后续变化，也要用 add 登记；原文未证实身份或重要性的路人布景不登记。同一事项更新旧实体，不新增同义记录。已有实体无变化输出空数组。',
  '【原文证据】结构化条目的新事实或状态变更尽量附 evidence：从本轮用户或 AI 正文逐字摘取连续原句，不可改写、跨句拼接或引用已有记忆作为证据。确实没有依据就不输出该变更；矛盾未确认时留在摘要中作为争议信息，不覆盖旧状态。',
  '【时间 time】凡原文明确提供的本轮剧情日期或时刻，都要同步输出在独立 time 字段，不要只写进 summary。完整年月日且有时刻用 YYYY/MM/DD HH:mm；只给月日而没有年份时照原文写「三月十二日」或「三月十二日清晨八点十五分」，不得补造年份；只给时刻写 HH:mm 或原文时段。时间不明确则留空，不能从其他事件推断。地点另填独立 location；两者都不得臆造。',
  '【物品 items】首次出现且对后续剧情重要的物品用 add 登记；取得、交付、消耗、遗失或状态变化则新增或更新对应实体。写明确定的归属 owner、存放地点 location、数量 quantity。已有物品没有变化就不更新。',
  '【实体身份】物品、场景、人物各自都有稳定身份，不能因为称呼、归属、位置或状态变化就新建实体。先查下方现有实体表：如果是同一个对象，使用已有的 entity_id，并尽量沿用其 name；仅有证据证明是不同对象时才新增。不能只凭类似名称、同类别或同一主人认定为同一个实体。每类同一实体在同一轮最多输出一次变化，记录最终状态。',
  '【场景 scenes】只记录重要的新地点、环境变化和地点间关系；角色的短暂位移可以写进剧情摘要，必要时在 characters.location 更新。',
  '【人物 characters】首次明确出现、对后续剧情有意义的人物用 add 登记；已有角色的可核实身份、当前状态、位置或关系发生变化时用 update。知识边界直接挂在已有 characters 的 knowledge 数组：每项 {fact,stance,evidence,op?}，stance 只能为 knows（确知）、suspects（怀疑）、believes（误信）、hides（明确隐瞒）；每条事实须有本轮原文连续引文 evidence。人物未听见、未在场或全知叙述揭露的信息，不能自动算作该人物知道。知识无变化时不发送 knowledge；获悉新事实用 upsert，明确得知旧认知不再成立时才用 op=remove。不要为同一 NPC 的知情信息另建角色。',
  '【计划 plans】保留承诺、约定、正在执行的计划、已结束的任务与长期伏笔；status 表示当前进度，kind 为 plan 或 suspense。',
  '【变更操作】op=add 表示新出现，update 表示原记录被改变，remove 仅在原文明确删除、失去或终止时使用。不得重复结算同一事件。',
  '【内容处理】忽略对话外的控制标签、思考过程和格式噪声。只概括符合服务规则、对剧情连续性必要的非露骨事实。',
  '【输出】严格输出一个合法 JSON 对象，不包含 Markdown 围栏、解释、思考标签或任何工具调用。必填 summary；items、scenes、characters、plans 为顶层数组，有相应实体新出现或发生变化时必须输出对应条目，不能只写在 summary 里。',
  'JSON 字段示例（不是必须填满所有字段）：',
  '{"summary":"按时间顺序整理本轮剧情","time":"有依据时填写故事时间","location":"有依据时填写当前地点",',
  '"items":[{"op":"update","entity_id":"已存在实体的完整 ID（新物品省略）","name":"沿用旧名称","quantity":1,"owner":"持有者","location":"存放地点","description":"物品变化"}],',
  '"scenes":[{"op":"update","entity_id":"匹配旧地点才填写","name":"地点名称","location":"上级地点","description":"环境或结构变化"}],',
  '"characters":[{"op":"update","entity_id":"匹配旧人物才填写","name":"人物名称","location":"当前位置","relationship":"关系变化","status":"当前状态","evidence":"本轮原文短句","knowledge":[{"fact":"具体获知的事","stance":"knows","evidence":"角色获知此事的原文短句"}]}],',
  '"plans":[{"op":"add","name":"约定或悬念","kind":"plan","status":"未完成","description":"来源与进度"}]}',
  '没有变化的 items、scenes、characters、plans 可以省略或输出空数组。数量与状态不能凭空推断。'
].join('\n');
export const DEFAULT_CHAPTER_PROMPT=[
  '你是剧情章节记忆整理员。逐条核对以下按编号排列的楼层摘要，归纳成一个章节；开头、中段、结尾都必须核对，不能只处理前几条。',
  '按用户行动→其他人物反应→结果组织因果；保留有后续影响的承诺、人物知情范围、持续状态及未解决线索。已发生、计划、猜测、误信必须分清；旧事实没有明确变化就不能宣告消失。',
  '逐项覆盖所有输入编号，但不必逐条照抄；摘要不允许漏掉最后一段，不能捏造原文证据、具体日期或人物知情。删掉修辞、重复动作而非关键决定和结果。',
  '输出简洁、连续的中文章节正文，不要 JSON、思考过程或格式说明。'
].join('\n');
export const DEFAULT_RESUMMARY2_PROMPT=[
  '你是剧情二次总结整理员。将相邻章节总结进一步压缩，保留跨章节人物关系和关键因果。',
  '保留有源依据的关键事件、人物关系变化、持续事实、人物知情边界、承诺、行动后果与未解决悬念。逐项核对全部输入，尤其最后一段；删重复修辞，不删因果或重要状态。',
  '只使用提供的内容，不编造新事件。输出简洁的连续中文正文，不要 JSON。'
].join('\n');
export const DEFAULT_OVERVIEW_PROMPT=[
  '你是长期剧情档案整理员。将多个章节总结整合成长期剧情概览。',
  '保留贯穿故事的主线、关系转折、重要物品与线索、长期计划及未解决的伏笔。',
  '逐项处理全部输入；对已结束阶段压缩，但必须区分已证实事实、角色说法、误信、未完成计划和最终结果。未再提及不等于关系、承诺或重要状态已结束。',
  '只依赖提供的章节，不臆测后续。输出清晰精炼的中文正文，不要 JSON 或解释。'
].join('\n');
export function effectiveSummaryPrompt(settings) {
  const full=settings.prompts?.summaryFull?.trim();
  if(full)return full;
  const extras=settings.prompts?.summary?.trim();
  return DEFAULT_SUMMARY_PROMPT+(extras?'\n\n【补充要求】\n'+extras:'');
}
export function effectiveChapterPrompt(settings,kind='chapter') {
  return settings.prompts?.[kind]?.trim()||(kind==='overview'?DEFAULT_OVERVIEW_PROMPT:kind==='resummary2'?DEFAULT_RESUMMARY2_PROMPT:DEFAULT_CHAPTER_PROMPT);
}
export function buildSummaryMessages(index,chat,memory,settings,sourceOverride=null){
  const msg=chat[index];
  if(!msg||msg.is_user||(msg.is_system&&!msg.extra?.story_memory_hidden)||!msg.mes?.trim())throw new ApiFault('楼层不是有效 AI 剧情');
  const preceding=floorUserMessages(chat,index).map(u=>String(u.mes||'')).join('\n\n');
  const prior=Object.keys(memory.leaves||{}).map(Number).filter(i=>i<index&&leafValid(memory,chat,i)).sort((a,b)=>a-b).slice(-3).map(i=>memory.leaves[i]?.summary||'').join('\n').slice(-3500);
  // Automatic multi-request processing passes a complete, ordered source segment.
  const source=sourceOverride??('【本轮用户输入】\n'+preceding+'\n\n【本轮 AI 剧情】\n'+String(msg.mes));
  // A manual backfill must not expose future story events to earlier floors.
  const history={...memory,leaves:Object.fromEntries(Object.entries(memory.leaves||{}).filter(([floor])=>Number(floor)<index))};
  const state=deriveState(history,chat);
  const kinds=[['items','物品',36],['scenes','场景',24],['characters','人物',36],['plans','计划',16]];
  // Keep each catalog row complete; never cut a JSON entity record mid-field.
  let remaining=8500;
  const catalogSections=[];
  for(const [kind,label,max] of kinds){
    const rows=(state[kind]||[]).filter(x=>!x.manual).slice(-max);
    if(!rows.length)continue;
    const header='【已登记'+label+'（仅供实体身份核对，非本轮新事件）】';
    if(header.length+80>remaining)break;
    let section=header;
    for(const entity of rows){
      const line=JSON.stringify({entity_id:entity.entity_id,name:entity.name,
        aliases:entity.aliases?.slice(-3)||[],owner:entity.owner||'',
        location:entity.location||'',status:entity.status||'',
        ...(kind==='characters'?{knowledge:(entity.knowledge||[]).slice(-5).map(x=>({fact:x.fact,stance:x.stance}))}:{})});
      if(section.length+line.length+1>remaining)break;
      section+='\n'+line;
    }
    if(section!==header){
      catalogSections.push(section);
      remaining-=section.length+2;
    }
  }
  const catalog=catalogSections.join('\n\n');
  const instruction=effectiveSummaryPrompt(settings);
  return [{role:'system',content:instruction},{role:'user',content:'【已有摘要，仅供去重】\n'+prior+'\n\n'+(catalog?catalog+'\n\n【实体引用要求】如为上述已有实体，请引用完全一致的 entity_id，保留统一名称；如无法确定则不要猜测 ID。\n\n':'')+source}];
}
export function buildChapterMessages(entries,settings,kind='chapter'){
  const rule=effectiveChapterPrompt(settings,kind);
  const source=entries.map((e,i)=>'['+(i+1)+'] '+(e.time?'('+e.time+') ':'')+e.summary).join('\n\n');
  if(source.length>25000)throw new ApiFault('分层摘要输入超过安全上限，请先缩短源摘要，不能截断后强行合并',422,'chapter_input_oversize');
  return [{role:'system',content:rule},{role:'user',content:source}];
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
