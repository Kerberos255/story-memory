import test from 'node:test';
import assert from 'node:assert/strict';
import {canSafelyReload,reloadBlockReason,refreshAfterInstallOrUpdate} from '../lifecycle.js';
import {readFileSync} from 'node:fs';

function harness(){
  let nextId=1,reloads=0,confirmResult=false,generating=false,draft='';
  const timeouts=new Map(),intervals=new Map(),events=new Map(),toasts=[];
  let input={value:''},activeElement=null;
  const managerDialog={
    querySelector:selector=>selector==='.extensions_info'?{}:null,
    contains:element=>Boolean(element?.insideManager)
  };
  const otherDialog={querySelector:()=>null};
  const doc={visibilityState:'visible',get activeElement(){return activeElement;},
    querySelectorAll:selector=>selector==='dialog[open]'?
      [...(doc.managerOpen?[managerDialog]:[]),...(doc.dialogOpen?[otherDialog]:[])]:[],
    querySelector:selector=>selector==='#send_textarea'?input:null};
  const win={
    location:{reload:()=>{reloads++;}},
    setTimeout:(fn)=>{const id=nextId++;timeouts.set(id,fn);return id;},
    clearTimeout:(id)=>timeouts.delete(id),
    setInterval:(fn)=>{const id=nextId++;intervals.set(id,fn);return id;},
    clearInterval:(id)=>intervals.delete(id),
    addEventListener:(name,fn)=>events.set(name,fn),
    confirm:()=>confirmResult
  };
  const toast={info:(message,title,options)=>{const item={message,title,options};toasts.push(item);return item;},
    clear:()=>{}};
  return {doc,win,toast,toasts,events,
    tickTimeouts:()=>{for(const [id,fn] of [...timeouts]){timeouts.delete(id);fn();}},
    tickIntervals:()=>{for(const fn of [...intervals.values()])fn();},
    reset:()=>events.get('pagehide')?.(),
    generation:(value)=>{generating=value;},isGenerating:()=>generating,
    draft:(value)=>{input.value=value;},
    focus:(value)=>{activeElement=value;},
    manager:(value)=>{doc.managerOpen=value;},
    confirm:(value)=>{confirmResult=value;},
    get reloads(){return reloads;},
    get intervalCount(){return intervals.size;},
    get timeoutCount(){return timeouts.size;}
  };
}

test('refresh guard rejects in-progress generation, drafts, editors and unverified status',()=>{
  const t=harness();
  assert.equal(canSafelyReload({doc:t.doc,isGenerating:t.isGenerating}),true);
  t.generation(true);assert.equal(canSafelyReload({doc:t.doc,isGenerating:t.isGenerating}),false);
  t.generation(false);t.draft('尚未发送');
  assert.equal(canSafelyReload({doc:t.doc,isGenerating:t.isGenerating}),false);
  t.draft('');t.doc.dialogOpen=true;
  assert.equal(canSafelyReload({doc:t.doc,isGenerating:t.isGenerating}),false);
  t.doc.dialogOpen=false;t.focus({tagName:'INPUT',isContentEditable:false});
  assert.equal(canSafelyReload({doc:t.doc,isGenerating:t.isGenerating}),false);
  t.focus({tagName:'DIV',isContentEditable:true});
  assert.equal(canSafelyReload({doc:t.doc,isGenerating:t.isGenerating}),false);
  t.focus(null);t.doc.visibilityState='hidden';
  assert.equal(canSafelyReload({doc:t.doc,isGenerating:t.isGenerating}),false);
  t.doc.visibilityState='visible';
  assert.equal(canSafelyReload({doc:t.doc,isGenerating:null}),false);
});

test('an installed or updated extension reloads once when safe and does not block hook completion',async()=>{
  const t=harness();
  try{
    assert.equal(await refreshAfterInstallOrUpdate('安装',{doc:t.doc,win:t.win,toast:t.toast,isGenerating:t.isGenerating}),true);
    assert.equal(t.reloads,0);
    assert.equal(await refreshAfterInstallOrUpdate('更新',{doc:t.doc,win:t.win,toast:t.toast,isGenerating:t.isGenerating}),false);
    t.tickTimeouts();assert.equal(t.reloads,1);assert.equal(t.intervalCount,0);
    t.tickTimeouts();t.tickIntervals();assert.equal(t.reloads,1);
    assert.equal(t.toasts.length,0,'no unnecessary toast when safe');
  }finally{t.reset();}
});

test('busy update waits for a clean draft and shows only one nonblocking notice',async()=>{
  const t=harness();t.generation(true);t.draft('保留这个草稿');
  try{
    assert.equal(await refreshAfterInstallOrUpdate('更新',{doc:t.doc,win:t.win,toast:t.toast,isGenerating:t.isGenerating}),true);
    t.tickTimeouts();t.tickIntervals();t.tickIntervals();
    assert.equal(t.reloads,0);assert.equal(t.toasts.length,1);
    assert.equal(t.toasts[0].options.closeButton,true);
    assert.equal(t.toasts[0].options.timeOut,0);
    t.generation(false);t.tickIntervals();
    assert.equal(t.reloads,0,'draft still prevents automatic reload');
    t.draft('');t.tickIntervals();
    assert.equal(t.reloads,1);
    t.tickIntervals();assert.equal(t.reloads,1);
  }finally{t.reset();}
});

