// Independent, dependency-free story memory model. No BaiBai code is reused.
export const META_KEY = 'story_memory_v1';
export const SETTINGS_KEY = 'story_memory_settings_v1';

export function defaultSettings() {
  return {
    enabled: true, autoSummary: false, api: {name:'摘要 API',mode:'main',url:'',key:'',model:'',headers:{},exclude:[],include:{},maxTokens:8192,timeout:90,temperature:0},
    summary: {keepRecent:3,autoHide:false,delayFloors:3,leafBatchThreshold:12,leafKeepRecent:3,resummaryThreshold:6,higherResummaryThreshold:3,retry:1,maxInputChars:16000},
    injection: {summary:true,inventory:true,scenes:true,characters:true,vector:false,budget:4500},
    prompts: {summary:'',summaryFull:'',chapter:'',resummary2:'',overview:''},
    vector: {enabled:false,url:'https://api.siliconflow.cn/v1',key:'',model:'BAAI/bge-m3',topK:5,threshold:0.35}
  };
}
export function freshMemory() {
  return {version:1,leaves:{},chapters:[],manual:{summaries:[],items:[],scenes:[],characters:[]},tasks:{},revision:0};
}
export function readMemory(ctx) {
  if (!ctx?.chatMetadata) return freshMemory();
  const existing=ctx.chatMetadata[META_KEY];
  if (!existing || existing.version!==1 || typeof existing.leaves!=='object') return freshMemory();
  return structuredClone(existing);
}
export function writeMemory(ctx,memory) {
  if(!ctx?.chatMetadata) throw Error('聊天尚未就绪');
  ctx.chatMetadata[META_KEY]=memory;
  ctx.saveMetadataDebounced?.();
}
export function hashText(text) {
  let h=2166136261;
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}
  return (h>>>0).toString(16).padStart(8,'0');
}
export function messageFingerprint(message) {
  if(!message || message.is_user || (message.is_system&&!message.extra?.story_memory_hidden)) return '';
  return hashText(String(message.mes||'')+'|swipe='+String(message.swipe_id??0));
}
export function floorUserMessages(chat,index){
  const users=[];
  for(let j=index-1;j>=0;j--){
    const m=chat?.[j];
    if(!m?.is_user || (m.is_system&&!m.extra?.story_memory_hidden))break;
    users.unshift(m);
  }
  return users;
}
export function userFingerprint(chat,index){
  return hashText(floorUserMessages(chat,index).map(m=>String(m.mes||'')).join('\u001f'));
}
export function leafValid(memory,chat,index){
  const leaf=memory.leaves?.[index];
  if(!leaf||leaf.fingerprint!==messageFingerprint(chat?.[index]))return false;
  return !leaf.userFingerprint||leaf.userFingerprint===userFingerprint(chat,index);
}
export function pendingFloors(memory,chat) {
  const pending=[];
  for(let i=0;i<(chat?.length||0);i++){
    const m=chat[i],fingerprint=messageFingerprint(m);
    if(!fingerprint) continue;
    if(leafValid(memory,chat,i))continue;
    pending.push(i);
  }
  return pending;
}
const cleanString=(value,limit=3000)=>typeof value==='string'?value.trim().slice(0,limit):'';
export function normalizeDelta(raw) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('摘要 JSON 必须是对象');
  const summary=cleanString(raw.summary,8000);
  if(!summary) throw Error('缺少 summary');
  const delta={items:[],scenes:[],characters:[],plans:[]};
  for(const kind of Object.keys(delta)){
    if(raw[kind]!==undefined && !Array.isArray(raw[kind]))throw Error(kind+' 必须为数组');
    for(const item of (raw[kind]||[]).slice(0,35)){
      if(!item||typeof item!=='object'||Array.isArray(item))continue;
      const op=['add','update','remove'].includes(item.op)?item.op:'update';
      const name=cleanString(item.name,120);
      if(!name)continue;
      const out={op,name};
      for(const key of ['description','location','owner','status','relationship','time','kind']) {
        const value=cleanString(item[key],600);if(value)out[key]=value;
      }
      if(Number.isFinite(item.quantity)&&item.quantity>=0&&item.quantity<=1000000)out.quantity=item.quantity;
      delta[kind].push(out);
    }
  }
  return {summary,time:cleanString(raw.time,100),location:cleanString(raw.location,180),delta};
}
export function commitLeaf(memory,index,fingerprint,data,userFp='') {
  if(!Number.isInteger(index)||index<0||!fingerprint)throw Error('楼层标识无效');
  const next=structuredClone(memory);
  next.leaves[index]={id:'floor:'+index,sourceIndex:index,fingerprint,userFingerprint:userFp,summary:data.summary,time:data.time,location:data.location,delta:data.delta,updatedAt:Date.now()};
  delete next.tasks[index];
  // Any changed leaf invalidates its ancestor compression chain, not other chapters.
  const invalid=new Set(['floor:'+index]);
  let size=-1;
  while(size!==invalid.size){
    size=invalid.size;
    for(const chapter of next.chapters)if(chapter.children?.some(id=>invalid.has(id)))invalid.add(chapter.id);
  }
  next.chapters=next.chapters.filter(chapter=>!invalid.has(chapter.id));
  next.revision++;
  return next;
}
export function addManual(memory,kind,entry) {
  if(!['summaries','items','scenes','characters'].includes(kind))throw Error('未知记录类型');
  const text=cleanString(entry,12000);
  if(!text)throw Error('不能保存空白记录');
  const next=structuredClone(memory);
  next.manual[kind].push({id:'manual:'+Date.now()+':'+Math.random().toString(36).slice(2,8),text,updatedAt:Date.now()});
  next.revision++;
  return next;
}
export function editManual(memory,kind,id,text) {
  const next=structuredClone(memory),row=next.manual[kind]?.find(x=>x.id===id);
  if(!row)throw Error('记录不存在');
  row.text=cleanString(text,12000);
  if(!row.text)throw Error('记录不能为空');
  row.updatedAt=Date.now();next.revision++;return next;
}
export function removeManual(memory,kind,id){
  const next=structuredClone(memory),list=next.manual[kind];
  if(!Array.isArray(list))throw Error('未知记录类型');
  const position=list.findIndex(x=>x.id===id);
  if(position<0)throw Error('记录不存在');
  list.splice(position,1);next.revision++;return next;
}
export function validChapters(memory,chat){
  const valid=new Set();
  const chapters=[];
  for(const c of memory.chapters||[]){
    if(!Array.isArray(c.children)||!c.children.length)continue;
    const okay=c.children.every(id=>{
      if(id.startsWith('floor:')){
        const index=Number(id.slice(6)),leaf=memory.leaves?.[index];
        return Boolean(leaf&&leafValid(memory,chat,index));
      }
      return valid.has(id);
    });
    if(okay){valid.add(c.id);chapters.push(c);}
  }
  return chapters;
}
export function deriveState(memory,chat) {
  const sections={items:new Map(),scenes:new Map(),characters:new Map(),plans:new Map()};
  const floors=Object.keys(memory.leaves||{}).map(Number).sort((a,b)=>a-b);
  const timeline=[];
  for(const i of floors){
    const entry=memory.leaves[i];
    if(!entry || !leafValid(memory,chat,i))continue;
    timeline.push(entry);
    for(const [kind,rows] of Object.entries(entry.delta||{})){
      const map=sections[kind];if(!map||!Array.isArray(rows))continue;
      for(const change of rows){
        const key=String(change.name||'').trim().toLowerCase();
        if(!key)continue;
        if(change.op==='remove'){map.delete(key);continue;}
        const old=map.get(key)||{name:change.name};
        map.set(key,{...old,...change,op:undefined,sourceIndex:i});
      }
    }
  }
  for(const kind of ['items','scenes','characters']){
    for(const m of memory.manual?.[kind]||[]){
      // Manual notes do not silently overwrite AI-generated structured facts.
      sections[kind].set(m.id,{name:m.text,manual:true});
    }
  }
  const state=Object.fromEntries(Object.entries(sections).map(([k,v])=>[k,[...v.values()]]));
  return {timeline,...state};
}
export function injectionText(memory,chat,settings,vectorHits=[]) {
  const state=deriveState(memory,chat),cfg=settings.injection||{},blocks=[];
  if(cfg.summary){
    const chapters=validChapters(memory,chat);
    const nested=new Set(chapters.filter(c=>c.level>1).flatMap(c=>c.children||[]));
    if(chapters.length)blocks.push('【分层剧情记忆】\n'+chapters.filter(c=>!nested.has(c.id)).slice(-12).map(c=>'[L'+c.level+'] '+c.summary).join('\n'));
    const recent=Math.max(0,Number(settings.summary?.keepRecent??6));
    const keepStart=recentAiStart(chat,recent);
    const eligible=state.timeline.filter(leaf=>leaf.sourceIndex<keepStart);
    const covered=new Set(chapters.flatMap(c=>c.children||[]));
    const visible=eligible.filter(l=>!covered.has(l.id)).slice(-22);
    if(visible.length)blocks.push('【剧情摘要】\n'+visible.map(l=>(l.time?'['+l.time+'] ':'')+l.summary).join('\n'));
    if(memory.manual?.summaries?.length)blocks.push('【人工补充记忆】\n'+memory.manual.summaries.slice(-12).map(x=>x.text).join('\n'));
  }
  for(const [flag,key,label] of [['inventory','items','物品'],['scenes','scenes','场景'],['characters','characters','人物']]){
    if(!cfg[flag]||!state[key]?.length)continue;
    blocks.push('【'+label+'】\n'+state[key].slice(-45).map(x=>x.manual?x.name:JSON.stringify(x)).join('\n'));
  }
  if(cfg.vector&&vectorHits.length)blocks.push('【相关旧记忆】\n'+vectorHits.map(x=>x.text).join('\n'));
  const budget=Math.max(400,Math.min(18000,Number(cfg.budget)||4500))*3;
  // Keep the newest chunks first when enforcing a character budget.
  let result='',remaining=budget;
  for(const block of blocks.reverse()){
    const safe=block.trim();
    if(!safe)continue;
    const keep=safe.slice(-remaining);
    if(!keep)break;
    result=keep+'\n\n'+result;remaining-=keep.length;
    if(remaining<=0)break;
  }
  return result.trim();
}

