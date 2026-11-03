import {defaultSettings,SETTINGS_KEY,META_KEY,peekMemory,readMemory,writeMemory,addManual,editManual,removeManual,editGeneratedLeaf,deleteGeneratedLeaf,resumeGeneratedFloor,editGeneratedChapter,deleteGeneratedChapter,mergeEntities,unmergeEntity,injectionText} from './core.js';
import {SummaryQueue} from './queue.js';
import {listSummaryModels} from './api.js';
import {indexSummaries,recall} from './vector-local.js';
import {selectHistory,historyEvidence,sourcePreview} from './retrieval-local.js';
import {mountUI} from './ui.js';
// Pure private ST extension. No external scripts, analytics or dependencies.
let ui,queue,lastChat='',settings;
const getContext=()=>{try{return window.SillyTavern?.getContext?.()||null;}catch{return null;}};
function getSettings(){
  if(settings)return settings;
  const raw=getContext()?.extensionSettings?.[SETTINGS_KEY];
  const base=defaultSettings();
  if(raw&&typeof raw==='object'){
    settings={...base,...raw,api:{...base.api,...raw.api},
      summary:{...base.summary,...raw.summary},injection:{...base.injection,...raw.injection},
      vector:{...base.vector,...raw.vector},retrieval:{...base.retrieval,...raw.retrieval},
      prompts:{...base.prompts,...raw.prompts}};
  }else settings=base;
  return settings;
}
function saveSettings(next){
  const ctx=getContext();if(!ctx?.extensionSettings)throw Error('SillyTavern 设置未就绪');
  settings=structuredClone(next);
  ctx.extensionSettings[SETTINGS_KEY]=settings;ctx.saveSettingsDebounced?.();
  inject();
}
function inject(hits=[],historyHits=[],memory=null){
  const ctx=getContext();if(!ctx?.setExtensionPrompt)return;
  const cfg=getSettings();
  const text=cfg.enabled?injectionText(memory||peekMemory(ctx),ctx.chat,cfg,hits,historyHits):'';
  // IN_CHAT = 1, SYSTEM = 0 in SillyTavern script.js.
  ctx.setExtensionPrompt('story_memory_injection_v1',text,1,2,false,0,null);
}
function afterMemoryChanged(){
  inject();ui?.refresh();
  void queue?.restoreStale().then(()=>queue.restoreStale()).catch(()=>{});
}
function add(kind,text){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  const next=addManual(readMemory(ctx),kind,text);writeMemory(ctx,next);afterMemoryChanged();
}
function edit(kind,id,text){
  const ctx=getContext();if(!ctx)throw Error('聊天未就绪');
  writeMemory(ctx,editManual(readMemory(ctx),kind,id,text));afterMemoryChanged();
}
function remove(kind,id){
  const ctx=getContext();if(!ctx)throw Error('聊天未就绪');
  writeMemory(ctx,removeManual(readMemory(ctx),kind,id));afterMemoryChanged();
}
function editLeaf(index,changes){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  queue.cancel(false);
  writeMemory(ctx,editGeneratedLeaf(readMemory(ctx),ctx.chat,index,changes));afterMemoryChanged();
}
function deleteLeaf(index){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  queue.cancel(false);
  writeMemory(ctx,deleteGeneratedLeaf(readMemory(ctx),ctx.chat,index));afterMemoryChanged();
}
function resumeLeaf(index){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  writeMemory(ctx,resumeGeneratedFloor(readMemory(ctx),index));afterMemoryChanged();
}
function editChapter(id,summary){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  queue.cancel(false);
  writeMemory(ctx,editGeneratedChapter(readMemory(ctx),ctx.chat,id,summary));afterMemoryChanged();
}
function deleteChapter(id){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  queue.cancel(false);
  writeMemory(ctx,deleteGeneratedChapter(readMemory(ctx),ctx.chat,id));afterMemoryChanged();
}
function mergeEntity(kind,fromId,toId){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  queue.cancel(false);
  writeMemory(ctx,mergeEntities(readMemory(ctx),ctx.chat,kind,fromId,toId));afterMemoryChanged();
}
function unmergeAlias(kind,fromName){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  queue.cancel(false);
  writeMemory(ctx,unmergeEntity(readMemory(ctx),kind,fromName));afterMemoryChanged();
}
async function fetchSummaryModels(config){
  return listSummaryModels(getContext(),config);
}
async function indexNow(){
  const ctx=getContext();if(!ctx)throw Error('聊天未就绪');
  return indexSummaries(ctx,peekMemory(ctx),getSettings());
}
async function onGeneration(){
  const ctx=getContext(),cfg=getSettings();
  if(!cfg.enabled||!ctx?.chat?.length)return;
  await queue.restoreStale();
  await queue.hideCompleted();
  // New default is on: limit catch-up work per generation to prevent API bursts.
  // Explicit manual backfills keep their own batch size.
  if(cfg.autoSummary)queue.enqueueAutomatic(5);
}
async function generateInterceptor(_chat,_contextSize,_abort,type){
  if(['quiet','impersonate','continue'].includes(String(type||'').toLowerCase()))return;
  const ctx=getContext(),cfg=getSettings();
  if(!cfg.enabled||!ctx)return;
  const key=ctx.getCurrentChatId?.(),memory=peekMemory(ctx);
  const latestUser=[...(ctx.chat||[])].reverse().find(x=>x?.is_user&&!x?.is_system);
  const query=String(latestUser?.mes||'');
  let vectors=[];
  if(cfg.vector.enabled&&cfg.injection.vector&&query.trim()){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),11500);
    try{vectors=await recall(ctx,memory,cfg,query,controller.signal);}
    catch{/* Embedding outages must not prevent local historical search. */}
    finally{clearTimeout(timer);}
  }
  if(key!==getContext()?.getCurrentChatId?.())return;
  const current=getContext();
  if(latestUser&&!current?.chat?.includes(latestUser))return;
  const activeMemory=current?.chatMetadata?.[META_KEY]===memory?memory:peekMemory(current);
  let history=[];
  if(cfg.retrieval?.enabled!==false&&cfg.injection.retrieval!==false){
    try{
      const found=selectHistory(current,activeMemory,query,vectors,cfg.retrieval.maxHits);
      const limit=Math.max(0,Math.min(5,Number(cfg.retrieval?.maxSources??3)));
      const sources=limit?historyEvidence(current,activeMemory,found,query,limit):[];
      history=[...sources,...found.filter(row=>!sources.some(s=>s.key==='source:'+row.sourceIndex))
        .map(row=>({key:row.key,text:'['+(row.kind==='floor'?'#'+row.sourceIndex:'历史摘要')+'] '+row.summary}))];
    }catch{/* Damaged indexes must not affect roleplay. */}
  }
  inject(cfg.retrieval?.enabled!==false&&cfg.injection.retrieval!==false?[]:vectors,history,activeMemory);
}
// SillyTavern calls this by manifest name during user generation.
globalThis.storyMemoryGenerationInterceptor=generateInterceptor;
function ensureButton(){
  const form=document.querySelector('#send_form');if(!form||document.getElementById('story-memory-open'))return;
  let bar=form.querySelector('#qr--bar');
  if(!bar){bar=document.createElement('div');bar.id='qr--bar';bar.className='flex-container flexGap5 story-memory-made-bar';form.prepend(bar);}
  let holder=bar.querySelector('.qr--buttons');
  if(!holder){holder=document.createElement('div');holder.className='qr--buttons';bar.append(holder);}
  const button=document.createElement('div');button.id='story-memory-open';button.className='qr--button menu_button interactable';
  button.tabIndex=0;button.setAttribute('role','button');button.title='打开剧情记忆';button.textContent='✦ 剧情记忆';
  button.addEventListener('click',()=>ui?.open());
  button.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();ui?.open();}});
  holder.append(button);
}
function init(){
  const ctx=getContext();
  if(!ctx?.eventSource||!ctx?.chatMetadata||!ctx?.extensionSettings)return false;
  getSettings();
  queue=new SummaryQueue(getContext,getSettings,afterMemoryChanged);
  ui=mountUI({context:getContext,memory:()=>peekMemory(getContext()),settings:getSettings,saveSettings,
    addManual:add,editManual:edit,removeManual:remove,
    editLeaf,deleteLeaf,resumeLeaf,editChapter,deleteChapter,mergeEntity,unmergeAlias,queue,indexNow,fetchSummaryModels,
    previewHistory:(ctx,memory,previewCfg)=>{
      const settings=previewCfg||getSettings();
      const query=[...(ctx.chat||[])].reverse().find(x=>x?.is_user&&!x?.is_system)?.mes||'';
      const hits=selectHistory(ctx,memory,query,[],settings.retrieval?.maxHits||5);
      const sourceLimit=Math.max(0,Math.min(5,Number(settings.retrieval?.maxSources??3)));
      return [...(sourceLimit?historyEvidence(ctx,memory,hits,query,sourceLimit):[]),
        ...hits.map(x=>({key:x.key,text:'[历史] '+x.summary}))];
    },
    sourcePreview:(ctx,memory,key,limit,offset)=>sourcePreview(ctx,memory,key,limit,offset)});
  lastChat=ctx.getCurrentChatId?.()||'';
  const onChatChanged=()=>{const now=getContext()?.getCurrentChatId?.()||'';if(now!==lastChat){lastChat=now;queue.cancel();}inject();ui?.refresh();};
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED,onChatChanged);
  ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED,()=>{
    // Short delay lets the host finish persisting the final AI message.
    setTimeout(()=>void onGeneration(),500);
  });
  if(ctx.eventTypes.MESSAGE_SWIPED)ctx.eventSource.on(ctx.eventTypes.MESSAGE_SWIPED,afterMemoryChanged);
  if(ctx.eventTypes.MESSAGE_EDITED)ctx.eventSource.on(ctx.eventTypes.MESSAGE_EDITED,afterMemoryChanged);
  ensureButton();inject();
  // Only rescan the button if the host replaces its quick reply strip.
  let observer=null;
  const attach=()=>{
    const form=document.getElementById('send_form');
    if(!form)return false;
    observer?.disconnect();
    observer=new MutationObserver(()=>{if(!document.getElementById('story-memory-open'))ensureButton();});
    observer.observe(form,{childList:true,subtree:true});ensureButton();return true;
  };
  attach();
  let tries=0;const timer=setInterval(()=>{
    if(!document.getElementById('story-memory-open'))ensureButton();
    if(!observer)attach();
    if(++tries>60)clearInterval(timer);
  },1000);
  window.addEventListener('pagehide',()=>{queue.cancel();observer?.disconnect();clearInterval(timer);inject([]);});
  return true;
}
function boot(){
  let tries=0;
  const timer=setInterval(()=>{if(init()||++tries>40)clearInterval(timer);},500);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});
else boot();