test('manual refresh while unsafe requires explicit confirmation; missing generation signal fails closed',async()=>{
  const t=harness();t.draft('未发送');
  try{
    await refreshAfterInstallOrUpdate('安装',{doc:t.doc,win:t.win,toast:t.toast,isGenerating:t.isGenerating});
    t.tickTimeouts();
    t.toasts[0].options.onclick();
    assert.equal(t.reloads,0);
    t.confirm(true);t.toasts[0].options.onclick();
    assert.equal(t.reloads,1);
  }finally{t.reset();}
  const u=harness();
  try{
    await refreshAfterInstallOrUpdate('更新',{doc:u.doc,win:u.win,toast:u.toast,isGenerating:null});
    u.tickTimeouts();
    assert.equal(u.reloads,0);
  }finally{u.reset();}
});

test('manifest registers both official lifecycle hooks while auto-update remains opt-in',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url),'utf8'));
  const entry=readFileSync(new URL('../index.js',import.meta.url),'utf8');
  assert.deepEqual(manifest.hooks,{install:'storyMemoryOnInstall',update:'storyMemoryOnUpdate'});
  assert.equal(manifest.auto_update,false);
  for(const key of Object.values(manifest.hooks))assert.match(entry,new RegExp('export function '+key+'\\('));
});

test('manager popup and its focused search input do not block, but other dialogs and drafts do',()=>{
  const t=harness();t.manager(true);
  t.focus({tagName:'INPUT',insideManager:true});
  assert.equal(reloadBlockReason({doc:t.doc,isGenerating:t.isGenerating}),null);
  assert.equal(canSafelyReload({doc:t.doc,isGenerating:t.isGenerating}),true);
  t.doc.dialogOpen=true;
  assert.equal(reloadBlockReason({doc:t.doc,isGenerating:t.isGenerating}),'还有其他弹窗打开');
  t.doc.dialogOpen=false;
  t.draft('原来聊天中的草稿');
  assert.equal(reloadBlockReason({doc:t.doc,isGenerating:t.isGenerating}),'发送框有未发送内容');
  t.draft('');
  t.focus({tagName:'TEXTAREA',insideManager:false});
  assert.equal(reloadBlockReason({doc:t.doc,isGenerating:t.isGenerating}),'有尚未退出的输入控件');
  t.focus({tagName:'INPUT',insideManager:true});
  t.generation(true);
  assert.equal(reloadBlockReason({doc:t.doc,isGenerating:t.isGenerating}),'酒馆正在生成回复');
  t.generation(false);
  assert.equal(canSafelyReload({doc:t.doc,isGenerating:t.isGenerating,
    getExtensionBlockReason:()=> '剧情记忆正在整理摘要'}),false);
});

test('update hook reloads once even while official extension manager stays open',async()=>{
  const t=harness();t.manager(true);
  t.focus({tagName:'INPUT',insideManager:true});
  try{
    assert.equal(await refreshAfterInstallOrUpdate('更新',{doc:t.doc,win:t.win,toast:t.toast,
      isGenerating:t.isGenerating,delay:12}),true);
    t.tickTimeouts();
    assert.equal(t.reloads,1);
    assert.equal(t.toasts.length,0,'manager alone is not a reason to warn');
    t.tickIntervals();assert.equal(t.reloads,1);
  }finally{t.reset();}
});

test('extension tasks and other dialogs delay reload with accurate reasons until safe',async()=>{
  const t=harness();t.manager(true);
  let reason='剧情记忆正在整理摘要';
  try{
    await refreshAfterInstallOrUpdate('更新',{doc:t.doc,win:t.win,toast:t.toast,
      isGenerating:t.isGenerating,getExtensionBlockReason:()=>reason});
    t.tickTimeouts();
    assert.equal(t.reloads,0);
    assert.equal(t.toasts.length,1);
    assert.match(t.toasts[0].message,/自动刷新暂缓：剧情记忆正在整理摘要/);
    t.tickIntervals();assert.equal(t.toasts.length,1,'do not repeat unchanged notices');
    reason='剧情记忆设置有未保存的修改';
    t.tickIntervals();
    assert.equal(t.toasts.length,2);
    assert.match(t.toasts[1].message,/剧情记忆设置有未保存的修改/);
    reason=null;t.doc.dialogOpen=true;t.tickIntervals();
    assert.equal(t.reloads,0);
    assert.equal(t.toasts.length,3);
    assert.match(t.toasts[2].message,/还有其他弹窗打开/);
    t.doc.dialogOpen=false;t.tickIntervals();
    assert.equal(t.reloads,1);
    t.tickIntervals();assert.equal(t.reloads,1);
  }finally{t.reset();}
});

test('manual refresh of a busy extension requires confirmation, without repeated reload',async()=>{
  const t=harness();t.manager(true);
  try{
    await refreshAfterInstallOrUpdate('更新',{doc:t.doc,win:t.win,toast:t.toast,
      isGenerating:t.isGenerating,getExtensionBlockReason:()=> '剧情记忆正在整理摘要'});
    t.tickTimeouts();
    t.toasts[0].options.onclick();
    assert.equal(t.reloads,0);
    t.confirm(true);
    t.toasts[0].options.onclick();
    assert.equal(t.reloads,1);
    t.tickIntervals();assert.equal(t.reloads,1);
  }finally{t.reset();}
});

test('host and extension state signals remain wired to the lifecycle hook',()=>{
  const entry=readFileSync(new URL('../index.js',import.meta.url),'utf8');
  const ui=readFileSync(new URL('../ui.js',import.meta.url),'utf8');
  assert.match(entry,/getExtensionBlockReason:refreshBlockReason/);
  assert.match(entry,/queue\?\.busy\|\|queue\?\.chapterRetryBusy/);
  assert.match(entry,/vectorIndexer\?\.status\(\)\?\.busy/);
  assert.match(entry,/ui\?\.getRefreshBlockReason\?\.\(\)/);
  assert.match(ui,/getRefreshBlockReason\(\)/);
});
