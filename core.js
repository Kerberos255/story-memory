// Independent, dependency-free story memory model.
export const META_KEY = 'story_memory_v1';
export const SETTINGS_KEY = 'story_memory_settings_v1';

export function defaultSettings() {
  return {
    enabled: true, autoSummary: true, api: {name:'摘要 API',mode:'main',url:'',key:'',model:'',headers:{},exclude:[],include:{},maxTokens:null,thinkLevel:'auto',timeout:90,temperature:0},
    summary: {keepRecent:3,autoHide:true,delayFloors:3,leafBatchThreshold:12,leafKeepRecent:3,resummaryThreshold:6,higherResummaryThreshold:3,retry:1},
    extraction: {items:true,scenes:true,characters:true,plans:true},
    injection: {inventory:true,scenes:true,characters:true,plans:true,budget:16000},
    retrieval: {enabled:true,maxHits:5,maxSources:3},
    prompts: {summary:'',summaryFull:'',chapter:'',resummary2:'',overview:''},
    vector: {enabled:false,url:'https://api.siliconflow.cn/v1',key:'',model:'BAAI/bge-m3',topK:5,threshold:0.35,rerankEnabled:false,rerankModel:'BAAI/bge-reranker-v2-m3',rerankCandidates:15}
  };
}
export function freshMemory() {
  return {version:1,leaves:{},chapters:[],skippedFloors:{},skippedPlans:[],entityAliases:{},entityCorrections:{},manual:{summaries:[],items:[],scenes:[],characters:[],plans:[]},tasks:{},revision:0};
}
/** Read-only access to canonical data. Never mutate the returned object. */
export function peekMemory(ctx) {
  if (!ctx?.chatMetadata) return freshMemory();
  const existing=ctx.chatMetadata[META_KEY];
  if (!existing || existing.version!==1 || typeof existing.leaves!=='object') return freshMemory();
  return existing;
}
/** Editable snapshot. Writers operate on a clone before committing metadata. */
export function readMemory(ctx) {
  return structuredClone(peekMemory(ctx));
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
const messageFingerprints=new WeakMap();
export function messageFingerprint(message) {
  if(!message || message.is_user || (message.is_system&&!message.extra?.story_memory_hidden)) return '';
  const text=String(message.mes||''),swipe=String(message.swipe_id??0);
  const cached=messageFingerprints.get(message);
  if(cached?.text===text&&cached.swipe===swipe)return cached.fingerprint;
  const fingerprint=hashText(text+'|swipe='+swipe);
  messageFingerprints.set(message,{text,swipe,fingerprint});
  return fingerprint;
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
/** Return a task only while its saved source still matches the current chat. */
export function taskForFloor(memory,chat,index){
  const task=memory.tasks?.[index];
  if(!task)return null;
  if(task.fingerprint&&task.fingerprint!==messageFingerprint(chat?.[index]))return null;
  if(task.userFingerprint&&task.userFingerprint!==userFingerprint(chat,index))return null;
  return task;
}
export function pendingFloors(memory,chat) {
  const pending=[];
  for(let i=0;i<(chat?.length||0);i++){
    const m=chat[i],fingerprint=messageFingerprint(m);
    if(!fingerprint) continue;
    if(leafValid(memory,chat,i))continue;
    const skip=memory.skippedFloors?.[i];
    if(skip?.fingerprint===fingerprint&&skip.userFingerprint===userFingerprint(chat,i))continue;
    pending.push(i);
  }
  return pending;
}
/** Rebind metadata after a chat splice using message object identity, not text hashes.
 * Ambiguous or reconstructed source objects are dropped conservatively.
 */
export function rebaseDeletedMessages(memory,previousChat,chat){
  if(!Array.isArray(previousChat)||!Array.isArray(chat)||previousChat.length<=chat.length)return memory;
  const at=new Map();
  for(let i=0;i<chat.length;i++)if(chat[i]&&typeof chat[i]==='object')at.set(chat[i],i);
  const next={...memory,leaves:{},skippedFloors:{},chapters:[],tasks:{},skippedPlans:[],
    revision:(Number(memory.revision)||0)+1};
  const ids=new Map();
  for(const [key,leaf] of Object.entries(memory.leaves||{})){
    const old=Number(key),index=at.get(previousChat[old]);
    if(!Number.isInteger(old)||!Number.isInteger(index)||!leaf||next.leaves[index])continue;
    if(leaf.fingerprint!==messageFingerprint(chat[index]))continue;
    if(leaf.userFingerprint&&leaf.userFingerprint!==userFingerprint(chat,index))continue;
    const oldId='floor:'+old,newId='floor:'+index;
    ids.set(oldId,newId);
    next.leaves[index]={...leaf,id:newId,sourceIndex:index};
  }
  for(const [key,skip] of Object.entries(memory.skippedFloors||{})){
    const old=Number(key),index=at.get(previousChat[old]);
    if(!Number.isInteger(index)||!skip||next.skippedFloors[index])continue;
    if(skip.fingerprint!==messageFingerprint(chat[index])||
      skip.userFingerprint!==userFingerprint(chat,index))continue;
    next.skippedFloors[index]={...skip};
  }
  const kept=new Set();
  for(const chapter of memory.chapters||[]){
    if(!Array.isArray(chapter.children)||!chapter.children.length)continue;
    const children=chapter.children.map(id=>id.startsWith('floor:')?ids.get(id):id);
    if(children.some(id=>!id))continue;
    if(chapter.children.some((old,i)=>!old.startsWith('floor:')&&!kept.has(children[i])))continue;
    next.chapters.push({...chapter,children});kept.add(chapter.id);
  }
  return next;
}

const cleanString=(value,limit=3000)=>typeof value==='string'?value.trim().slice(0,limit):'';

/** Normalize explicit story timestamps without inventing an unknown date or time.
 * Ambiguous prose (such as "深夜") is kept unchanged.
 */
export function formatStoryTime(value) {
  const original=typeof value==='string'?value.trim().slice(0,100):'';
  if(!original)return '';
  const plain=original.replace(/[|｜\[\]]/g,' ').replace(/(?:星期|周)[一二三四五六日天]/g,' ')
    .replace(/\s+/g,' ').trim();
  const date=plain.match(/^(\d{4})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})日?(?:\s+|T)?(.*)$/);
  let remainder=plain, prefix='';
  if(date) {
    const y=Number(date[1]),m=Number(date[2]),d=Number(date[3]);
    const parsed=new Date(Date.UTC(y,m-1,d));
    if(parsed.getUTCFullYear()!==y||parsed.getUTCMonth()!==m-1||parsed.getUTCDate()!==d)return original;
    prefix=[String(y),String(m).padStart(2,'0'),String(d).padStart(2,'0')].join('/');
    remainder=date[4]?.trim()||'';
  }
  if(!remainder)return prefix||original;
  const clock=remainder.match(/^(\d{1,2}):(\d{2})(?:\s*(?:-|~|～|–|—|至)\s*(\d{1,2}):(\d{2}))?$/);
  if(!clock)return original;
  const h=Number(clock[1]),min=Number(clock[2]),h2=clock[3]===undefined?null:Number(clock[3]),min2=clock[4]===undefined?null:Number(clock[4]);
  if(h>23||min>59||(h2!==null&&(h2>23||min2>59)))return original;
  const pad=n=>String(n).padStart(2,'0');
  const time=pad(h)+':'+pad(min)+(h2===null?'':'–'+pad(h2)+':'+pad(min2));
  return (prefix?prefix+' · ':'')+time;
}
/** Show an explicitly stated date/time from a summary's opening when a model omitted time. */
export function leadingStoryTime(summary){
  const head=typeof summary==='string'?summary.trim().slice(0,100):'';
  if(!head)return '';
  // Do not infer the year, nor select later appointment times from the story body.
  const numerals='(?:[0-9]{1,2}|[零〇一二两三四五六七八九十廿卅]{1,4})';
  const date='(?:(?:[0-9]{4}|[零〇一二三四五六七八九]{4})年)?'+numerals+'月'+numerals+'日';
  const period='(?:凌晨|清晨|早晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜)';
  const clock='(?:'+period+'\\s*)?'+numerals+'[点时](?:'+numerals+'分|半)?';
  const matched=head.match(new RegExp('^('+date+'(?:\\s*'+clock+')?|'+clock+')(?=[，,。；;、\\s]|$)'));
  return matched?matched[1].replace(/\s+/g,' ').trim():'';
}
export function normalizeDelta(raw,sourceText='',enabledKinds=null) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('摘要 JSON 必须是对象');
  const summary=typeof raw.summary==='string'?raw.summary.trim():'';
  if(!summary)throw Error('缺少 summary');
  if(summary.length>100000)throw Error('模型输出摘要异常冗长');
  const delta={items:[],scenes:[],characters:[],plans:[]};
  // Some models return state changes under delta/entities even when the prompt requests top-level arrays.
  // Prefer the explicit top-level field and normalize both formats through the same validation.
  const candidates=[raw,raw.delta,raw.entities,raw.state].filter(x=>x&&typeof x==='object'&&!Array.isArray(x));
  for(const kind of Object.keys(delta)){
    if(enabledKinds?.[kind]===false)continue;
    const values=candidates.find(x=>x[kind]!==undefined)?.[kind];
    if(values!==undefined&&!Array.isArray(values))throw Error(kind+' 必须为数组');
    for(const item of (values||[]).slice(0,35)){
      if(!item||typeof item!=='object'||Array.isArray(item))continue;
      const op=['add','update','remove'].includes(item.op)?item.op:'update';
      const name=cleanString(item.name,120);
      if(!name)continue;
      const out={op,name};
      if(typeof item.entity_id==='string'&&/^(?:items|scenes|characters|plans):\d+:[a-f0-9]{8}$/.test(item.entity_id))out.entity_id=item.entity_id;
      for(const key of ['description','location','owner','status','relationship','time','kind']) {
        const value=cleanString(item[key],600);if(value)out[key]=value;
      }
      // Evidence is a contiguous quote from this turn, never an invented explanation.
      const evidence=cleanString(item.evidence,160);
      if(evidence&&sourceText&&!sourceText.includes(evidence))continue;
      if(evidence)out.evidence=evidence;
      // Explicit field retirement must cite this turn; omission never means deletion.
      const removable=['description','location','owner','status','relationship','time','kind','presence'];
      if(evidence&&Array.isArray(item.clear_fields)){
        const cleared=[...new Set(item.clear_fields.filter(field=>removable.includes(field)))];
        if(cleared.length)out.clear_fields=cleared;
      }
      if(kind==='characters'&&Array.isArray(item.knowledge)){
        const entries=[];
        for(const note of item.knowledge.slice(0,12)){
          if(!note||typeof note!=='object')continue;
          const fact=cleanString(note.fact,220),stance=cleanString(note.stance,20);
          const quote=cleanString(note.evidence,160);
          const knowledgeOp=note.op==='remove'?'remove':'upsert';
          if(!fact||!['knows','suspects','believes','hides'].includes(stance))continue;
          if(!quote||(sourceText&&!sourceText.includes(quote)))continue;
          const provenance=['firsthand','secondhand','unknown'].includes(note.provenance)?note.provenance:'unknown';
          entries.push({fact,stance,provenance,op:knowledgeOp,...(quote?{evidence:quote}:{})});
        }
        if(entries.length)out.knowledge=entries;
      }
      if(kind==='characters'&&['present','absent','unknown'].includes(item.presence))out.presence=item.presence;
      if(Number.isFinite(item.quantity)&&item.quantity>=0&&item.quantity<=1000000)out.quantity=item.quantity;
      delta[kind].push(out);
    }
  }
  return {summary,time:formatStoryTime(raw.time),location:cleanString(raw.location,180),delta};
}
export function commitLeaf(memory,index,fingerprint,data,userFp='',complete=false) {
  if(!Number.isInteger(index)||index<0||!fingerprint)throw Error('楼层标识无效');
  // Copy only touched containers: old event records are immutable once committed.
  const next={...memory,leaves:{...(memory.leaves||{})},tasks:{...(memory.tasks||{})},
    skippedFloors:{...(memory.skippedFloors||{})}};
  next.leaves[index]={id:'floor:'+index,sourceIndex:index,fingerprint,userFingerprint:userFp,summary:data.summary,
    time:data.time,location:data.location,delta:data.delta,sourceComplete:complete,
    ...(Array.isArray(data.sourceParts)&&data.sourceParts.length>1?{sourceParts:data.sourceParts}:{}),updatedAt:Date.now()};
  delete next.tasks[index];
  if(next.skippedFloors)delete next.skippedFloors[index];
  // Any changed leaf invalidates its ancestor compression chain, not other chapters.
  pruneDependentChapters(next,'floor:'+index);
  next.revision++;
  return next;
}

