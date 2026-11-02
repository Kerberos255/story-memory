import {ApiFault,requestChat,extractJSONObject,buildSummaryMessages,buildChapterMessages} from './api.js';
import {readMemory,writeMemory,messageFingerprint,normalizeDelta,commitLeaf,pendingFloors,validChapters} from './core.js';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class SummaryQueue{
  constructor(getContext,getSettings,onChange){
    this.getContext=getContext;this.getSettings=getSettings;this.onChange=onChange;
    this.jobs=[];this.busy=false;this.abort=null;this.chatKey='';
  }
  currentKey(){return this.getContext()?.getCurrentChatId?.()||'';}
  cancel(){this.jobs=[];this.abort?.abort();this.chatKey=this.currentKey();this.onChange?.();}
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
    this.enqueue(pendingFloors(readMemory(ctx),ctx.chat).slice(0,Math.max(1,limit)));
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
    if(!fingerprint)return;
    let memory=readMemory(ctx);
    if(memory.leaves[index]?.fingerprint===fingerprint)return;
    const settings=this.getSettings();
    const controller=new AbortController();this.abort=controller;
    const maxRetries=Math.max(0,Math.min(2,Number(settings.summary?.retry)||0));
    for(let attempt=0;attempt<=maxRetries;attempt++){
      if(key!==this.currentKey()||controller.signal.aborted)return;
      memory=readMemory(this.getContext());
      memory.tasks[index]={status:'running',attempts:attempt+1,updatedAt:Date.now()};
      writeMemory(this.getContext(),memory);this.onChange?.();
      try{
        const messages=buildSummaryMessages(index,ctx.chat,memory,settings);
        const text=await requestChat(settings.api,messages,ctx,controller.signal);
        const parsed=normalizeDelta(extractJSONObject(text));
        if(key!==this.currentKey()||controller.signal.aborted)return;
        ctx=this.getContext();
        if(messageFingerprint(ctx?.chat?.[index])!==fingerprint)return;
        memory=commitLeaf(readMemory(ctx),index,fingerprint,parsed);
        writeMemory(ctx,memory);this.onChange?.();
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
    const ctx=this.getContext(),settings=this.getSettings();
    if(!ctx||key!==this.currentKey()||!settings.api?.model)return;
    const memory=readMemory(ctx),min=Math.max(3,Math.min(30,Number(settings.summary?.chapterEvery)||8));
    if((memory.chapterPauseUntil||0)>Date.now())return;
    const covered=new Set(validChapters(memory,ctx.chat).flatMap(c=>c.children||[]));
    const eligible=Object.keys(memory.leaves).map(Number).sort((a,b)=>a-b)
      .filter(i=>messageFingerprint(ctx.chat[i])===memory.leaves[i].fingerprint&&!covered.has('floor:'+i));
    if(eligible.length<min)return;
    const group=eligible.slice(0,min),rows=group.map(i=>memory.leaves[i]);
    const controller=new AbortController();this.abort=controller;
    try{
      const content=await requestChat(settings.api,buildChapterMessages(rows,settings),ctx,controller.signal);
      if(key!==this.currentKey()||controller.signal.aborted)return;
      const current=this.getContext(),next=readMemory(current);
      if(group.some(i=>messageFingerprint(current?.chat?.[i])!==next.leaves[i]?.fingerprint))return;
      next.chapters.push({id:'chapter:'+Date.now(),level:1,children:group.map(i=>'floor:'+i),summary:content.slice(0,7000),updatedAt:Date.now()});
      next.revision++;writeMemory(current,next);this.onChange?.();
      await this.maybeHigher(key);
    }catch{
      // A failed optional chapter must never roll back the committed leaf.
      if(key===this.currentKey()){
        const now=this.getContext(),snapshot=readMemory(now);
        snapshot.chapterPauseUntil=Date.now()+10*60*1000;
        writeMemory(now,snapshot);
      }
    }
  }
  async maybeHigher(key){
    const ctx=this.getContext(),cfg=this.getSettings();
    if(!ctx||key!==this.currentKey())return;
    const memory=readMemory(ctx),valid=validChapters(memory,ctx.chat);
    const nested=new Set(valid.filter(c=>c.level===2).flatMap(c=>c.children||[]));
    const chapters=valid.filter(c=>c.level===1&&!nested.has(c.id)).slice(0,4);
    if(chapters.length<4)return;
    const controller=new AbortController();this.abort=controller;
    try{
      const content=await requestChat(cfg.api,buildChapterMessages(chapters,cfg),ctx,controller.signal);
      if(key!==this.currentKey()||controller.signal.aborted)return;
      const current=this.getContext(),next=readMemory(current);
      const ids=new Set(validChapters(next,current.chat).map(c=>c.id));
      if(chapters.some(c=>!ids.has(c.id)))return;
      next.chapters.push({id:'overview:'+Date.now(),level:2,children:chapters.map(c=>c.id),summary:content.slice(0,8000),updatedAt:Date.now()});
      next.revision++;writeMemory(current,next);this.onChange?.();
    }catch{/* Optional overview compression failure is nonfatal. */}
  }
}
