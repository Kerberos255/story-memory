import {peekMemory} from './core.js';
import {indexSummaries} from './vector-local.js';

const DEFAULT_DELAY=1800;
const DEFAULT_BATCH=18;
const DEFAULT_PACE=3500;
const RETRY_DELAY=60000;

/** Background embedding maintenance. Never blocks story generation or summary commits. */
export class VectorIndexScheduler {
  constructor(getContext,getSettings,runIndex=indexSummaries,options={}){
    this.getContext=getContext;this.getSettings=getSettings;this.runIndex=runIndex;
    this.delay=options.delay??DEFAULT_DELAY;
    this.batch=options.batch??DEFAULT_BATCH;
    this.pace=options.pace??DEFAULT_PACE;
    this.onStatus=options.onStatus||(()=>{});
    this.timer=null;this.task=null;this.abort=null;this.dirty=false;
    this.retryAfter=0;this.lastError='';this.lastCount=0;
  }
  enabled(){const cfg=this.getSettings();return Boolean(cfg?.enabled&&cfg.vector?.enabled);}
  status(){
    return {enabled:this.enabled(),busy:Boolean(this.task),pending:this.dirty,
      error:this.lastError,lastCount:this.lastCount};
  }
  report(){this.onStatus(this.status());}
  cancel(){
    if(this.timer!==null){clearTimeout(this.timer);this.timer=null;}
    this.abort?.abort();this.dirty=false;this.retryAfter=0;this.lastError='';
    this.report();
  }
  schedule(delay=this.delay){
    if(!this.enabled()){this.cancel();return;}
    this.dirty=true;
    if(this.task)return;
    if(this.timer!==null)clearTimeout(this.timer);
    this.timer=setTimeout(()=>{this.timer=null;void this.flush();},Math.max(delay,this.retryAfter-Date.now(),0));
    this.report();
  }
  async flush(){
    if(this.task||!this.dirty||!this.enabled())return;
    const ctx=this.getContext(),settings=this.getSettings();
    if(!ctx?.getCurrentChatId?.()||!ctx.chatMetadata)return;
    const memory=peekMemory(ctx);
    this.dirty=false;
    const abort=new AbortController();this.abort=abort;
    const job=(async()=>{
      try{
        const count=await this.runIndex(ctx,memory,settings,abort.signal,{full:true,maxRecords:this.batch});
        if(!abort.signal.aborted){
          this.lastCount=count;this.lastError='';this.retryAfter=0;
          if(count>=this.batch)this.dirty=true;
        }
      }catch(error){
        if(!abort.signal.aborted){
          this.lastError=String(error?.message||'向量索引更新失败');
          this.retryAfter=Date.now()+RETRY_DELAY;
        }
      }
    })();
    this.task=job;this.report();
    try{await job;}finally{
      if(this.abort===abort)this.abort=null;
      if(this.task===job)this.task=null;
      if(this.dirty&&this.enabled())this.schedule(this.pace);
      this.report();
    }
  }
  async rebuild(){
    this.cancel();
    if(this.task)await this.task;
    const ctx=this.getContext(),settings=this.getSettings();
    if(!ctx?.getCurrentChatId?.())throw Error('请先打开聊天');
    if(!this.enabled())return 0;
    const abort=new AbortController();this.abort=abort;
    const job=this.runIndex(ctx,peekMemory(ctx),settings,abort.signal);
    this.task=job;this.report();
    try{
      const count=await job;
      if(abort.signal.aborted)throw Error('索引已取消');
      this.lastCount=count;this.retryAfter=0;this.lastError='';
      return count;
    }catch(error){
      if(!abort.signal.aborted)this.lastError=String(error?.message||'向量索引更新失败');
      throw error;
    }finally{
      if(this.task===job)this.task=null;
      if(this.abort===abort)this.abort=null;
      if(this.dirty&&this.enabled())this.schedule(this.pace);
      this.report();
    }
  }
}