function pruneDependentChapters(memory,sourceId){
  const invalid=new Set([sourceId]);
  let count=-1;
  while(count!==invalid.size){
    count=invalid.size;
    for(const chapter of memory.chapters||[]){
      if(chapter.children?.some(id=>invalid.has(id)))invalid.add(chapter.id);
    }
  }
  memory.chapters=(memory.chapters||[]).filter(chapter=>!invalid.has(chapter.id));
}
export function editGeneratedLeaf(memory,chat,index,changes){
  if(!leafValid(memory,chat,index))throw Error('楼层内容已变化，请重新摘要');
  const previous=memory.leaves[index];
  const summary=cleanString(changes.summary,8000);
  if(!summary)throw Error('摘要正文不能为空');
  const next=commitLeaf(memory,index,previous.fingerprint,{
    summary,time:formatStoryTime(changes.time),location:cleanString(changes.location,180),
    delta:previous.delta
  },previous.userFingerprint);
  next.leaves[index].edited=true;
  return next;
}
export function deleteGeneratedLeaf(memory,chat,index){
  if(!leafValid(memory,chat,index))throw Error('楼层摘要已经失效');
  const next={...memory,leaves:{...(memory.leaves||{})},
    skippedFloors:{...(memory.skippedFloors||{})}};
  const previous=next.leaves[index];
  delete next.leaves[index];
  pruneDependentChapters(next,'floor:'+index);
  next.skippedFloors??={};
  next.skippedFloors[index]={fingerprint:previous.fingerprint,userFingerprint:previous.userFingerprint||userFingerprint(chat,index)};
  next.revision++;return next;
}
export function resumeGeneratedFloor(memory,index){
  const next={...memory,skippedFloors:{...(memory.skippedFloors||{})}};
  if(!next.skippedFloors?.[index])throw Error('楼层未标记为跳过');
  delete next.skippedFloors[index];
  next.revision++;return next;
}
export function editGeneratedChapter(memory,chat,id,summary){
  const text=cleanString(summary,12000);
  if(!text)throw Error('总结正文不能为空');
  if(!validChapters(memory,chat).some(c=>c.id===id))throw Error('总结源已变化');
  const next=structuredClone(memory),chapter=next.chapters.find(c=>c.id===id);
  chapter.summary=text;chapter.updatedAt=Date.now();chapter.edited=true;
  // Higher-level conclusions were based on the previous text.
  const invalid=new Set([id]);let count=-1;
  while(count!==invalid.size){
    count=invalid.size;
    for(const c of next.chapters)if(c.id!==id&&c.children?.some(child=>invalid.has(child)))invalid.add(c.id);
  }
  next.chapters=next.chapters.filter(c=>c.id===id||!invalid.has(c.id));
  next.revision++;return next;
}
function planSignature(level,children){
  return level+'|'+children.join('|');
}
export function deleteGeneratedChapter(memory,chat,id){
  const original=validChapters(memory,chat).find(c=>c.id===id);
  if(!original)throw Error('总结源已变化');
  const next=structuredClone(memory);
  pruneDependentChapters(next,id);
  next.skippedPlans??=[];
  const signature=planSignature(original.level,original.children);
  if(!next.skippedPlans.includes(signature))next.skippedPlans.push(signature);
  next.skippedPlans=next.skippedPlans.slice(-100);
  next.revision++;return next;
}
export function addManual(memory,kind,entry) {
  if(!['summaries','items','scenes','characters','plans'].includes(kind))throw Error('未知记录类型');
  const text=cleanString(entry,12000);
  if(!text)throw Error('不能保存空白记录');
  const next=structuredClone(memory);
  next.manual[kind]??=[];
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

const entityKinds=['items','scenes','characters','plans'];
export const entityNameKey=name=>String(name||'').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g,'');
function canonicalEntity(memory,kind,name){
  const rules=memory.entityAliases?.[kind]||{};
  let display=String(name||'').trim(),key=entityNameKey(display),steps=0;
  const seen=new Set();
  while(Object.hasOwn(rules,key)&&steps++<20&&!seen.has(key)){
    seen.add(key);
    const target=String(rules[key]?.to||'').trim();
    const next=entityNameKey(target);
    if(!next||seen.has(next))break;
    display=target;key=next;
  }
  return {key,name:display};
}
/** Explicit alias mapping scoped to one chat and one category; never edits leaves. */
export function mergeEntities(memory,chat,kind,fromId,toId){
  if(!entityKinds.includes(kind))throw Error('未知实体类型');
  const rows=deriveState(memory,chat)[kind].filter(x=>!x.manual);
  const source=rows.find(x=>x.entity_id===fromId),target=rows.find(x=>x.entity_id===toId);
  if(!source||!target||source===target)throw Error('请选择两个不同的现有记录');
  const from=entityNameKey(source.name),to=entityNameKey(target.name);
  if(!from||!to||from===to)throw Error('记录名称相同');
  if(['__proto__','constructor','prototype'].includes(from)||['__proto__','constructor','prototype'].includes(to))throw Error('该名称不能建立合并规则');
  const next=structuredClone(memory);
  next.entityAliases??={};
  next.entityAliases[kind]??={};
  next.entityAliases[kind][from]={name:source.name,to:target.name};
  next.revision++;return next;
}
export function unmergeEntity(memory,kind,fromName){
  if(!entityKinds.includes(kind))throw Error('未知实体类型');
  const key=entityNameKey(fromName);
  if(!Object.hasOwn(memory.entityAliases?.[kind]||{},key))throw Error('没有可撤销的合并规则');
  const next=structuredClone(memory);
  delete next.entityAliases[kind][key];
  next.revision++;return next;
}
const editableFields={
  items:['name','description','location','owner','status','quantity'],
  scenes:['name','description','location','status'],
  characters:['name','description','location','status','relationship','presence'],
  plans:['name','description','location','status','time']
};
/** User-confirmed field overrides belong to the same chat; source Delta remains immutable. */
export function correctEntity(memory,chat,kind,id,values,locks=null){
  if(!editableFields[kind]?.length)throw Error('未知实体类型');
  const entity=deriveState(memory,chat)[kind].find(x=>!x.manual&&x.entity_id===id);
  if(!entity)throw Error('实体已失效，请重新打开');
  const previous=memory.entityCorrections?.[kind]?.[id]||{};
  const lockState=locks===null?{...(previous.locks||{})}:Object.fromEntries(
    editableFields[kind].filter(field=>locks?.[field]===true).map(field=>[field,true]));
  const cleaned={};
  for(const field of editableFields[kind]){
    if(!Object.hasOwn(values||{},field))continue;
    const value=values[field];
    const unlockingUnchanged=previous.locks?.[field]===true&&!lockState[field]&&
      String(value??'')===String(previous.values?.[field]??'');
    // Unlocking an unchanged locked value always returns control to extraction,
    // even after a previous save reaffirmed the lock against newer plot facts.
    if(unlockingUnchanged)continue;
    if(field==='quantity'){
      if(value!==null&&value!==''){
        const n=Number(value);if(!Number.isInteger(n)||n<0||n>1e6)throw Error('数量应为非负整数');
        cleaned[field]=n;
      }else cleaned[field]=null;
    }else if(field==='presence'){
      if(!['present','absent','unknown'].includes(String(value)))throw Error('在场状态不合法');
      cleaned[field]=value;
    }else{
      if(typeof value!=='string'||value.length>600)throw Error('字段内容过长或不合法');
      if(field==='name'&&!value.trim())throw Error('名称不能为空');
      cleaned[field]=value.trim();
    }
  }
  // A lock with no submitted override captures the currently displayed value,
  // including an intentionally absent field (represented by null).
  for(const field of editableFields[kind]){
    if(lockState[field]&&!Object.hasOwn(cleaned,field))
      cleaned[field]=Object.hasOwn(entity,field)?entity[field]:null;
  }
  const sources=Object.fromEntries(Object.keys(cleaned).map(field=>
    [field,entity.fieldVersions?.[field]?.at(-1)?.validFromFloor??-1]));
  const old=memory.entityCorrections||{};
  const next={...memory,entityCorrections:{...old,[kind]:{...(old[kind]||{}),
    [id]:{values:cleaned,sources,locks:lockState,updatedAt:Date.now()}}},revision:(Number(memory.revision)||0)+1};
  return next;
}
export function clearEntityCorrection(memory,kind,id){
  if(!editableFields[kind])throw Error('未知实体类型');
  if(!memory.entityCorrections?.[kind]?.[id])return memory;
  const values={...memory.entityCorrections[kind]};delete values[id];
  return {...memory,entityCorrections:{...memory.entityCorrections,[kind]:values},revision:(Number(memory.revision)||0)+1};
}
const STATE_CHECKPOINT_INTERVAL=128;
const stateCheckpointCache=new WeakMap();
function cloneStateEntity(entity){
  return {...entity,history:Array.isArray(entity.history)?[...entity.history]:entity.history};
}
function cloneStateMap(map){
  return new Map([...map].map(([key,value])=>[key,cloneStateEntity(value)]));
}
function makeStateCheckpoint(memory,chat,floors,throughFloor,validCount,aliasKey,state){
  const prefix=[];
  for(const index of floors){
    if(index>throughFloor)break;
    prefix.push({index,ref:memory.leaves[index],valid:leafValid(memory,chat,index)});
  }
  return {
    throughFloor,validCount,aliasKey,prefix,
    sections:Object.fromEntries(entityKinds.map(kind=>[kind,cloneStateMap(state.sections[kind])])),
    archived:Object.fromEntries(entityKinds.map(kind=>[kind,state.archived[kind].map(cloneStateEntity)])),
    ambiguities:Object.fromEntries(entityKinds.map(kind=>[kind,state.ambiguities[kind].slice()])),
    byId:Object.fromEntries(entityKinds.map(kind=>[kind,new Map(state.byId[kind])])),
    knownAliases:Object.fromEntries(entityKinds.map(kind=>[kind,new Map(state.knownAliases[kind])])),
    timeline:state.timeline.slice()
  };
}
function checkpointMatches(checkpoint,memory,chat,floors,aliasKey){
  if(checkpoint.aliasKey!==aliasKey)return false;
  let position=0;
  for(const index of floors){
    if(index>checkpoint.throughFloor)break;
    const previous=checkpoint.prefix[position++];
    if(!previous||previous.index!==index||previous.ref!==memory.leaves[index]||
      previous.valid!==leafValid(memory,chat,index))return false;
  }
  return position===checkpoint.prefix.length;
}
function restoreStateCheckpoint(checkpoint){
  return {
    sections:Object.fromEntries(entityKinds.map(kind=>[kind,cloneStateMap(checkpoint.sections[kind])])),
    archived:Object.fromEntries(entityKinds.map(kind=>[kind,checkpoint.archived[kind].map(cloneStateEntity)])),
    ambiguities:Object.fromEntries(entityKinds.map(kind=>[kind,checkpoint.ambiguities[kind].slice()])),
    byId:Object.fromEntries(entityKinds.map(kind=>[kind,new Map(checkpoint.byId[kind])])),
    knownAliases:Object.fromEntries(entityKinds.map(kind=>[kind,new Map(checkpoint.knownAliases[kind])])),
    timeline:checkpoint.timeline.slice()
  };
}
export function deriveState(memory,chat) {
  const floors=Object.keys(memory.leaves||{}).map(Number).filter(Number.isSafeInteger).sort((a,b)=>a-b);
  const aliasKey=hashText(JSON.stringify(memory.entityAliases||{}));
  const cached=Array.isArray(chat)?stateCheckpointCache.get(chat):null;
  let checkpoints=cached?.aliasKey===aliasKey?cached.checkpoints:[];
  let checkpoint=null;
  for(let i=checkpoints.length-1;i>=0;i--){
    if(checkpointMatches(checkpoints[i],memory,chat,floors,aliasKey)){checkpoint=checkpoints[i];break;}
  }
  checkpoints=checkpoint?checkpoints.filter(x=>x.throughFloor<=checkpoint.throughFloor):[];
  const restored=checkpoint?restoreStateCheckpoint(checkpoint):null;
  const sections=restored?.sections||{items:new Map(),scenes:new Map(),characters:new Map(),plans:new Map()};
  const archived=restored?.archived||{items:[],scenes:[],characters:[],plans:[]};
  const ambiguities=restored?.ambiguities||{items:[],scenes:[],characters:[],plans:[]};
  const byId=restored?.byId||Object.fromEntries(entityKinds.map(kind=>[kind,new Map()]));
  const knownAliases=restored?.knownAliases||Object.fromEntries(entityKinds.map(kind=>[kind,new Map()]));
  const timeline=restored?.timeline||[];
  let validCount=checkpoint?.validCount||0;
  for(const i of floors){
    if(checkpoint&&i<=checkpoint.throughFloor)continue;
    const entry=memory.leaves[i];
    if(!entry || !leafValid(memory,chat,i))continue;
    timeline.push(entry);
    for(const [kind,rows] of Object.entries(entry.delta||{})){
      const map=sections[kind];if(!map||!Array.isArray(rows))continue;
      for(const change of rows){
        const raw=entityNameKey(change.name);if(!raw)continue;
        const canonical=canonicalEntity(memory,kind,change.name);
        // Model-supplied IDs only resolve already established entities in this
        // category; unknown IDs never create new identity associations.
        const linked=change.entity_id&&byId[kind].get(change.entity_id);
        const named=map.get(canonical.key);
        if(change.entity_id&&!linked&&named&&named.entity_id!==change.entity_id){
          ambiguities[kind].push({name:change.name,sourceIndex:i,
            reason:'模型引用的实体 ID 与已有同名对象不同；未自动覆盖旧状态'});
          continue;
        }
        const key=linked||(map.has(canonical.key)?canonical.key:null)||knownAliases[kind].get(raw)||canonical.key;
        if(change.op==='remove'){
          const old=map.get(key);
          if(old){
            byId[kind].delete(old.entity_id);
            const history=[...(old.history||[]),{floor:i,op:'remove',evidence:change.evidence||'',fields:[]}];
            const fieldVersions=Object.fromEntries(Object.entries(old.fieldVersions||{}).map(([field,versions])=>
              [field,versions.map((version,n)=>n===versions.length-1&&version.validToFloor===null?
                {...version,validToFloor:i}:version)]));
            archived[kind].push({...old,history,fieldVersions,retiredAtFloor:i});
          }
          map.delete(key);
          continue;
        }
        const old=map.get(key);
        if(old&&change.op==='add'&&!linked){
          ambiguities[kind].push({name:change.name,sourceIndex:i,
            reason:'已有同名实体却再次声明新增；无法确定是新对象还是重复提取，已保留原状态'});
          continue;
        }
        const entity_id=old?.entity_id||(kind+':'+i+':'+hashText(kind+'|'+key));
        const display=old?.name||canonical.name;
        const aliases=[...(old?.aliases||[])];
        if(raw!==entityNameKey(display)&&!aliases.some(x=>entityNameKey(x)===raw)&&aliases.length<12)
          aliases.push(change.name);
        const previousKnowledge=Array.isArray(old?.knowledge)?old.knowledge:[];
        const knowledge=new Map(previousKnowledge.map(x=>[entityNameKey(x.fact),x]));
        if(kind==='characters')for(const update of change.knowledge||[]){
          const id=entityNameKey(update.fact);
          if(update.op==='remove')knowledge.delete(id);
          else knowledge.set(id,{fact:update.fact,stance:update.stance,provenance:update.provenance||'unknown',evidence:update.evidence||'',sourceIndex:i});
        }
        const retire=change.clear_fields||[];
        const changedFields=Object.keys(change).filter(field=>
          !['op','name','entity_id','evidence','knowledge','clear_fields'].includes(field)&&old?.[field]!==change[field]);
        for(const field of retire)if(!changedFields.includes(field))changedFields.push(field);
        if(Array.isArray(change.knowledge)&&change.knowledge.length)changedFields.push('knowledge');
        const source=[String(chat?.[i]?.mes||''),...floorUserMessages(chat,i).map(m=>String(m.mes||''))].join('\n');
        const evidenceStatus=!change.evidence?'missing':source.includes(change.evidence)?'verified':'mismatch';
        const fieldVersions={...(old?.fieldVersions||{})};
        for(const field of changedFields){
          const existing=fieldVersions[field]||[];
          const previous=existing.map((version,n)=>n===existing.length-1&&version.validToFloor===null?
            {...version,validToFloor:i}:version);
          fieldVersions[field]=retire.includes(field)?previous:[...previous,{
            value:field==='knowledge'?'已更新知情记录':change[field],
            validFromFloor:i,validToFloor:null,evidence:change.evidence||'',evidenceStatus}];
        }
        const history=old?.history||[];
        const nextHistory=!old||changedFields.length?
          [...history,{floor:i,op:old?'update':'add',evidence:change.evidence||'',fields:changedFields}]:history;
        const updated={...old,...change,name:display,entity_id,aliases,op:undefined,sourceIndex:i,history:nextHistory,fieldVersions,evidenceStatus,
          ...(kind==='characters'?{knowledge:[...knowledge.values()]}:{})};
        for(const field of retire)delete updated[field];
        delete updated.clear_fields;
        map.set(key,updated);
        byId[kind].set(entity_id,key);
        if(raw!==key&&!map.has(raw))knownAliases[kind].set(raw,key);
      }
    }
    validCount++;
  }
  // Build one checkpoint at the latest completed 128-floor boundary. Avoid
  // copying the entire accumulated state at every intermediate boundary.
  if(validCount>=STATE_CHECKPOINT_INTERVAL&&
    (!checkpoint||validCount-checkpoint.validCount>=STATE_CHECKPOINT_INTERVAL)){
    const lastIndex=timeline.at(-1)?.sourceIndex;
    if(Number.isSafeInteger(lastIndex))
      checkpoints=[makeStateCheckpoint(memory,chat,floors,lastIndex,validCount,aliasKey,
        {sections,archived,ambiguities,byId,knownAliases,timeline})];
  }
  if(Array.isArray(chat))stateCheckpointCache.set(chat,{aliasKey,checkpoints});
  for(const kind of ['items','scenes','characters','plans']){
    for(const [key,baseEntity] of sections[kind]){
      const entity={...baseEntity};sections[kind].set(key,entity);
      const correction=memory.entityCorrections?.[kind]?.[entity.entity_id];
      if(correction?.values&&typeof correction.values==='object'){
        let applied=0,stale=0;const lockedFields=[],lockConflicts=[];
        for(const [field,value] of Object.entries(correction.values)){
          const sourceVersion=entity.fieldVersions?.[field]?.at(-1)?.validFromFloor??-1;
          const recorded=correction.sources?.[field],locked=correction.locks?.[field]===true;
          const newer=Number.isInteger(recorded)&&sourceVersion>recorded;
          if(locked&&newer&&!Object.is(entity[field]??null,value??null))
            lockConflicts.push({field,floor:sourceVersion,extracted:entity[field]??null});
          // Locked fields retain the user's confirmed value; unlocked corrections yield to newer evidence.
          if(!locked&&newer){stale++;continue;}
          if(value===null)delete entity[field];else entity[field]=value;
          applied++;if(locked)lockedFields.push(field);
        }
        entity.manualCorrection=Boolean(applied);
        entity.correctionStale=Boolean(stale);
        if(lockedFields.length)entity.lockedFields=lockedFields;
        if(lockConflicts.length)entity.lockConflicts=lockConflicts;
      }
    }
    for(const m of memory.manual?.[kind]||[]){
      // Manual notes do not silently overwrite AI-generated structured facts.
      sections[kind].set(m.id,{name:m.text,manual:true});
    }
  }
  const state=Object.fromEntries(Object.entries(sections).map(([k,v])=>[k,[...v.values()]]));
  return {timeline,...state,archived,ambiguities};
}
// Cache only derived injection state. Canonical chat metadata stays the source of truth.
// Every reuse rechecks current swipe/user fingerprints, so source edits invalidate it.
const injectionStateCache=new WeakMap();
function injectionState(memory,chat){
  const keys=Object.keys(memory.leaves||{}),old=injectionStateCache.get(memory);
  const manualKey=hashText(JSON.stringify(memory.manual||{})+'|'+JSON.stringify(memory.entityAliases||{}));
  if(old&&old.chat===chat&&old.revision===memory.revision&&old.keys.length===keys.length&&old.manualKey===manualKey){
    let same=true;
    for(let i=0;i<keys.length;i++){
      const key=keys[i];
      if(old.keys[i]!==key||old.refs[i]!==memory.leaves[key]||old.valid[i]!==leafValid(memory,chat,Number(key))){same=false;break;}
    }
    if(same)return old.state;
  }
  const state=deriveState(memory,chat);
  injectionStateCache.set(memory,{chat,revision:memory.revision,manualKey,keys,
    refs:keys.map(x=>memory.leaves[x]),valid:keys.map(x=>leafValid(memory,chat,Number(x))),state});
  return state;
}
export function injectionText(memory,chat,settings,vectorHits=[],historyHits=[],diagnostics=null,maxChars=null) {
  const state=injectionState(memory,chat),cfg=settings.injection||{},sections=[];
  const add=(title,entries)=>{if(entries.length)sections.push({title,entries});};
  const note=text=>({text:String(text||'').trim(),identity:String(text||'').trim()});
  const entityLine=(entity,historical=false)=>{
    if(entity.manual)return note(entity.name);
    // Keep each JSON record intact. Internal source/identity IDs are not RP facts.
    const {entity_id,aliases,sourceIndex,op,evidence,knowledge,history,fieldVersions,evidenceStatus,identityStatus,manualCorrection,correctionStale,lockedFields,lockConflicts,retiredAtFloor,...publicState}=entity;
    if(Array.isArray(knowledge)&&knowledge.length)
      publicState.knowledge=knowledge.map(x=>({stance:x.stance,fact:x.fact,
        ...(x.provenance==='secondhand'?{来源:'转述信息，角色并非亲历'}:{})}));
    if(publicState.presence==='absent'&&!historical){
      // Preserve identity and relationships but avoid leaking off-stage details as live state.
      delete publicState.description;
      delete publicState.location;
      publicState.在场='当前不在场；不能让此角色直接感知当前场景';
    }
    if(publicState.quantity===null)delete publicState.quantity;
    if(publicState.presence==='unknown')delete publicState.presence;
    if(historical){
      if(publicState.status!==undefined){
        publicState.记录时状态=publicState.status;
        delete publicState.status;
      }
      publicState.状态待核对='后续剧情尚未摘要，可能已完成或取消；不能视为当前待办，以最新原文为准';
    }
    return note(JSON.stringify(publicState));
  };
  // High priority: user-authored memories and currently effective facts.
  add('【人工补充记忆】',(memory.manual?.summaries||[]).slice(-12).map(x=>note(x.text)));
  if(cfg.characters)add('【人物】',(state.characters||[]).slice(-45).map(entityLine));
  if(cfg.plans!==false){
    const closed=/^(?:已完成|完成|已解决|已结束|已取消|取消|已放弃|已终止|已揭晓|done|completed|resolved|cancelled|canceled|closed)$/i;
    const pending=pendingFloors(memory,chat);
    // Include the latest unsummarized user turn: it may resolve a plan before AI replies.
    const lastValidAi=state.timeline.length?state.timeline[state.timeline.length-1].sourceIndex:-1;
    const lastUser=chat.findLastIndex(m=>m?.is_user&&!m.is_system);
    const freshUser=lastUser>lastValidAi?lastUser:-1;
    const latestUnprocessed=Math.max(pending.at(-1)??-1,freshUser);
    // Source order alone determines freshness: never guess plan completion by
    // matching names in recent dialogue, and never present stale status as live.
    const confirmed=[],unverified=[];
    for(const plan of (state.plans||[]).filter(x=>x.manual||!closed.test(String(x.status||'').trim())).slice(-25)){
      if(plan.manual||latestUnprocessed<=(plan.sourceIndex??-1)){
        confirmed.push(entityLine(plan));
      }else{
        unverified.push(entityLine(plan,true));
      }
    }
    add('【计划与伏笔】',confirmed);
    add('【历史计划（状态待核对，不代表当前待办；请以最新剧情为准）】',unverified);
  }
  if(settings.retrieval?.enabled!==false)
    add('【相关历史】',historyHits.map(x=>note(x.text)));
  if(cfg.inventory)add('【物品】',(state.items||[]).slice(-45).map(entityLine));
  if(cfg.scenes)add('【场景】',(state.scenes||[]).slice(-45).map(entityLine));
  const chapters=validChapters(memory,chat);
  const nested=new Set(chapters.filter(c=>c.level>1).flatMap(c=>c.children||[]));
  const covered=new Set(chapters.flatMap(c=>c.children||[]));
  const keepStart=recentAiStart(chat,Math.max(0,Number(settings.summary?.keepRecent??6)));
  const visible=state.timeline.filter(leaf=>leaf.sourceIndex<keepStart&&!covered.has(leaf.id)).slice(-22);
  add('【剧情摘要】',visible.map(x=>({text:(x.time?'['+x.time+'] ':'')+x.summary,identity:x.summary})));
  const roots=chapters.filter(c=>!nested.has(c.id)).slice(-12);
  add('【分层剧情记忆】',roots.map(x=>({text:'[L'+x.level+'] '+x.summary,identity:x.summary})));
  if(settings.vector?.enabled)add('【相关旧记忆】',vectorHits.map(x=>note(x.text)));
  // This is a historical archive, not a turn in the live conversation.
  const archiveHeader='【历史剧情记忆｜非新发生的对话；若与后续实际剧情冲突，以较新的聊天记录为准】\n';
  const budget=Math.max(400,Math.min(18000,Number(cfg.budget)||16000))*3;
  const capacity=maxChars===null?budget:Math.max(0,Math.min(budget,Math.floor(maxChars)));
  let remaining=capacity-archiveHeader.length;
  const result=[],seen=new Set(),breakdown=[];
  // Select entire entries by priority, newest within a section; never slice JSON
  // or prose in the middle. Preserve chronology when presenting chosen entries.
  // Story continuity must not be displaced by a large entity catalog or retrieval dump.
  // Keep the existing per-section newest-first and full-entry budget semantics.
  const priority=new Map([
    ['【剧情摘要】',0],['【分层剧情记忆】',1],['【人工补充记忆】',2],
    ['【计划与伏笔】',3],['【人物】',4],['【历史计划（状态待核对，不代表当前待办；请以最新剧情为准）】',5],
    ['【相关历史】',6],['【物品】',7],['【场景】',8],['【相关旧记忆】',9]
  ]);
  for(const {title,entries} of sections.sort((a,b)=>(priority.get(a.title)??99)-(priority.get(b.title)??99))){
    const extra=(result.length?2:0)+title.length+1;
    if(remaining<=extra){
      breakdown.push({title,selected:0,omitted:entries.length,
        skippedBudget:entries.length,skippedDuplicate:0,skippedEmpty:0,chars:0});
      continue;
    }
    let available=remaining-extra;
    const chosen=[];let skippedBudget=0,skippedDuplicate=0,skippedEmpty=0;
    for(const item of entries.slice().reverse()){
      const text=item.text.trim(),identity=item.identity||text;
      if(!text){skippedEmpty++;continue;}
      if(seen.has(identity)){skippedDuplicate++;continue;}
      if(text.length+1>available){skippedBudget++;continue;}
      chosen.push(text);seen.add(identity);available-=text.length+1;
    }
    const omitted=skippedBudget+skippedDuplicate+skippedEmpty;
    const details={title,selected:chosen.length,omitted,skippedBudget,skippedDuplicate,skippedEmpty};
    if(!chosen.length){breakdown.push({...details,chars:0});continue;}
    const section=title+'\n'+chosen.reverse().join('\n');
    result.push(section);
    remaining-=section.length+(result.length>1?2:0);
    breakdown.push({...details,chars:Array.from(section).length});
  }
  const content=result.join('\n\n');
  const text=content?archiveHeader+content:'';
  if(diagnostics&&typeof diagnostics==='object'){
    diagnostics.budgetTokens=Math.floor(budget/3);
    diagnostics.usedTokens=Math.ceil(text.length/3);
    diagnostics.sections=breakdown;
  }
  return text;
}

