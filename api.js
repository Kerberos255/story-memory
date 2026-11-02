// Minimal ST-proxied OpenAI compatible client. Never log headers, keys, or story text.
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
export function makeBody(channel,messages) {
  const url=normalizeChannelUrl(channel.url);
  if(!channel.model?.trim())throw new ApiFault('请设置副 API 模型');
  const headers=normalizeHeaders(channel.headers);
  // Authentication is owned by the configured SillyTavern Custom API secret.
  const include=channel.include&&typeof channel.include==='object'&&!Array.isArray(channel.include)?structuredClone(channel.include):{};
  const body={
    chat_completion_source:'custom',custom_url:url,
    custom_include_headers:JSON.stringify(headers),custom_include_body:JSON.stringify(include),
    model:channel.model.trim(),messages,stream:false,tool_choice:'none',
    temperature:Number.isFinite(Number(channel.temperature))?Number(channel.temperature):0.2,
    max_tokens:Math.max(256,Math.min(32768,Math.trunc(Number(channel.maxTokens)||4096)))
  };
  const fixed=new Set(['chat_completion_source','custom_url','custom_include_headers','custom_include_body','model','messages','stream','tool_choice']);
  for(const name of Array.isArray(channel.exclude)?channel.exclude:[]){
    if(typeof name==='string'&&!fixed.has(name.trim()))delete body[name.trim()];
  }
  return body;
}
function pullText(data) {
  const value=data?.choices?.[0]?.message?.content??data?.choices?.[0]?.text??data?.content;
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.map(x=>typeof x?.text==='string'?x.text:'').join('');
  return '';
}
export async function requestChat(channel,messages,ctx,externalSignal) {
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
  '你是互动剧情的客观记忆整理程序。只读取给出的对话与已有状态。',
  '不要扮演角色或续写剧情。历史摘要仅用于核对，不能当成本轮新增事实。',
  '将事件按时间先后写入 summary，保留人物言行、同意或拒绝、约定、结果、未解决悬念。',
  '区分事实、传闻、人物认知和推测；禁止编造事实与重复结算。',
  '仅记录符合服务规则、对连续性必要的非露骨内容。时间不确定则不要编造。',
  '只输出一个合法 JSON 对象，不要代码围栏、解释或思考标签。',
  '结构：{"summary":"必填剧情摘要","time":"可选故事时间","location":"可选当前地点",',
  '"items":[{"op":"add|update|remove","name":"物品名","quantity":1,"location":"地点","owner":"归属","description":"可选"}],',
  '"scenes":[{"op":"add|update|remove","name":"地点名","location":"上级地点","description":"可选"}],',
  '"characters":[{"op":"add|update|remove","name":"人物名","location":"所在地点","relationship":"关系","status":"当前状态","description":"可选"}],',
  '"plans":[{"op":"add|update|remove","name":"计划或悬念","kind":"plan|suspense","status":"待办或完成","description":"可选"}]}。',
  '四个数组没有变化可省略。数量仅写有证据的值。不要调用工具。'
].join('\n');
export function buildSummaryMessages(index,chat,memory,settings){
  const msg=chat[index];
  if(!msg||msg.is_user||msg.is_system||!msg.mes?.trim())throw new ApiFault('楼层不是有效 AI 剧情');
  let preceding='';
  for(let j=index-1;j>=0;j--){const u=chat[j];if(u?.is_user&&!u?.is_system){preceding=String(u.mes||'').slice(-6000);break;}}
  const prior=Object.keys(memory.leaves||{}).map(Number).filter(i=>i<index).sort((a,b)=>a-b).slice(-3).map(i=>memory.leaves[i]?.summary||'').join('\n').slice(-3500);
  const maxChars=Math.max(2000,Math.min(30000,Number(settings.summary?.maxInputChars)||16000));
  const source='【本轮用户输入】\n'+preceding+'\n\n【本轮 AI 剧情】\n'+String(msg.mes).slice(-maxChars);
  const extras=settings.prompts?.summary?.trim()?.slice(0,6000);
  const instruction=DEFAULT_SUMMARY_PROMPT+(extras?'\n\n【额外偏好：不能改变 JSON 格式与事实边界】\n'+extras:'');
  return [{role:'system',content:instruction},{role:'user',content:'【已有摘要，仅供去重】\n'+prior+'\n\n'+source}];
}
export function buildChapterMessages(entries,settings){
  const rule=settings.prompts?.chapter?.trim()||'将连续剧情摘要合并成一段章节总结，保留因果、人物变化、时间地点与悬念。只输出正文，不添加虚构内容。';
  return [{role:'system',content:rule},{role:'user',content:entries.map(e=>e.summary).join('\n\n').slice(0,25000)}];
}
