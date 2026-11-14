import {defaultSettings,SETTINGS_KEY,META_KEY,peekMemory,writeMemory,addManual,editManual,removeManual,editGeneratedLeaf,deleteGeneratedLeaf,resumeGeneratedFloor,editGeneratedChapter,deleteGeneratedChapter,mergeEntities,unmergeEntity,injectionText,rebaseDeletedMessages,correctEntity,clearEntityCorrection,injectionTextWithinBudget} from './core.js';
import {countTokens} from './text-stats.js';
import {SummaryQueue} from './queue.js';
import {listSummaryModels} from './api.js';
import {recall} from './vector-local.js';
import {VectorIndexScheduler} from './vector-index-scheduler.js';
import {selectHistory,historyEvidence,sourcePreview} from './retrieval-local.js';
import {mountUI} from './ui.js';
import {SummaryFailureNotifier,actionableSummaryFailures} from './notifications.js';
import {refreshAfterInstallOrUpdate} from './lifecycle.js';
import {ensureStoryMemoryEntry} from './toolbar.js';
// Pure private ST extension. No external scripts, analytics or dependencies.
let ui,queue,vectorIndexer,failureNotifier,lastChat='',settings;
let lastIndexedRevisionKey='';
let lastInjection={chatId:'',text:'',at:0};
let lastGenerationInjection=null;
let knownChatMessages=[];
let injectionRevision=0;
function rememberChatMessages(){knownChatMessages=[...(getContext()?.chat||[])];}
const getContext=()=>{try{return window.SillyTavern?.getContext?.()||null;}catch{return null;}};
function getSettings(){
  if(settings)return settings;
  const raw=getContext()?.extensionSettings?.[SETTINGS_KEY];
  const base=defaultSettings();
  if(raw&&typeof raw==='object'){
    settings={...base,...raw,api:{...base.api,...raw.api},
      summary:{...base.summary,...raw.summary},extraction:{...base.extraction,...raw.extraction},
      injection:{...base.injection,...raw.injection},
      vector:{...base.vector,...raw.vector},retrieval:{...base.retrieval,...raw.retrieval},
      prompts:{...base.prompts,...raw.prompts}};
  }else settings=base;
  // Retire legacy per-section injection flags. Search toggles now control both
  // retrieval and delivery; stale false flags must never silently block them.
  delete settings.injection.retrieval;
  delete settings.injection.vector;
  return settings;
}
function saveSettings(next){
  const ctx=getContext();if(!ctx?.extensionSettings)throw Error('SillyTavern 设置未就绪');
  settings=structuredClone(next);
  delete settings.injection.retrieval;
  delete settings.injection.vector;
  ctx.extensionSettings[SETTINGS_KEY]=settings;ctx.saveSettingsDebounced?.();
  if(vectorIndexer){
    vectorIndexer.cancel();
    lastIndexedRevisionKey='';
    vectorIndexer.schedule();
  }
  inject();
  queue?.resume();
}
function inject(hits=[],historyHits=[],memory=null){
  ++injectionRevision;
  const ctx=getContext();if(!ctx?.setExtensionPrompt)return;
  const cfg=getSettings();
  const text=cfg.enabled?injectionText(memory||peekMemory(ctx),ctx.chat,cfg,hits,historyHits):'';
  // IN_CHAT = 1, MAX_INJECTION_DEPTH = 10000 in SillyTavern.
  // Depth is counted from the newest turn, so the maximum inserts at the
  // beginning of Chat History (after the preset prompts) even after trimming.
  ctx.setExtensionPrompt('story_memory_injection_v1',text,1,10000,false,0,null);
  lastInjection={chatId:ctx.getCurrentChatId?.()||'',text,at:Date.now()};
}
async function injectForGeneration(hits=[],historyHits=[],memory=null){
  const ctx=getContext();if(!ctx?.setExtensionPrompt)return;
  const revision=++injectionRevision,chatId=ctx.getCurrentChatId?.()||'';
  const cfg=getSettings(),text=cfg.enabled?await injectionTextWithinBudget(
    memory||peekMemory(ctx),ctx.chat,cfg,hits,historyHits,value=>countTokens(ctx,value)):'';
  if(revision!==injectionRevision||chatId!==(getContext()?.getCurrentChatId?.()||''))return;
  ctx.setExtensionPrompt('story_memory_injection_v1',text,1,10000,false,0,null);
  lastInjection={chatId,text,at:Date.now()};
  lastGenerationInjection=lastInjection;
}
function scheduleVectorWhenChanged(force=false){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.()||!vectorIndexer)return;
  const memory=peekMemory(ctx);
  const key=[ctx.groupId||'',ctx.characterId||'',ctx.getCurrentChatId(),memory.revision].join('|');
  if(force||key!==lastIndexedRevisionKey){
    lastIndexedRevisionKey=key;
    vectorIndexer.schedule();
  }
}
function afterQueueChanged(){
  scheduleVectorWhenChanged();
  inject();ui?.refresh();refreshButtonStatus();
  if(!queue?.busy)notifyFailures();
}
function afterMemoryChanged(){
  scheduleVectorWhenChanged(true);
  inject();ui?.refresh(true);refreshButtonStatus();
  void queue?.restoreStale().catch(()=>{}).finally(()=>{
    if(queue?.abort?.signal.aborted)queue.resume();
  });
}
function afterSourceChanged(eventName){
  // Edits, swipe changes and deletions invalidate any in-flight extraction or chapter job.
  queue?.cancel(false);
  vectorIndexer?.cancel();
  const ctx=getContext();
  if(eventName==='MESSAGE_DELETED'&&ctx?.chat&&knownChatMessages.length>ctx.chat.length){
    const before=peekMemory(ctx),rebound=rebaseDeletedMessages(before,knownChatMessages,ctx.chat);
    if(rebound!==before)writeMemory(ctx,rebound);
  }
  rememberChatMessages();
  scheduleVectorWhenChanged(true);
  inject();ui?.refresh();refreshButtonStatus();
  void queue?.restoreStale().catch(()=>{}).finally(()=>queue?.resume());
}
function add(kind,text){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  const next=addManual(peekMemory(ctx),kind,text);writeMemory(ctx,next);afterMemoryChanged();
}
function edit(kind,id,text){
  const ctx=getContext();if(!ctx)throw Error('聊天未就绪');
  writeMemory(ctx,editManual(peekMemory(ctx),kind,id,text));afterMemoryChanged();
}
function remove(kind,id){
  const ctx=getContext();if(!ctx)throw Error('聊天未就绪');
  writeMemory(ctx,removeManual(peekMemory(ctx),kind,id));afterMemoryChanged();
}
function editLeaf(index,changes){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  queue.cancel(false);
  writeMemory(ctx,editGeneratedLeaf(peekMemory(ctx),ctx.chat,index,changes));afterMemoryChanged();
}
function deleteLeaf(index){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  queue.cancel(false);
  writeMemory(ctx,deleteGeneratedLeaf(peekMemory(ctx),ctx.chat,index));afterMemoryChanged();
}
function resumeLeaf(index){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  writeMemory(ctx,resumeGeneratedFloor(peekMemory(ctx),index));afterMemoryChanged();
}
function editChapter(id,summary){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  queue.cancel(false);
  writeMemory(ctx,editGeneratedChapter(peekMemory(ctx),ctx.chat,id,summary));afterMemoryChanged();
}
function deleteChapter(id){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  queue.cancel(false);
  writeMemory(ctx,deleteGeneratedChapter(peekMemory(ctx),ctx.chat,id));afterMemoryChanged();
}
function mergeEntity(kind,fromId,toId){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  queue.cancel(false);
  writeMemory(ctx,mergeEntities(peekMemory(ctx),ctx.chat,kind,fromId,toId));afterMemoryChanged();
}
function unmergeAlias(kind,fromName){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
  queue.cancel(false);
  writeMemory(ctx,unmergeEntity(peekMemory(ctx),kind,fromName));afterMemoryChanged();
}
function saveEntityCorrection(kind,id,values){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('聊天未就绪');
  queue.cancel(false);
  writeMemory(ctx,correctEntity(peekMemory(ctx),ctx.chat,kind,id,values));afterMemoryChanged();
}
function removeEntityCorrection(kind,id){
  const ctx=getContext();if(!ctx?.getCurrentChatId?.())throw Error('聊天未就绪');
  writeMemory(ctx,clearEntityCorrection(peekMemory(ctx),kind,id));afterMemoryChanged();
}
async function fetchSummaryModels(config){
  return listSummaryModels(getContext(),config);
}
async function indexNow(){
  if(!vectorIndexer)throw Error('记忆索引未就绪');
  return vectorIndexer.rebuild();
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
  if(cfg.vector.enabled&&query.trim()){
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
  if(cfg.retrieval?.enabled!==false){
    try{
      const found=selectHistory(current,activeMemory,query,vectors,cfg.retrieval.maxHits);
      const limit=Math.max(0,Math.min(5,Number(cfg.retrieval?.maxSources??3)));
      const sources=limit?historyEvidence(current,activeMemory,found,query,limit):[];
      history=[...sources,...found.filter(row=>row.kind!=='floor'||
        !sources.some(s=>s.key==='source:'+row.sourceIndex))
        .map(row=>({key:row.key,text:'['+
          (row.kind==='floor'?'#'+row.sourceIndex:row.kind==='entity'?'当前实体':
            row.kind==='manual'?'人工记忆':'历史摘要')+'] '+row.summary}))];
    }catch{/* Damaged indexes must not affect roleplay. */}
  }
  await injectForGeneration(cfg.retrieval?.enabled!==false?[]:vectors,history,activeMemory);
}
// Extension lifecycle hooks: installation/update finish before the page reload.
export function storyMemoryOnInstall(){return refreshAfterInstallOrUpdate('安装');}
export function storyMemoryOnUpdate(){return refreshAfterInstallOrUpdate('更新');}
// SillyTavern calls this by manifest name during user generation.
globalThis.storyMemoryGenerationInterceptor=generateInterceptor;
function notifyFailures(){
  const ctx=getContext();
  if(ctx&&!queue?.busy)failureNotifier?.notify(ctx,peekMemory(ctx),globalThis.toastr);
}
function refreshButtonStatus(){
  const entry=typeof document==='undefined'?null:document.getElementById('story-memory-open');
  if(!entry)return;
  const ctx=getContext();
  const failed=actionableSummaryFailures(ctx,peekMemory(ctx)).length;
  const label=queue?.busy?'✦ 剧情记忆 · 整理中':failed?'✦ 剧情记忆 · '+failed+' 项失败':'✦ 剧情记忆';
  const title=failed&&!queue?.busy?'有整理失败的楼层，点击查看':'打开剧情记忆';
  if(entry.textContent!==label)entry.textContent=label;
  if(entry.title!==title)entry.title=title;
}
function ensureButton(){
  const entry=ensureStoryMemoryEntry(document,()=>ui?.open());
  if(entry)refreshButtonStatus();
}
function init(){
  const ctx=getContext();
  if(!ctx?.eventSource||!ctx?.chatMetadata||!ctx?.extensionSettings)return false;
  getSettings();
  vectorIndexer=new VectorIndexScheduler(getContext,getSettings,undefined,
    {onStatus:()=>ui?.updateVectorStatus?.()});
  queue=new SummaryQueue(getContext,getSettings,afterQueueChanged);
  ui=mountUI({context:getContext,memory:()=>peekMemory(getContext()),settings:getSettings,saveSettings,
    addManual:add,editManual:edit,removeManual:remove,
    correctEntity:saveEntityCorrection,clearEntityCorrection:removeEntityCorrection,
    lastInjection:()=>lastGenerationInjection,vectorStatus:()=>vectorIndexer.status(),
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
  failureNotifier=new SummaryFailureNotifier(()=>ui?.showFailures?.());
  lastChat=ctx.getCurrentChatId?.()||'';
  rememberChatMessages();
  const onChatChanged=()=>{const now=getContext()?.getCurrentChatId?.()||'';if(now!==lastChat){lastChat=now;queue.cancel();vectorIndexer.cancel();lastIndexedRevisionKey='';ui?.resetChatView?.();}rememberChatMessages();scheduleVectorWhenChanged();inject();ui?.refresh();refreshButtonStatus();
    void queue.restoreStale().catch(()=>{}).finally(()=>{queue.resume();notifyFailures();});
  };
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED,onChatChanged);
  ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED,()=>{
    rememberChatMessages();
    // Short delay lets the host finish persisting the final AI message.
    setTimeout(()=>void onGeneration(),500);
  });
  for(const name of ['MESSAGE_SENT','MESSAGE_RECEIVED']){
    if(ctx.eventTypes[name])ctx.eventSource.on(ctx.eventTypes[name],rememberChatMessages);
  }
  for(const name of ['MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED']){
    if(ctx.eventTypes[name])ctx.eventSource.on(ctx.eventTypes[name],()=>afterSourceChanged(name));
  }
  ensureButton();inject();scheduleVectorWhenChanged(true);
  queue.resume();notifyFailures();
  // Only rescan the button if the host replaces its quick reply strip.
  let observer=null;
  const attach=()=>{
    const form=document.getElementById('send_form');
    if(!form)return false;
    observer?.disconnect();
    observer=new MutationObserver(()=>ensureButton());
    observer.observe(form,{childList:true,subtree:true});ensureButton();return true;
  };
  attach();
  let tries=0;const timer=setInterval(()=>{
    ensureButton();
    if(!observer)attach();
    if(++tries>60)clearInterval(timer);
  },1000);
  window.addEventListener('pagehide',()=>{queue.cancel();vectorIndexer.cancel();observer?.disconnect();clearInterval(timer);inject([]);});
  return true;
}
function boot(){
  let tries=0;
  const timer=setInterval(()=>{if(init()||++tries>40)clearInterval(timer);},500);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});
else boot();
