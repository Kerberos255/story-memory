import {ApiFault} from './api.js';
import {summarizeFloor,summarizeChapter} from './summary-workflow.js';
import {peekMemory,readMemory,writeMemory,messageFingerprint,userFingerprint,leafValid,commitLeaf,pendingFloors,automaticFloorIndices,hideReadyIndices,staleHiddenIndices,nextCompression,commitCompression} from './core.js';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class SummaryQueue{
  constructor(getContext,getSettings,onChange){
    this.getContext=getContext;this.getSettings=getSettings;this.onChange=onChange;
    this.jobs=[];this.busy=false;this.abort=null;this.chatKey='';
  }
  currentKey(){return this.getContext()?.getCurrentChatId?.()||'';}
  cancel(notify=true){this.jobs=[];this.abort?.abort();this.chatKey=this.currentKey();if(notify)this.onChange?.();}
  enqueue(indices){
    const ctx=this.getContext();if(!ctx||!this.getSettings().enabled)return;
    const key=this.currentKey();if(!key)return;
    if(this.chatKey!==key)this.cancel();
    for(const index of indices){
      if(!Number.isInteger(index)||index<0||!messageFingerprint(ctx.chat?.[index]))continue;
      if(!this.jobs.some(j=>j.index===index))this.jobs.push({index,key});
    }
    this.onChange?.();void this.drain();
  }
  enqueueMissing(limit=100){
    const ctx=this.getContext();if(!ctx)return;
    this.enqueue(pendingFloors(peekMemory(ctx),ctx.chat).slice(0,Math.max(1,limit)));
  }
  enqueueAutomatic(limit=100){
    const ctx=this.getContext();if(!ctx||!this.getSettings().autoSummary)return;
    this.enqueue(automaticFloorIndices(peekMemory(ctx),ctx.chat,this.getSettings().summary?.delayFloors??3).slice(0,Math.max(1,limit)));
  }
  async restoreStale(key=this.currentKey()){
    if(this.restoring)return this.restoring;
    const task=async()=>{
      const ctx=this.getContext();
      if(!ctx||key!==this.currentKey()||typeof ctx.saveChat!=='function')return 0;
      const indices=staleHiddenIndices(peekMemory(ctx),ctx.chat||[]);
      if(!indices.length)return 0;
      const changed=[];
      try{
        for(const index of indices){
          if(key!==this.currentKey())throw Error('聊天已切换');
          const message=ctx.chat[index];
          if(!message?.is_system||!message.extra?.story_memory_hidden)continue;
          const beforeExtra=message.extra;
          message.extra={...beforeExtra};delete message.extra.story_memory_hidden;
          message.is_system=false;
          const element=typeof document==='undefined'?null:document.querySelector(`.mes[mesid="${index}"]`);
          const oldAttr=element?.getAttribute('is_system');
          if(element)element.setAttribute('is_system','false');
          changed.push({message,beforeExtra,element,oldAttr});
        }
        if(!changed.length)return 0;
        await ctx.saveChat();this.onChange?.();
        return changed.length;
      }catch{
        for(const item of changed){
          item.message.is_system=true;
          item.message.extra=item.beforeExtra;
          if(item.element){
            if(item.oldAttr===null)item.element.removeAttribute('is_system');
            else item.element.setAttribute('is_system',item.oldAttr);
          }
        }
        this.onChange?.();
        return 0;
      }
    };
    this.restoring=task();
    try{return await this.restoring;}finally{this.restoring=null;}
  }
  async hideCompleted(key=this.currentKey()){
    if(this.hiding)return this.hiding;
    const task=async()=>{
      const ctx=this.getContext();
      if(!ctx||key!==this.currentKey()||!this.getSettings().enabled||!this.getSettings().summary?.autoHide)return 0;
      if(typeof ctx.saveChat!=='function')return 0;
      const indices=hideReadyIndices(peekMemory(ctx),ctx.chat||[],this.getSettings());
      if(!indices.length)return 0;
      const changed=[];
      try{
        for(const index of indices){
          if(key!==this.currentKey())throw Error('聊天已切换');
          const message=ctx.chat[index];
          if(!message||message.is_system)continue;
          // Mark our excluded AI replies, preserving their swipe fingerprints.
          const beforeExtra=message.extra;
          const beforeFlag=message.extra?.story_memory_hidden;
          message.extra={...(message.extra||{}),story_memory_hidden:true};
          message.is_system=true;
          const element=typeof document==='undefined'?null:document.querySelector(`.mes[mesid="${index}"]`);
          const oldAttr=element?.getAttribute('is_system');
          if(element)element.setAttribute('is_system','true');
          changed.push({message,beforeExtra,beforeFlag,element,oldAttr});
        }
        if(!changed.length)return 0;
        await ctx.saveChat();
        this.hideError='';
        this.onChange?.();
        return changed.length;
      }catch{
        // Save failed or the user changed chats. Never silently leave excluded
        // messages in memory when their persisted chat state is uncertain.
        for(const item of changed){
          item.message.is_system=false;
          item.message.extra=item.beforeExtra;
          if(item.element){
            if(item.oldAttr===null)item.element.removeAttribute('is_system');
            else item.element.setAttribute('is_system',item.oldAttr);
          }
        }
        this.hideError='自动隐藏未保存，请检查当前聊天';
        this.onChange?.();
        return 0;
      }
    };
    this.hiding=task();
    try{return await this.hiding;}finally{this.hiding=null;}
  }
  async drain(){
    if(this.busy)return;
    this.busy=true;
    try{
      while(this.jobs.length){
        const job=this.jobs.shift();
        if(job.key!==this.currentKey())continue;
        try{await this.summarize(job);}catch{}
        this.onChange?.();
      }
    }finally{this.busy=false;this.abort=null;this.onChange?.();}
  }
  async summarize({index,key}){
    let ctx=this.getContext();
    if(!ctx||key!==this.currentKey())return;
    const fingerprint=messageFingerprint(ctx.chat?.[index]);
    const userFp=userFingerprint(ctx.chat,index);
    if(!fingerprint)return;
    let memory=peekMemory(ctx);
    if(leafValid(memory,ctx.chat,index))return;
    const settings=this.getSettings();
    const controller=new AbortController();this.abort=controller;
    const maxRetries=Math.max(0,Math.min(2,Number(settings.summary?.retry)||0));
    for(let attempt=0;attempt<=maxRetries;attempt++){
      if(key!==this.currentKey()||controller.signal.aborted)return;
      memory=readMemory(this.getContext());
      memory.tasks[index]={status:'running',attempts:attempt+1,updatedAt:Date.now()};
      writeMemory(this.getContext(),memory);this.onChange?.();
      try{
        const parsed=await summarizeFloor(index,ctx,memory,settings,controller.signal);
        if(key!==this.currentKey()||controller.signal.aborted)return;
        ctx=this.getContext();
        if(messageFingerprint(ctx?.chat?.[index])!==fingerprint||userFingerprint(ctx.chat,index)!==userFp)return;
        memory=commitLeaf(peekMemory(ctx),index,fingerprint,parsed,userFp,true);
        writeMemory(ctx,memory);this.onChange?.();
        await this.hideCompleted(key);
        await this.maybeChapter(key);
        return;
      }catch(err){
        if(key!==this.currentKey()||controller.signal.aborted)return;
        const retryable=err instanceof ApiFault&&
          (err.code==='network_error'||err.code==='timeout'||[429,500,502,503,504].includes(err.status));
        if(retryable&&attempt<maxRetries){await sleep(900*(attempt+1));continue;}
        memory=readMemory(this.getContext());
        memory.tasks[index]={status:'failed',code:err instanceof ApiFault?err.code:'unknown',attempts:attempt+1,updatedAt:Date.now()};
        writeMemory(this.getContext(),memory);this.onChange?.();return;
      }
    }
  }
  async maybeChapter(key){
    // Retain the former method name for existing callers, now handles all levels.
    const ctx=this.getContext(),cfg=this.getSettings();
    if(!ctx||key!==this.currentKey())return;
    let memory=peekMemory(ctx);
    if((memory.chapterPauseUntil||0)>Date.now())return;
    for(let count=0;count<5;count++){
      if(key!==this.currentKey())return;
      const current=this.getContext();
      const plan=nextCompression(peekMemory(current),current.chat,cfg);
      if(!plan)return;
      const controller=new AbortController();this.abort=controller;
      try{
        const kind=plan.level===1?'chapter':plan.level===2?'resummary2':'overview';
        const content=await summarizeChapter(plan.rows,cfg,kind,current,controller.signal);
        if(key!==this.currentKey()||controller.signal.aborted)return;
        const latest=this.getContext();
        memory=commitCompression(peekMemory(latest),latest.chat,plan,content);
        writeMemory(latest,memory);this.onChange?.();
      }catch{
        if(key!==this.currentKey()||controller.signal.aborted)return;
        const latest=this.getContext(),snapshot=readMemory(latest);
        snapshot.chapterPauseUntil=Date.now()+10*60*1000;
        writeMemory(latest,snapshot);
        return;
      }
    }
  }
}