/** Check the assembled archive against the host tokenizer before generation.
 * Keep whole memory records and their established priority. A bounded retry
 * shrinks the character candidate pool if the selected model counts more tokens.
 * The synchronous selector remains as a fallback for hosts without a tokenizer.
 */
export async function injectionTextWithinBudget(memory,chat,settings,vectorHits=[],historyHits=[],countTokens,diagnostics=null){
  const budgetTokens=Math.max(400,Math.min(18000,Number(settings.injection?.budget)||16000));
  let maxChars=budgetTokens*3;
  for(let attempt=0;attempt<8;attempt++){
    const usage={};
    const text=injectionText(memory,chat,settings,vectorHits,historyHits,usage,maxChars);
    const measured=text?await countTokens(text):{tokens:0,estimated:false};
    if(!text||measured.tokens<=budgetTokens){
      if(diagnostics)Object.assign(diagnostics,usage,{
        usedTokens:measured.tokens,tokenEstimated:measured.estimated,
        tokenChecks:attempt+1,tokenAdjusted:attempt>0
      });
      return text;
    }
    const ratio=budgetTokens/Math.max(1,measured.tokens);
    maxChars=Math.floor(maxChars*Math.max(.2,Math.min(.8,ratio*.9)));
  }
  // Never inject a known over-budget prompt after repeated unsuccessful checks.
  if(diagnostics)Object.assign(diagnostics,{
    budgetTokens,usedTokens:0,tokenEstimated:false,sections:[],
    tokenChecks:8,tokenAdjusted:true,tokenLimitFailed:true
  });
  return '';
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
  // No arbitrary L9 ceiling. A valid level N requires at least N chapter nodes;
  // bound the scan by the stored node count to tolerate malformed level values.
  const chapters=memory.chapters||[];
  let maxLevel=0;
  for(const chapter of chapters){
    const level=Number(chapter.level);
    if(Number.isSafeInteger(level)&&level>maxLevel&&level<=chapters.length)maxLevel=level;
  }
  for(let level=0;level<=maxLevel;level++){
    const threshold=Math.trunc(thresholds[Math.min(level,2)]);
    if(!Number.isFinite(threshold)||threshold<2||threshold>100)continue;
    const roots=compressionRoots(memory,chat,level);
    const keep=level===0?Math.max(0,Math.trunc(Number(opts.leafKeepRecent??3))):0;
    if(roots.length<threshold+keep)continue;
    for(let offset=0;offset+threshold<=roots.length-keep;offset+=threshold){
      const batch=roots.slice(offset,offset+threshold),children=batch.map(x=>x.id);
      if(memory.skippedPlans?.includes(planSignature(level+1,children)))continue;
      return {level:level+1,children,rows:batch};
    }
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
  const next={...memory,chapters:[...(memory.chapters||[])]};
  next.chapters.push({
    id:'comp:'+Date.now()+':'+Math.random().toString(36).slice(2,8),
    level:plan.level,children:[...plan.children],summary:text,updatedAt:Date.now(),
    time:plan.rows.find(x=>x.time)?.time||''
  });
  next.revision++;
  return next;
}

/** Automatic summaries wait until an AI reply is outside the newest N AI replies. */
export function automaticFloorIndices(memory,chat,delay=3){
  const cutoff=recentAiStart(chat,Math.max(0,Math.min(100,Math.trunc(Number(delay)||0))));
  const now=Date.now();
  return pendingFloors(memory,chat).filter(index=>{
    if(index>=cutoff)return false;
    const task=taskForFloor(memory,chat,index);
    if(task?.status==='failed'||task?.status==='running')return false;
    return task?.status!=='cooldown'||Number(task.nextRetryAt||0)<=now;
  });
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
    const inputs=floorUserMessages(chat,index);
    // Legacy summaries lack a coverage marker, so keep possible old truncations visible.
    if(memory.leaves[index].sourceComplete!==true &&
      (fullText.length>16000||inputs.map(u=>String(u.mes||'')).join('\n\n').length>6000))continue;
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
    if(!m?.is_system||!m.extra?.story_memory_hidden)continue;
    if(m.is_user){
      // Deleting its paired AI turn can otherwise strand a user message invisible.
      let j=i+1;
      while(chat[j]?.is_user)j++;
      if(!chat[j]?.extra?.story_memory_hidden||!leafValid(memory,chat,j))result.add(i);
      continue;
    }
    if(leafValid(memory,chat,i))continue;
    result.add(i);
    for(let j=i-1;j>=0;j--){
      const u=chat[j];if(!u?.is_user)break;
      if(u.is_system&&u.extra?.story_memory_hidden)result.add(j);
    }
  }
  return [...result].sort((a,b)=>a-b);
}
