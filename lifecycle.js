// SillyTavern calls install/update hooks after writing the extension files.
let refreshPending=false;
const REFRESH_DELAY=1400;
const CHECK_INTERVAL=1200;

/** Identify *only* SillyTavern's extension manager, not arbitrary dialogs. */
function isExtensionManager(dialog){
  return Boolean(dialog?.querySelector?.('.extensions_info'));
}

/** Human-readable reason for delaying a reload; null means safe. */
export function reloadBlockReason({doc,isGenerating,getExtensionBlockReason}={}){
  if(typeof isGenerating!=='function')return '无法确认酒馆生成状态';
  try{if(isGenerating())return '酒馆正在生成回复';}
  catch{return '无法确认酒馆生成状态';}
  if(!doc)return '酒馆页面尚未就绪';
  if(doc.visibilityState==='hidden')return '酒馆页面当前不可见';
  const input=doc.querySelector?.('#send_textarea');
  if(String(input?.value??input?.textContent??'').trim())return '发送框有未发送内容';

  // The manager stays open during the update hook, and the host may reopen it.
  // Other dialogs, including confirmations, still block reload.
  const dialogs=doc.querySelectorAll?
    [...doc.querySelectorAll('dialog[open]')]:
    [doc.querySelector?.('dialog[open]')].filter(Boolean);
  const managers=dialogs.filter(isExtensionManager);
  if(dialogs.some(dialog=>!managers.includes(dialog)))return '还有其他弹窗打开';

  const focused=doc.activeElement;
  const managerHasFocus=managers.some(dialog=>dialog.contains?.(focused));
  if(!managerHasFocus&&focused?.isContentEditable)return '有正在编辑的内容';
  if(!managerHasFocus&&focused!==input&&
    ['INPUT','TEXTAREA','SELECT'].includes(String(focused?.tagName||'').toUpperCase()))
    return '有尚未退出的输入控件';

  if(typeof getExtensionBlockReason==='function'){
    try{
      const reason=getExtensionBlockReason();
      if(reason)return typeof reason==='string'?reason:'剧情记忆正在执行任务';
    }catch{return '无法确认剧情记忆任务状态';}
  }
  return null;
}

export function canSafelyReload(options){
  return reloadBlockReason(options)===null;
}

/** Poll until safe; only a deliberate confirmation can override a busy state. */
export async function refreshAfterInstallOrUpdate(reason,{doc=globalThis.document,win=globalThis.window,
  toast=globalThis.toastr,isGenerating=null,getExtensionBlockReason,
  interval=CHECK_INTERVAL,delay=REFRESH_DELAY}={}){
  if(refreshPending||!doc||!win?.location?.reload)return false;
  if(typeof isGenerating!=='function'){
    try{({isGenerating}=await import('/script.js'));}catch{}
  }
  if(refreshPending)return false;
  refreshPending=true;
  let timeout=null,intervalId=null,notice=null,noticeReason=null,done=false;
  const clear=()=>{
    if(timeout!==null){win.clearTimeout(timeout);timeout=null;}
    if(intervalId!==null){win.clearInterval(intervalId);intervalId=null;}
    if(notice){try{toast?.clear?.(notice);}catch{}notice=null;}
  };
  const state=()=>reloadBlockReason({doc,isGenerating,getExtensionBlockReason});
  const doReload=()=>{
    if(done||state()!==null)return false;
    done=true;clear();
    win.location.reload();
    return true;
  };
  const check=()=>{
    if(done||doReload())return;
    const blockReason=state();
    if(!blockReason||doc.visibilityState==='hidden'||typeof toast?.info!=='function')return;
    if(blockReason===noticeReason)return;
    if(notice){try{toast?.clear?.(notice);}catch{}notice=null;}
    noticeReason=blockReason;
    notice=toast.info('自动刷新暂缓：'+blockReason+'。条件恢复后将自动刷新；点击此提示可手动确认。',
      '剧情记忆 · '+reason+'完成',{timeOut:0,extendedTimeOut:0,closeButton:true,
        onclick:()=>{
          if(doReload())return;
          if(win.confirm?.('仍有未完成的操作或未保存的输入。强制刷新可能丢失进度，确定刷新吗？')){
            done=true;clear();win.location.reload();
          }
        }});
  };
  win.addEventListener?.('pagehide',()=>{clear();refreshPending=false;},{once:true});
  timeout=win.setTimeout(()=>{
    timeout=null;check();
    if(!done)intervalId=win.setInterval(check,interval);
  },delay);
  return true;
}
