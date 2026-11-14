// SillyTavern calls the install/update hooks after the extension files are written.
let refreshPending=false;
const REFRESH_DELAY=1400;
const CHECK_INTERVAL=1200;

export function canSafelyReload({doc,isGenerating}){
  if(typeof isGenerating!=='function')return false;
  try{if(isGenerating())return false;}catch{return false;}
  if(!doc||doc.visibilityState==='hidden')return false;
  const input=doc.querySelector?.('#send_textarea');
  if(String(input?.value??input?.textContent??'').trim())return false;
  if(doc.querySelector?.('dialog[open]'))return false;
  const focused=doc.activeElement;
  if(focused?.isContentEditable)return false;
  if(['INPUT','TEXTAREA','SELECT'].includes(String(focused?.tagName||'').toUpperCase())&&focused!==input)return false;
  return true;
}

/** Schedule once; leave drafts and in-flight generation untouched. */
export async function refreshAfterInstallOrUpdate(reason,{doc=globalThis.document,win=globalThis.window,
  toast=globalThis.toastr,isGenerating=null,interval=CHECK_INTERVAL,delay=REFRESH_DELAY}={}){
  if(refreshPending||!doc||!win?.location?.reload)return false;
  if(typeof isGenerating!=='function'){
    try{({isGenerating}=await import('/script.js'));}catch{}
  }
  if(refreshPending)return false;
  refreshPending=true;
  let timeout=null,intervalId=null,notice=null,noticeShown=false,done=false;
  const clear=()=>{
    if(timeout!==null){win.clearTimeout(timeout);timeout=null;}
    if(intervalId!==null){win.clearInterval(intervalId);intervalId=null;}
    if(notice){try{toast?.clear?.(notice);}catch{}notice=null;}
  };
  const doReload=()=>{
    if(done||!canSafelyReload({doc,isGenerating}))return false;
    done=true;clear();
    win.location.reload();
    return true;
  };
  const check=()=>{
    if(done||doReload())return;
    if(!noticeShown&&typeof toast?.info==='function'){
      noticeShown=true;
      const message='有未发送内容或正在生成时不会自动刷新。准备好后会自动刷新；点击此提示可手动确认。';
      notice=toast.info(message,'剧情记忆 · '+reason+'完成',{timeOut:0,extendedTimeOut:0,closeButton:true,
        onclick:()=>{
          if(doReload())return;
          if(win.confirm?.('刷新会丢失当前未保存的输入或生成结果，仍要刷新吗？')){
            clear();win.location.reload();
          }
        }});
    }
  };
  const onPageHide=()=>{clear();refreshPending=false;};
  win.addEventListener?.('pagehide',onPageHide,{once:true});
  timeout=win.setTimeout(()=>{
    timeout=null;check();
    if(!done)intervalId=win.setInterval(check,interval);
  },delay);
  return true;
}