/** Resolve AI-message-only keep boundary. User messages are not counted. */
export function recentAiStart(chat,keep=3){
  const indices=[];
  for(let i=0;i<(chat?.length||0);i++)if(messageFingerprint(chat[i]))indices.push(i);
  const n=Math.max(0,Number(keep)||0);
  if(!indices.length)return 0;
  return n===0?chat.length:indices.length<=n?0:indices[indices.length-n];
}
/** Valid root forest, ordered by their earliest source floor rather than creation time. */
export function compressionRoots(memory,chat,level){
  const chapters=validChapters(memory,chat),byId=new Map(chapters.map(c=>[c.id,c]));
  const parented=new Set(chapters.flatMap(c=>c.children));
  function firstFloor(id,seen=new Set()){
    if(seen.has(id))return Infinity;
    seen.add(id);
    if(id.startsWith('floor:'))return Number(id.slice(6));
    const node=byId.get(id);
    return node?Math.min(...node.children.map(x=>firstFloor(x,new Set(seen)))):Infinity;
  }
  if(level===0)return Object.keys(memory.leaves||{}).map(Number)
    .filter(i=>leafValid(memory,chat,i)&&!parented.has('floor:'+i))
    .sort((a,b)=>a-b).map(i=>({id:'floor:'+i,summary:memory.leaves[i].summary,time:memory.leaves[i].time,floor:i}));
  return chapters.filter(c=>c.level===level&&!parented.has(c.id))
    .map(c=>({id:c.id,summary:c.summary,time:c.time,floor:firstFloor(c.id)}))
    .sort((a,b)=>a.floor-b.floor);
}
/** Pure planner. Threshold of zero disables that compression level. */
export function nextCompression(memory,chat,settings){
  const opts=settings.summary||{};
  const thresholds=[
    Number(opts.leafBatchThreshold??opts.chapterEvery??12),
    Number(opts.resummaryThreshold??6),
    Number(opts.higherResummaryThreshold??3)
  ];
  const maxLevel=Math.min(8,Math.max(0,...(memory.chapters||[]).map(c=>Number(c.level)||0)));
  for(let level=0;level<=maxLevel;level++){
    const threshold=Math.trunc(thresholds[Math.min(level,2)]);
    if(!Number.isFinite(threshold)||threshold<2||threshold>100)continue;
    const roots=compressionRoots(memory,chat,level);
    const keep=level===0?Math.max(0,Math.trunc(Number(opts.leafKeepRecent??3))):0;
    if(roots.length<threshold+keep)continue;
    const batch=roots.slice(0,threshold);
    return {level:level+1,children:batch.map(x=>x.id),rows:batch};
  }
  return null;
}
/** Reject changed source or concurrent compression before adding an ancestor. */
export function commitCompression(memory,chat,plan,summary){
  const text=cleanString(summary,12000);
  if(!text)throw Error('压缩结果为空');
  const roots=compressionRoots(memory,chat,plan.level-1);
  const live=new Set(roots.map(x=>x.id));
  if(plan.children.some(id=>!live.has(id)))throw Error('压缩源已变化');
  const next=structuredClone(memory);
  next.chapters.push({
    id:'comp:'+Date.now()+':'+Math.random().toString(36).slice(2,8),
    level:plan.level,children:plan.children,summary:text,updatedAt:Date.now(),
    time:plan.rows.find(x=>x.time)?.time||''
  });
  next.revision++;
  return next;
}

