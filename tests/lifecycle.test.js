import test from 'node:test';
import assert from 'node:assert/strict';
import {canSafelyReload,refreshAfterInstallOrUpdate} from '../lifecycle.js';
import {readFileSync} from 'node:fs';

function harness(){
  let nextId=1,reloads=0,confirmResult=false,generating=false,draft='';
  const timeouts=new Map(),intervals=new Map(),events=new Map(),toasts=[];
  let input={value:''},activeElement=null;
  const doc={visibilityState:'visible',get activeElement(){return activeElement;},
    querySelector:(selector)=>selector==='#send_textarea'?input:
      selector==='dialog[open]'?(doc.dialogOpen?{}:null):null};
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
