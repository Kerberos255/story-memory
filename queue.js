import {ApiFault} from './api.js';
import {summarizeFloor,summarizeChapter} from './summary-workflow.js';
import {peekMemory,readMemory,writeMemory,messageFingerprint,userFingerprint,taskForFloor,leafValid,commitLeaf,pendingFloors,automaticFloorIndices,hideReadyIndices,staleHiddenIndices,nextCompression,commitCompression} from './core.js';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const BACKOFF_MS=[30000,120000,300000];
const isTransient=err=>err instanceof ApiFault&&
  (err.code==='network_error'||err.code==='timeout'||[429,500,502,503,504].includes(err.status));
export class SummaryQueue{
  constructor(getContext,getSettings,onChange){
    this.getContext=getContext;this.getSettings=getSettings;this.onChange=onChange;
    this.jobs=[];this.busy=false;this.abort=null;this.chatKey='';
    this.activeIndex=null;this.retryTimer=null;
  }
  currentKey(){return this.getContext()?.getCurrentChatId?.()||'';}
  cancel(notify=true){
    this.jobs=[];this.abort?.abort();
    if(this.retryTimer!==null)clearTimeout(this.retryTimer);
    this.retryTimer=null;this.chatKey=this.currentKey();
    if(notify)this.onChange?.();
  }
  enqueue(indices,automatic=false){
    const ctx=this.getContext();if(!ctx||!this.getSettings().enabled)return;
    const key=this.currentKey();if(!key)return;
    if(this.chatKey!==key)this.cancel();
    for(const index of indices){
      if(!Number.isInteger(index)||index<0||!messageFingerprint(ctx.chat?.[index]))continue;
      if(this.activeIndex===index&&this.busy)continue;
      if(!this.jobs.some(j=>j.index===index))this.jobs.push({index,key,automatic});
    }
    this.onChange?.();void this.drain();
  }
  enqueueMissing(limit=100){
    const ctx=this.getContext();if(!ctx)return;
    this.enqueue(pendingFloors(peekMemory(ctx),ctx.chat).slice(0,Math.max(1,limit)));
  }
  enqueueAutomatic(limit=100){
    const ctx=this.getContext(),cfg=this.getSettings();
    if(!ctx||!cfg.enabled||!cfg.autoSummary)return;
    this.enqueue(automaticFloorIndices(peekMemory(ctx),ctx.chat,cfg.summary?.delayFloors??3).slice(0,Math.max(1,limit)),true);
  }
  /** Recover interrupted tasks without needing another message to be generated. */
  resume(){
    const ctx=this.getContext(),key=this.currentKey();
    if(!ctx||!key||!this.getSettings().enabled)return;
    if(this.chatKey!==key)this.cancel(false);
    const snapshot=peekMemory(ctx),pending=pendingFloors(snapshot,ctx.chat||[]);
    let memory=null;
    for(const i of pending){
      const task=taskForFloor(snapshot,ctx.chat,i);
      if(task?.status!=='running'||(this.busy&&this.activeIndex===i&&!this.abort?.signal.aborted))continue;
      memory??=readMemory(ctx);
      const automatic=Boolean(this.getSettings().autoSummary);
      memory.tasks[i]={...task,status:automatic?'cooldown':'failed',
        code:'interrupted',updatedAt:Date.now(),
        nextRetryAt:automatic?Date.now()+1000:null};
    }
    if(memory){writeMemory(ctx,memory);this.onChange?.();}
    this.enqueueAutomatic(5);
    this.armRetry();
  }
  armRetry(){
    if(this.retryTimer!==null)clearTimeout(this.retryTimer);
    this.retryTimer=null;
    const ctx=this.getContext(),cfg=this.getSettings(),key=this.currentKey();
    if(!ctx||!key||!cfg.enabled||!cfg.autoSummary)return;
    let due=Infinity;
    const memory=peekMemory(ctx),chat=ctx.chat||[];
    const eligible=automaticFloorIndices({...memory,tasks:{}},chat,cfg.summary?.delayFloors??3);
    for(const i of eligible){
      const task=taskForFloor(memory,chat,i);
      if(task?.status==='cooldown'&&Number.isFinite(task.nextRetryAt))
        due=Math.min(due,task.nextRetryAt);
    }
    if(!Number.isFinite(due))return;
    this.retryTimer=setTimeout(()=>{
      this.retryTimer=null;
      if(key!==this.currentKey())return;
      const live=this.getContext(),snapshot=peekMemory(live);
      const dueItems=automaticFloorIndices(snapshot,live.chat||[],cfg.summary?.delayFloors??3)
        .filter(i=>{const task=taskForFloor(snapshot,live.chat,i);
          return task?.status==='cooldown'&&Number(task.nextRetryAt)<=Date.now();})
        .slice(0,5);
      if(dueItems.length)this.enqueue(dueItems,true);
      if(!this.busy)this.armRetry();
    },Math.min(2147483647,Math.max(50,due-Date.now())));
    this.retryTimer.unref?.(); // Do not keep Node test runners alive.
  }
  async restoreStale(key=this.currentKey(),restoreAll=false){
    if(this.restoring)return this.restoring;
    const task=async()=>{
      const ctx=this.getContext();
      if(!ctx||key!==this.currentKey()||typeof ctx.saveChat!=='function')return 0;
      const indices=restoreAll?(ctx.chat||[]).flatMap((msg,i)=>
        msg?.is_system&&msg.extra?.story_memory_hidden?[i]:[]):
        staleHiddenIndices(peekMemory(ctx),ctx.chat||[]);
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
  /** Explicitly restore all previously hidden messages; summaries remain intact. */
  async restoreAllHidden(){
    if(this.getSettings().summary?.autoHide)
      throw Error('请先在设置中关闭「摘要完成后自动隐藏」');
    if(this.restoring)await this.restoring;
    if(this.hiding)await this.hiding;
    return this.restoreStale(this.currentKey(),true);
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
          message.extra={...(message.extra||{}),story_memory_hidden:true};
          message.is_system=true;
          const element=typeof document==='undefined'?null:document.querySelector(`.mes[mesid="${index}"]`);
          const oldAttr=element?.getAttribute('is_system');
          if(element)element.setAttribute('is_system','true');
          changed.push({message,beforeExtra,element,oldAttr});
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
        this.activeIndex=job.index;
        try{await this.summarize(job);}catch{}
        this.activeIndex=null;
        this.onChange?.();
      }
    }finally{this.busy=false;this.activeIndex=null;this.abort=null;this.armRetry();this.onChange?.();}
  }
  async summarize({index,key,automatic=false}){
    let ctx=this.getContext();
    if(!ctx||key!==this.currentKey())return;
    const fingerprint=messageFingerprint(ctx.chat?.[index]);
    const userFp=userFingerprint(ctx.chat,index);
    if(!fingerprint)return;
    let memory=peekMemory(ctx);
    if(leafValid(memory,ctx.chat,index))return;
    const settings=this.getSettings();
    const previous=taskForFloor(memory,ctx.chat,index);
    const autoRetries=automatic?Math.max(0,Number(previous?.autoRetries)||0):0;
    const attempts=automatic?Math.max(0,Number(previous?.attempts)||0):0;
    const controller=new AbortController();this.abort=controller;
    const maxRetries=Math.max(0,Math.min(2,Number(settings.summary?.retry)||0));
    for(let attempt=0;attempt<=maxRetries;attempt++){
      if(key!==this.currentKey()||controller.signal.aborted)return;
      memory=readMemory(this.getContext());
      const savedPart=taskForFloor(memory,ctx.chat,index)?.checkpoint;
      memory.tasks[index]={status:'running',attempts:attempts+attempt+1,
        autoRetries,updatedAt:Date.now(),fingerprint,userFingerprint:userFp,
        ...(savedPart?{checkpoint:savedPart}:{})};
      writeMemory(this.getContext(),memory);this.onChange?.();
      try{
        const parsed=await summarizeFloor(index,ctx,memory,settings,controller.signal,{
          resume:savedPart,
          onCheckpoint:async checkpoint=>{
            if(controller.signal.aborted||key!==this.currentKey())return;
            const liveCtx=this.getContext();
            if(messageFingerprint(liveCtx?.chat?.[index])!==fingerprint||
              userFingerprint(liveCtx.chat,index)!==userFp)return;
            const fresh=readMemory(liveCtx),task=taskForFloor(fresh,liveCtx.chat,index);
            if(task?.status!=='running')return;
            fresh.tasks[index]={...task,checkpoint};
            writeMemory(liveCtx,fresh);
          }
        });
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
        const retryable=isTransient(err);
        if(retryable&&attempt<maxRetries){await sleep(900*(attempt+1));continue;}
        const canRecover=retryable&&settings.autoSummary&&autoRetries<BACKOFF_MS.length;
        memory=readMemory(this.getContext());
        memory.tasks[index]={status:canRecover?'cooldown':'failed',
          code:err instanceof ApiFault?err.code:'unknown',
          httpStatus:err instanceof ApiFault?err.status||null:null,
          attempts:attempts+attempt+1,autoRetries:canRecover?autoRetries+1:autoRetries,
          updatedAt:Date.now(),fingerprint,userFingerprint:userFp,
          nextRetryAt:canRecover?Date.now()+BACKOFF_MS[autoRetries]:null,
          ...(taskForFloor(memory,ctx.chat,index)?.checkpoint
            ?{checkpoint:taskForFloor(memory,ctx.chat,index).checkpoint}:{})};
        writeMemory(this.getContext(),memory);this.onChange?.();return;
      }
    }
  }
  async retryChapters(){
    if(this.busy)throw Error('正在整理楼层，请稍后重试分层压缩');
    const key=this.currentKey(),ctx=this.getContext();
    if(!ctx||!key)throw Error('请先打开聊天');
    const memory=readMemory(ctx);
    memory.chapterPauseUntil=0;
    delete memory.chapterError;
    writeMemory(ctx,memory);this.onChange?.();
    await this.maybeChapter(key);
    const current=this.getContext();
    return this.currentKey()===key&&Boolean(current)&&!peekMemory(current).chapterError;
  }
  async maybeChapter(key){
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
        memory.chapterPauseUntil=0;delete memory.chapterError;
        writeMemory(latest,memory);this.onChange?.();
      }catch(error){
        if(key!==this.currentKey()||controller.signal.aborted)return;
        const latest=this.getContext(),snapshot=readMemory(latest);
        snapshot.chapterPauseUntil=Date.now()+10*60*1000;
        snapshot.chapterError={
          code:error instanceof ApiFault?error.code:'chapter_error',
          message:error instanceof ApiFault?error.message:'分层压缩未完成，请检查摘要模型及输出设置',
          updatedAt:Date.now()
        };
        writeMemory(latest,snapshot);this.onChange?.();
        return;
      }
    }
  }
}