/** Automatic summaries wait until an AI reply is outside the newest N AI replies. */
export function automaticFloorIndices(memory,chat,delay=3){
  const cutoff=recentAiStart(chat,Math.max(0,Math.min(100,Math.trunc(Number(delay)||0))));
  return pendingFloors(memory,chat).filter(index=>index<cutoff);
}
/**
 * Only exclude messages already covered by an unchanged AI leaf. A leaf covers
 * its AI reply and contiguous user inputs since the preceding AI reply.
 * Other system messages, unprocessed AI replies and the recent window are
 * never hidden. The actual chat contents are not deleted.
 */
export function hideReadyIndices(memory,chat,settings){
  const cfg=settings.summary||{};
  if(!cfg.autoHide)return [];
  const preserved=Math.max(0,Number(cfg.keepRecent)||0,Number(cfg.delayFloors)||0);
  const cutoff=recentAiStart(chat,preserved);
  const result=new Set();
  for(let index=0;index<cutoff;index++){
    const m=chat[index],fp=messageFingerprint(m);
    if(!fp || !leafValid(memory,chat,index) || !memory.leaves[index].userFingerprint)continue;
    const fullText=String(m.mes||'');
    const maxChars=Math.max(2000,Math.min(30000,Number(cfg.maxInputChars)||16000));
    const inputs=floorUserMessages(chat,index);
    // Never exclude material the summary request truncated.
    if(fullText.length>maxChars||inputs.map(u=>String(u.mes||'')).join('\n\n').length>6000)continue;
    if(!m.is_system && !m.extra?.story_memory_hidden)result.add(index);
    // The summary request includes user messages belonging to this floor.
    for(let i=index-1;i>=0;i--){
      const user=chat[i];
      if(!user||user.is_system&&!user.extra?.story_memory_hidden)break;
      if(!user.is_user)break;
      if(!user.is_system&&!user.extra?.story_memory_hidden)result.add(i);
    }
  }
  return [...result].sort((a,b)=>a-b);
}

/** A changed AI reply or edited source user text must be restored to the prompt. */
export function staleHiddenIndices(memory,chat){
  const result=new Set();
  for(let i=0;i<(chat?.length||0);i++){
    const m=chat[i];
    if(!m?.is_system||m.is_user||!m.extra?.story_memory_hidden)continue;
    if(leafValid(memory,chat,i))continue;
    result.add(i);
    for(let j=i-1;j>=0;j--){
      const u=chat[j];if(!u?.is_user)break;
      if(u.is_system&&u.extra?.story_memory_hidden)result.add(j);
    }
  }
  return [...result].sort((a,b)=>a-b);
}
