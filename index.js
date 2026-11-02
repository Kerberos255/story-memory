import {defaultSettings,SETTINGS_KEY,readMemory,writeMemory,addManual,editManual,removeManual,editGeneratedLeaf,deleteGeneratedLeaf,resumeGeneratedFloor,editGeneratedChapter,deleteGeneratedChapter,injectionText} from './core.js';
import {SummaryQueue} from './queue.js';
import {listSummaryModels} from './api.js';
import {indexSummaries,recall} from './vector-local.js';
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
      vector:{...base.vector,...raw.vector},prompts:{...base.prompts,...raw.prompts}};
  }else settings=base;
  return settings;
}
function saveSettings(next){
  const ctx=getContext();if(!ctx?.extensionSettings)throw Error('SillyTavern 设置未就绪');
  settings=structuredClone(next);
  ctx.extensionSettings[SETTINGS_KEY]=settings;ctx.saveSettingsDebounced?.();
  inject();
}
function inject(hits=[]){
  const ctx=getContext();if(!ctx?.setExtensionPrompt)return;
  const cfg=getSettings();
  const text=cfg.enabled?injectionText(readMemory(ctx),ctx.chat,cfg,hits):'';
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
async function fetchSummaryModels(config){
  return listSummaryModels(getContext(),config);
}
async function indexNow(){
  const ctx=getContext();if(!ctx)throw Error('聊天未就绪');
  return indexSummaries(ctx,readMemory(ctx),getSettings());
}
async function onGeneration(){
  const ctx=getContext(),cfg=getSettings();
  if(!cfg.enabled||!ctx?.chat?.length)return;
  await queue.restoreStale();
  await queue.hideCompleted();
  if(cfg.autoSummary)queue.enqueueAutomatic(80);
}
async function generateInterceptor(_chat,_contextSize,_abort,type){
  if(['quiet','impersonate','continue'].includes(String(type||'').toLowerCase()))return;
  const ctx=getContext(),cfg=getSettings();
  if(!cfg.enabled||!ctx)return;
  if(!cfg.vector.enabled||!cfg.injection.vector){inject();return;}
  const key=ctx.getCurrentChatId?.();
  const latestUser=[...(ctx.chat||[])].reverse().find(x=>x?.is_user&&!x?.is_system);
  try{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),11500);
    let hits=[];
    try{hits=await recall(ctx,readMemory(ctx),cfg,latestUser?.mes||'',controller.signal);}
    finally{clearTimeout(timer);}
    if(key===getContext()?.getCurrentChatId?.())inject(hits);
  }catch{inject();/* Recall failure must never block RP. */}
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
  ui=mountUI({context:getContext,memory:()=>readMemory(getContext()),settings:getSettings,saveSettings,
    addManual:add,editManual:edit,removeManual:remove,
    editLeaf,deleteLeaf,resumeLeaf,editChapter,deleteChapter,queue,indexNow,fetchSummaryModels});
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
