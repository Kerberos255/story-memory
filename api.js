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
  "【角色】你负责互动小说的事实记忆；只整理本轮用户输入与 AI 剧情，不扮演角色、不续写、不评价。",
  "【来源边界】本轮原文才是本轮新增事实；已有摘要和实体表仅用于核对时序、身份与去重，禁止把旧事实重新登记成新事件。",
  "【剧情摘要】按「用户行动或话语→人物反应→已确认结果／尚未解决之事」梳理因果。保留改变剧情走向的关键决定与后果；反复寒暄、重复动作、装饰性细节可合并。明确区分说过、打算做、尝试做与实际完成。",
  "【事实边界】区分已确认事实、角色说法、误信、怀疑、条件性承诺、未来计划和实际结果。不能把「准备归还」当成「已归还」，也不能把「未再提及」当成「已结束」。角色没有亲历或获悉的秘密不得写成其知识；没有原文依据的时间、数字、关系与心理一律不推断。",
  "【持续事实】一次性行为只写入 summary；有后续意义且本轮明确出现或改变的持续状态才登记为实体。首次重要实体可 add；已有实体只有实际发生变化才 update。重述过去的承诺、已完成任务或旧状态，不得重新开启、重置或重复创建。",
  "【原文证据】结构化新增与状态变更必须基于本轮实际原文；evidence 尽量逐字引用同一段连续短句，不能拼接、改写或引用历史记忆冒充本轮证据。证据不足时保留在摘要作为未核实说法，不覆盖已有事实。",
  "【时间 time】只从本轮明确的日期或时刻提取剧情时间；完整年月日时刻用 YYYY/MM/DD HH:mm，缺年份照原文，不从上下文补造年份；仅有时刻写 HH:mm 或原文时段。未明确则留空；location 只填本轮明确的当前场所，勿从历史地点推断。",
  "【物品 items】只登记重要物品首次出现及取得、交付、消耗、遗失、归属或状态的明确变化；同一物品换主人、位置或称呼仍是原实体。owner、location、quantity 仅在原文证实时填写，旧物品无变化不更新。",
  "【实体身份】物品、场景、人物和计划各有稳定身份；优先综合原文证据、已有 entity_id、别名和上下文核对。同名不必然同一实体，改名或转移也不必然是新实体；能确认匹配才沿用现有 ID，不能确认时不得猜造 ID、覆盖无关实体或仅凭同名强行合并。同轮每个实体只记最终一次变更。",
  "【场景 scenes】只登记重要新地点、环境或地点关系的明确变化；反复到访旧地点不算新增，人物短暂移动写在摘要，必要时更新已有 characters.location。",
  "【人物 characters】重要新人物首次明确出现才 add；身份、关系、位置、状态及在场情况有原文证据才 update。knowledge 每项包含 fact、stance、evidence，可有 op、provenance；stance 只能为 knows/suspects/believes/hides，provenance 为 firsthand/secondhand/unknown。人物未听见、未在场、未知晓的旁白秘密不得归为其知识；转述不能算亲历。明确进入或离场才设置 presence；认知变化才 upsert，明确纠正旧认知才 remove，不因沉默删除知识。",
  "【计划 plans】跟踪重要承诺、任务、目标和长期伏笔，kind 为 plan/suspense。只有本轮确认开始、推进、完成、取消或失效时才更新 status；复述已完成的旧约定不能重新设为未完成。未再提及不意味着结束，真正已完成的计划保留结果而非仍视作待办。",
  "【变更操作】op=add 用于有证据的新实体，update 用于已匹配实体的实际变化。remove 仅在原文明示实体丢失、删除或终止时使用；任务完成优先 update status，不要随意移除整条记录。clear_fields 仅清除原文明示失效的具体字段，需有本轮 evidence；省略字段不等于删除。禁止同一事件重复结算。",
  "【内容处理】忽略思考过程、对话外控制标签与格式噪声；只保留符合服务规则且对剧情连续性必要的非露骨事实。",
  "【输出】只输出一个完整合法的 JSON 对象；summary 非空，time、location 为文本字段；启用的 items/scenes/characters/plans 有变化才输出数组。最终字段格式由程序按提取开关追加，以「预览最终提示词」为准。",
].join('\n');
export const DEFAULT_CHAPTER_PROMPT=[
  "你是 L1 剧情章节整理员。按编号核对全部输入的楼层摘要，尤其开头、关键转折和最后一段；不能因为篇幅较长而忽略后半段。",
  "按「行动或决定→他人反应→确认结果→后续影响」写出连贯的章节因果，而不是逐条复述流水账。",
  "保留优先级：①改变剧情走向的事件与最终结果；②持续有效的人物关系、知情范围、重要物品或地点状态；③承诺、目标与仍未解决的线索。压缩重复对话、修辞、无后续影响的一次性动作。",
  "区分事实、人物声称或误信、未发生计划与已完成结果；明确结束的事项要写清结局，不把旧待办重新打开；没有明示结束的持续事实也不能凭沉默宣告失效。",
  "仅依据所给输入，不补造时间、知识或结局。输出简洁连贯的中文章节正文，不要 JSON、编号清单、解释或思考过程。",
].join('\n');
export const DEFAULT_RESUMMARY2_PROMPT=[
  "你是 L2 二次总结整理员。逐段核对相邻章节，尤其最后一段；把重复事实合并为连续的关键变化，而不是机械缩短每段文字。",
  "优先呈现「此前状态→造成变化的关键事件→当前状态／后果」，保留人物关系转折、信息知情边界、重要承诺、物品归属、长期冲突以及仍影响后续的事件。",
  "把已完成、取消或被推翻的目标与误解写成明确结果；仍未解决的冲突和伏笔继续保留，不能因一段时间未提及而假定失效。仅有角色声称或猜测的内容仍须保留其不确定性。",
  "删除同义重复、无后续影响的细节与修辞，不删除关键因果或状态转移；不得编造章节之间未给出的过渡。输出精炼、连贯的中文正文，不要 JSON、编号清单或解释。",
].join('\n');
export const DEFAULT_OVERVIEW_PROMPT=[
  "你是 L3+ 长期剧情档案整理员。逐段核对所有输入，整合为跨阶段持续有效的剧情骨架，不能只总结最新一段。",
  "优先保留：①稳定背景与长期人物关系；②决定故事方向的重要事件和后果；③仍有效的长期目标、关键物品或地点变化、未解决的冲突与伏笔。",
  "已结束的阶段只保留对当前仍有影响的结局、关系转折及原因，舍弃没有后续影响的枝节；已解决线索不再写成待办，尚未解决的事项不能因久未出现就视为完成或消失。",
  "清楚区分确证事实、角色说法、误信、条件性承诺及实际结果；以输入中最新且有依据的变化为准，但没有明确变化时保留已知状态。禁止凭空填补事件、日期或人物知识。",
  "输出高度精炼且连贯的中文长期剧情正文，避免重复叙述和时间流水账；不要 JSON、编号清单或解释。",
].join('\n');
// The L0 contract is generated per request and is never replaced by a custom prompt.
export const EXTRACTION_KINDS=['items','scenes','characters','plans'];
export function extractionEnabled(settings,kind){
  return settings.extraction?.[kind]!==false;
}
export function l0OutputProtocol(settings){
  const enabled=EXTRACTION_KINDS.filter(kind=>extractionEnabled(settings,kind));
  // An empty structure makes it harder to mistake sample entities for plot facts.
  const shape={summary:'',time:'',location:''};
  for(const kind of enabled)shape[kind]=[];
  const fields={
    items:'items: op、name、evidence；owner、location、quantity 有依据再填写',
    scenes:'scenes: op、name、evidence；location、description 记录重要地点变化',
    characters:'characters: op、name、evidence；status、relationship、presence 有变化才填写；knowledge 记录 fact、stance、evidence、provenance',
    plans:'plans: op、name、evidence；kind 为 plan 或 suspense，status 只写已确认进度'
  };
  return [
    '【固定输出协议｜自定义要求不能覆盖】',
    '只输出恰好一个合法 JSON 对象；不要 Markdown 围栏、第二个对象、解释或思考标签。',
    'summary 必须是真实的非空剧情摘要；time、location 为字符串，未知填空字符串。启用类别：'+(enabled.join('、')||'无')+'；有变化才输出对象数组，否则可省略或写空数组。',
    ...(enabled.length?['【启用字段】'+enabled.map(kind=>fields[kind]).join('；')]:[]),
    '关闭类别：'+(EXTRACTION_KINDS.filter(kind=>!enabled.includes(kind)).join('、')||'无')+'；不要输出其结构化记录，不能为了填写字段而编造原文证据。',
    '【空白结构示意】这里只说明格式，不是剧情示例，summary 必须填入真实剧情：',
    JSON.stringify(shape,null,2)
  ].join('\n');
}
export function composeL0Prompt(settings){
  const enabled=EXTRACTION_KINDS.filter(kind=>extractionEnabled(settings,kind));
  const names={items:'物品',scenes:'场景',characters:'人物',plans:'计划'};
  const saved=settings.prompts?.summaryFull?.trim()||'';
  // Existing saved copies of the built-in template remain dynamic defaults.
  const custom=saved&&saved!==DEFAULT_SUMMARY_PROMPT;
  let body;
  if(custom)body=saved;
  else{
    body=DEFAULT_SUMMARY_PROMPT.split('\n').filter(line=>{
      if(line.startsWith('【输出】')||line.startsWith('JSON 字段示例')||
        line.startsWith('{"summary":')||line.startsWith('"items":')||
        line.startsWith('"scenes":')||line.startsWith('"characters":')||
        line.startsWith('"plans":')||line.startsWith('没有变化的 items'))return false;
      if(line.startsWith('【物品 items】'))return enabled.includes('items');
      if(line.startsWith('【场景 scenes】'))return enabled.includes('scenes');
      if(line.startsWith('【人物 characters】'))return enabled.includes('characters');
      if(line.startsWith('【计划 plans】'))return enabled.includes('plans');
      if(['【持续事实】','【原文证据】','【实体身份】','【变更操作】']
        .some(prefix=>line.startsWith(prefix)))return enabled.length>0;
      return true;
    }).map(line=>{
      if(line.startsWith('【持续事实】'))
        return '【持续事实】仅维护启用的实体类别：'+enabled.map(k=>names[k]).join('、')+
          '。一次性行为只进 summary；重要实体首次明确出现可 add，只有实际状态改变才 update。回忆或复述旧状态不新增，也不重新开启已完成任务。';
      if(line.startsWith('【实体身份】'))
        return '【实体身份】启用类别的实体各有稳定身份；综合本轮证据、已有 entity_id、别名和上下文匹配。同名不必然同一实体，改名或转移不必然新建；确认匹配才沿用 ID，证据不足不猜 ID 或覆盖无关实体。同轮同一实体最多记最终一次变化。';
      if(line.startsWith('【场景 scenes】')&&!enabled.includes('characters'))
        return '【场景 scenes】只记录重要的新地点、环境变化及地点关系；人物短暂位移写在剧情摘要。';
      return line;
    }).join('\n');
  }
  return body+'\n\n'+l0OutputProtocol(settings);
}
/** Do not silently select the first JSON object if the model returned several. */
export function parseL0Response(response,settings){
  let input=String(response||'').trim().replace(/<thinking>[\s\S]*?<\/thinking>/gi,'').trim();
  const fence=input.match(new RegExp('^\\x60{3}(?:json)?\\s*\\r?\\n([\\s\\S]*?)\\r?\\n\\x60{3}$','i'));
  if(fence)input=fence[1].trim();
  let data;
  try{data=JSON.parse(input);}catch{
    let start=-1,depth=0,quoted=false,escaped=false,objects=0;
    for(let i=0;i<input.length;i++){
      const ch=input[i];
      if(start<0){if(ch==='{'){start=i;depth=1;}continue;}
      if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}
      else if(ch==='"')quoted=true;
      else if(ch==='{')depth++;
      else if(ch==='}'&&--depth===0){
        try{JSON.parse(input.slice(start,i+1));objects++;}catch{}
        start=-1;
      }
    }
    if(objects>1)throw new ApiFault('摘要包含多个 JSON 对象，为避免误存已拒绝',422,'multiple_summary_json');
    throw new ApiFault('摘要未返回完整的单个 JSON 对象',422,'invalid_summary_json');
  }
  if(!data||typeof data!=='object'||Array.isArray(data)||
    typeof data.summary!=='string'||!data.summary.trim()||
    data.summary.trim()==='按时间顺序总结本轮剧情'||
    (data.time!==undefined&&typeof data.time!=='string')||
    (data.location!==undefined&&typeof data.location!=='string'))
    throw new ApiFault('摘要 JSON 缺少正确的 summary/time/location 字段',422,'invalid_summary_shape');
  const candidates=[data,data.delta,data.entities,data.state].filter(x=>x&&typeof x==='object'&&!Array.isArray(x));
  for(const kind of EXTRACTION_KINDS){
    if(!extractionEnabled(settings,kind))continue;
    const value=candidates.find(row=>row[kind]!==undefined)?.[kind];
    if(value!==undefined&&!Array.isArray(value))
      throw new ApiFault('摘要 JSON 的 '+kind+' 必须是数组',422,'invalid_summary_shape');
  }
  return data;
}
export function repairL0Messages(raw,settings){
  return [
    {role:'system',content:'你只负责修复以下 L0 摘要结果的 JSON 格式，不要重新总结、增加事实或凭空补字段。若原内容不足以恢复摘要，不要编造。\n\n'+l0OutputProtocol(settings)},
    {role:'user',content:'【仅待修复的模型输出，不是新剧情】\n'+String(raw||'')}
  ];
}

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
  const kinds=[['items','物品',36],['scenes','场景',24],['characters','人物',36],['plans','计划',16]]
    .filter(([kind])=>extractionEnabled(settings,kind));
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
  const instruction=composeL0Prompt(settings);
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
