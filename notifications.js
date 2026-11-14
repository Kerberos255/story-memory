import {pendingFloors,taskForFloor,hashText} from './core.js';

export function actionableSummaryFailures(ctx,memory){
  return pendingFloors(memory,ctx?.chat||[]).filter(index=>
    taskForFloor(memory,ctx.chat,index)?.status==='failed');
}

/** Toast once for each actionable failure cycle, even across a page refresh. */
export class SummaryFailureNotifier{
  constructor(onOpen){this.onOpen=onOpen;this.seen=new Map();}
  notify(ctx,memory,toastr){
    const chatId=ctx?.getCurrentChatId?.();
    if(!chatId)return;
    const key='story-memory-toast-v1:'+hashText(String(chatId));
    const failures=actionableSummaryFailures(ctx,memory);
    const current=failures.map(index=>{
      const task=taskForFloor(memory,ctx.chat,index);
      return index+':'+String(task.updatedAt||0)+':'+String(task.code||'');
    });
    let previous=this.seen.get(key);
    if(!previous){
      try{const stored=JSON.parse(globalThis.sessionStorage?.getItem(key)||'[]');
        previous=new Set(Array.isArray(stored)?stored:[]);
      }catch{previous=new Set();}
    }
    const fresh=current.filter(item=>!previous.has(item));
    const active=new Set(current);
    if(typeof toastr?.warning!=='function')return;
    this.seen.set(key,active);
    try{globalThis.sessionStorage?.setItem(key,JSON.stringify([...active]));}catch{}
    if(!fresh.length)return;
    // Do not record a notification as seen when the host cannot display it.
    const selected=fresh.map(item=>Number(item.split(':',1)[0]));
    const message=selected.length===1
      ?'楼层 #'+selected[0]+' 整理失败，自动恢复已停止。点击查看详情。'
      :selected.length+' 个楼层整理失败，需人工检查。点击查看详情。';
    try{
      toastr.warning(message,'剧情记忆 · 需要人工处理',{
        timeOut:12000,extendedTimeOut:5000,closeButton:true,
        onclick:()=>this.onOpen?.()
      });
    }catch{
      for(const item of fresh)active.delete(item);
      this.seen.set(key,active);
      try{globalThis.sessionStorage?.setItem(key,JSON.stringify([...active]));}catch{}
    }
  }
}
