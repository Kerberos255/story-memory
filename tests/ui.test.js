import test from 'node:test';
import assert from 'node:assert/strict';
import {mountUI} from '../ui.js';
import {freshMemory,defaultSettings,commitLeaf,normalizeDelta,messageFingerprint,userFingerprint,editGeneratedLeaf,deleteGeneratedLeaf,editGeneratedChapter,deleteGeneratedChapter,mergeEntities,unmergeEntity,deriveState,addManual,correctEntity,clearEntityCorrection} from '../core.js';
import {readFileSync} from 'node:fs';

class FakeElement{
  constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.style={};this.dataset={};this.listeners={};this.open=false;this.value='';this.className='';this.textContent='';this.checked=false;this.scrollTop=0;}
  get classList(){
    const classes=()=>new Set(String(this.className||'').split(/\\s+/).filter(Boolean));
    return {
      contains:name=>classes().has(name),
      add:(...names)=>{const c=classes();names.forEach(n=>c.add(n));this.className=[...c].join(' ');},
      remove:(...names)=>{const c=classes();names.forEach(n=>c.delete(n));this.className=[...c].join(' ');},
      toggle:(name,force)=>{const c=classes(),enabled=force??!c.has(name);
        if(enabled)c.add(name);else c.delete(name);
        this.className=[...c].join(' ');return enabled;}
    };
  }
  getAttribute(key){return this.attrs[key]??null;}
  closest(selector){
    if(selector.includes('[hidden]')&&this.hidden)return this;
    if(selector.includes('[inert]')&&this.inert)return this;
    return this.parent?.closest?.(selector)||null;
  }

  append(...nodes){for(const x of nodes){if(x===undefined)throw Error('undefined child');this.children.push(x);if(x&&typeof x==='object')x.parent=this;}}
  prepend(...nodes){this.children.unshift(...nodes);}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(key,value){this.attrs[key]=String(value);}
  addEventListener(key,fn){(this.listeners[key]||=[]).push(fn);}
  attachShadow(){this.shadow=new FakeElement('shadow-root');return this.shadow;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  focus(){}
  getBoundingClientRect(){return {left:0,right:900,top:0,bottom:680};}
  querySelector(selector){if(selector==='.sm-notice')return find(this,x=>x.className==='sm-notice');return null;}
  querySelectorAll(selector){
    const names=new Set(selector.split(',').map(x=>x.trim().split(/[:\\[.]/)[0]));
    return walk(this).slice(1).filter(x=>names.has(x.tag));
  }
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
  fire(key,extra={}){for(const fn of this.listeners[key]||[])fn({target:this,preventDefault(){},...extra});}
}
function walk(root){return [root,...root.children.flatMap(x=>x instanceof FakeElement?walk(x):[])];}
function find(root,fn){return walk(root).find(fn);}
function withUI(fn){
  const old={document:globalThis.document,localStorage:globalThis.localStorage};
  const storage=new Map(),body=new FakeElement('body');
  globalThis.document={body,createElement:tag=>new FakeElement(tag),createElementNS:(_,tag)=>new FakeElement(tag)};
  globalThis.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
  const cleanup=()=>{globalThis.document=old.document;globalThis.localStorage=old.localStorage;};
  let result;
  try{result=fn(body,storage);}catch(error){cleanup();throw error;}
  if(result&&typeof result.then==='function')return result.finally(cleanup);
  cleanup();return result;
}
test('dark mode is default; sun and moon toggle persist without rebuilding form',()=>withUI((body,storage)=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
  const api={context:()=>ctx,memory:freshMemory,settings:defaultSettings,queue:{busy:false,enqueueMissing(){}},onClose(){}};
  const view=mountUI(api),dialog=body.children[0].shadow.children[1];
  assert.equal(dialog.dataset.theme,'dark');
  assert.equal(dialog.open,false);
  view.open();
  const toggle=find(dialog,x=>x.attrs['data-testid']==='theme-toggle');
  assert.ok(toggle);assert.match(toggle.attrs['aria-label'],/明亮/);
  const settings=find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置'));
  assert.ok(settings);settings.fire('click');
  const groups=walk(dialog).filter(x=>x.className==='sm-accordion');
  assert.equal(groups.length,5,'unified retrieval keeps settings at five top-level groups');
  const formInput=find(dialog,x=>x.tag==='input'&&x.value==='');
  assert.ok(formInput);
  formInput.value='custom-draft';
  const beforeInput=formInput;
  toggle.fire('click');
  assert.equal(dialog.dataset.theme,'light');
  assert.equal(storage.get('story-memory-theme'),'light');
  assert.match(toggle.attrs['aria-label'],/暗色/);
  assert.equal(beforeInput.value,'custom-draft');
  assert.ok(walk(dialog).includes(beforeInput),'theme change must not rebuild input');
  toggle.fire('click');assert.equal(dialog.dataset.theme,'dark');
  formInput.value=''; // Reverted input is clean.
  view.open(false);
  assert.equal(dialog.open,false);
  assert.equal(find(dialog,x=>x.tag==='main').children.length,0);
}));
test('theme CSS is scoped and does not rely on OS theme overriding user choice',()=>{
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/\.sm-dialog\[data-theme=light\]/);
 assert.match(css,/\.sm-dialog::backdrop/);
 assert.doesNotMatch(css,/prefers-color-scheme/);
});

test('API settings expose follow-main mode and group all advanced parameters',()=>withUI((body)=>{
 const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
 let saved=null;
 const api={context:()=>ctx,memory:freshMemory,settings:defaultSettings,queue:{busy:false,enqueueMissing(){}},saveSettings:x=>saved=x};
 const view=mountUI(api);view.open();
 const dialog=body.children[0].shadow.children[1];
 find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
 const extras=find(dialog,x=>x.className?.includes('sm-extra'));
 assert.ok(extras);
 assert.equal(walk(extras).filter(x=>x.className==='sm-extra-section').length,3);
 for(const name of ['包含主体参数','排除主体参数','包含请求标头'])
   assert.ok(walk(extras).some(x=>x.textContent===name));
 const options=walk(dialog).filter(x=>x.tag==='option');
 assert.ok(options.some(x=>x.value==='main'&&x.textContent==='跟随主 API'));
 const select=find(dialog,x=>x.tag==='select');
 select.value='main';select.fire('change');
 assert.equal(find(dialog,x=>x.className==='sm-form-stack')?.hidden,true);
 const submit=find(dialog,x=>x.textContent==='保存设置'&&x.tag==='button');
 assert.ok(submit);submit.fire('click');
 assert.equal(saved.api.mode,'main');
 assert.deepEqual(saved.api.headers,{});
}));
test('prompt editor displays full defaults for summary, chapter, and overview',()=>withUI((body)=>{
 const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
 const view=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,queue:{busy:false,enqueueMissing(){}}});view.open();
 const dialog=body.children[0].shadow.children[1];
 find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
 const groups=walk(dialog).filter(x=>x.className==='sm-prompt-group');
 assert.equal(groups.length,4);
 const values=groups.map(g=>walk(g).find(x=>x.tag==='textarea')?.value||'');
 assert.ok(values[0].includes('characters'));
 assert.ok(values[0].includes('items'));
 assert.ok(values[0].includes('scenes'));
 assert.ok(values[1].includes('章节'));
 assert.ok(values[2].includes('二次总结'));
 assert.ok(values[3].includes('长期'));
 assert.ok(walk(dialog).some(x=>x.textContent==='Embedding API 密钥'));
}));

test('independent summary API form shows URL, key and model without changing main API',()=>withUI(body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
  let saved;
  const api={context:()=>ctx,memory:freshMemory,settings:defaultSettings,queue:{busy:false,enqueueMissing(){}},
    saveSettings:x=>{saved=x;},fetchSummaryModels:async()=>['model-a']};
  const view=mountUI(api);view.open();
  const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  assert.ok(walk(dialog).some(x=>x.textContent==='摘要 API'));
  const mode=find(dialog,x=>x.tag==='select'&&x.children.some(y=>y.value==='custom'));
  assert.equal(mode.value,'main');
  const custom=find(dialog,x=>x.className==='sm-form-stack'&&walk(x).some(y=>y.textContent==='API 地址'));
  assert.equal(custom.hidden,true);
  mode.value='custom';mode.fire('change');
  assert.equal(custom.hidden,false);
  const key=walk(custom).find(x=>x.tag==='input'&&x.type==='password');
  assert.ok(key);key.value='synthetic-key';
  const url=walk(custom).find(x=>x.tag==='input'&&x.type==='url');
  url.value='https://summary.example.invalid/v1';
  const model=walk(custom).find(x=>x.tag==='input'&&x.placeholder==='填写模型 ID 或刷新获取');
  model.value='model-a';
  const submit=find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置');
  submit.fire('click');
  assert.equal(saved.api.mode,'custom');
  assert.equal(saved.api.url,'https://summary.example.invalid/v1');
  assert.equal(saved.api.model,'model-a');
  assert.equal(saved.api.key,'synthetic-key');
  assert.equal(saved.api.secretId,undefined);
}));

test('model refresh replaces entry with a selectable list and keeps the chosen model',()=>withUI(async body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''},cfg=defaultSettings();
  let saved;
  const view=mountUI({context:()=>ctx,memory:freshMemory,settings:()=>cfg,
    queue:{busy:false,enqueueMissing(){}},
    fetchSummaryModels:async ({url,key})=>{
      assert.equal(url,'https://summary.example.invalid/v1');
      assert.equal(key,'synthetic-key');
      return ['model-a','model-b'];
    },
    saveSettings:value=>{saved=value;}
  });
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  const mode=find(dialog,x=>x.tag==='select'&&x.children.some(y=>y.value==='custom'));
  mode.value='custom';mode.fire('change');
  const custom=find(dialog,x=>x.className==='sm-form-stack'&&walk(x).some(y=>y.textContent==='API 地址'));
  walk(custom).find(x=>x.tag==='input'&&x.type==='url').value='https://summary.example.invalid/v1';
  walk(custom).find(x=>x.tag==='input'&&x.type==='password').value='synthetic-key';
  const refresh=find(dialog,x=>x.attrs['aria-label']==='刷新模型列表');
  assert.ok(refresh);refresh.fire('click');
  await new Promise(resolve=>setImmediate(resolve));
  const picker=find(dialog,x=>x.attrs['aria-label']==='选择摘要模型');
  assert.equal(picker.hidden,false);
  assert.ok(picker.children.some(x=>x.value==='model-b'));
  picker.value='model-b';picker.fire('change');
  assert.equal(picker.hidden,true);
  find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
  assert.equal(saved.api.model,'model-b');
}));

test('vector API settings are private to the plugin and save without ST secret calls',()=>withUI(body=>{
 const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
 let next;
 const view=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
   queue:{busy:false,enqueueMissing(){}},saveSettings:value=>{next=value;}});
 view.open();
 const dialog=body.children[0].shadow.children[1];
 find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
 const field=walk(dialog).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='Embedding API 密钥'));
 assert.ok(field);
 const key=walk(field).find(x=>x.tag==='input');
 assert.ok(key);key.value='synthetic-embedding-key';
 find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
 assert.equal(next.vector.key,'synthetic-embedding-key');
 assert.equal(next.vector.url,'https://api.siliconflow.cn/v1');
 assert.equal(next.api.temperature,0);
 assert.equal(next.api.maxTokens,null);
 assert.equal(next.summary.leafBatchThreshold,12);
 assert.equal(next.summary.resummaryThreshold,6);
 assert.equal(next.summary.higherResummaryThreshold,3);
 assert.equal(next.prompts.resummary2,'','unmodified default must not be pinned');
}));

test('rerank settings expose independent model while sharing vector API connection',()=>withUI(body=>{
 const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};let saved;
 const view=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
   queue:{busy:false,enqueueMissing(){}},saveSettings:next=>{saved=next;}});
 view.open();const dialog=body.children[0].shadow.children[1];
 find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
 const toggle=walk(dialog).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='启用重排（Rerank）'));
 assert.ok(toggle);const check=walk(toggle).find(x=>x.tag==='input');assert.equal(check.checked,false);
 check.checked=true;
 const modelLabel=walk(dialog).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='重排模型'));
 assert.ok(modelLabel);const model=walk(modelLabel).find(x=>x.tag==='input');
 assert.equal(model.value,'BAAI/bge-reranker-v2-m3');
 model.value='Qwen/Qwen3-Reranker-0.6B';
 find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
 assert.equal(saved.vector.rerankEnabled,true);
 assert.equal(saved.vector.rerankModel,'Qwen/Qwen3-Reranker-0.6B');
 assert.equal(saved.vector.rerankCandidates,15);
 assert.equal(saved.vector.model,'BAAI/bge-m3');
}));
test('summary settings expose delayed floor count and automatic hiding toggle',()=>withUI(body=>{
 const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
 let saved;
 const view=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
   queue:{busy:false,enqueueMissing(){}},saveSettings:x=>{saved=x;}});
 view.open();const dialog=body.children[0].shadow.children[1];
 find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
 const delay=walk(dialog).find(x=>x.className==='sm-summary-number-card'&&walk(x).some(y=>y.textContent==='延迟摘要'));
 assert.ok(delay);
 const delayInput=walk(delay).find(x=>x.tag==='input');
 assert.equal(delayInput.value,'3');
 delayInput.value='4';
 const toggle=walk(dialog).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='摘要完成后自动隐藏'));
 assert.ok(toggle);const checkbox=walk(toggle).find(x=>x.tag==='input');
  assert.equal(checkbox.checked,true);
  checkbox.checked=false;
 find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
 assert.equal(saved.summary.delayFloors,4);
  assert.equal(saved.summary.autoHide,false);
}));

test('restore defaults keeps connection secrets and remembers, asks before replacing settings',()=>withUI(body=>{
  const previousWindow=globalThis.window;
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
  let cfg=defaultSettings();
  cfg.api.mode='custom';
  cfg.api.key='synthetic-not-a-real-key';
  cfg.api.url='https://example.invalid/v1';
  cfg.api.model='synthetic-model';
  cfg.api.headers={'X-Example':'synthetic'};
  cfg.api.temperature=.2;cfg.api.maxTokens=4096;
  cfg.vector.key='synthetic-vector-value';cfg.vector.model='custom-embedding';
   cfg.autoSummary=false;cfg.summary.autoHide=false;cfg.summary.delayFloors=6;
  cfg.prompts.summaryFull='Custom prompt';
  let consent=false,saves=0;
  globalThis.window={confirm:()=>consent};
  try{
    const ui=mountUI({context:()=>ctx,memory:freshMemory,settings:()=>cfg,
      queue:{busy:false,enqueueMissing(){}},
      saveSettings:value=>{cfg=structuredClone(value);saves++;}
    });
    ui.open();
    const dialog=body.children[0].shadow.children[1];
    find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
    const reset=find(dialog,x=>x.attrs['data-testid']==='reset-settings');
    assert.ok(reset);
    reset.fire('click');assert.equal(saves,0,'cancelled reset must not save');
    consent=true;reset.fire('click');
    assert.equal(saves,0,'restoring defaults only fills a draft');
    assert.ok(find(dialog,x=>x.className==='sm-settings-draft-note'));
    find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
    assert.equal(saves,1);
    assert.equal(find(dialog,x=>x.className==='sm-settings-draft-note'),undefined);
    assert.equal(cfg.api.temperature,0);
    assert.equal(cfg.api.maxTokens,null);
     assert.equal(cfg.summary.autoHide,true);
     assert.equal(cfg.autoSummary,true);
    assert.equal(cfg.summary.delayFloors,3);
    assert.equal(cfg.prompts.summaryFull,'');
    assert.equal(cfg.api.mode,'custom');
    assert.equal(cfg.api.key,'synthetic-not-a-real-key');
    assert.equal(cfg.api.url,'https://example.invalid/v1');
    assert.equal(cfg.api.model,'synthetic-model');
    assert.deepEqual(cfg.api.headers,{'X-Example':'synthetic'});
    assert.equal(cfg.vector.key,'synthetic-vector-value');
    assert.equal(cfg.vector.model,'BAAI/bge-m3');
  }finally{globalThis.window=previousWindow;}
}));

test('compact compression strip edits three independent thresholds and retained L0 count',()=>withUI(body=>{
 const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};let saved;
 const view=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
   queue:{busy:false,enqueueMissing(){}},saveSettings:s=>{saved=s;}});
 view.open();
 const dialog=body.children[0].shadow.children[1];
 find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
 const strips=walk(dialog).filter(x=>x.className==='sm-level-strip');
 assert.equal(strips.length,1,'one shared level strip, not three independent cards');
 const cells=walk(strips[0]).filter(x=>x.className==='sm-level-cell');
 assert.equal(cells.length,3);
 const thresholds=[
   ['阶段总结触发阈值','10'],['二次总结触发阈值','5'],['高层总结触发阈值','2']
 ];
 for(const [label,value] of thresholds){
   const input=walk(strips[0]).find(x=>x.tag==='input'&&x.attrs['aria-label']===label);
   assert.ok(input,label);input.value=value;
 }
 const keep=find(dialog,x=>x.className==='sm-level-keep');
 assert.ok(keep);
 const keepInput=walk(keep).find(x=>x.tag==='input');
 assert.ok(keepInput);keepInput.value='4';
 assert.ok(walk(keep).some(x=>x.textContent==='保留最近 L0 摘要'));
 assert.ok(walk(keep).some(x=>String(x.textContent||'').includes('与延迟生成 L0 无关')));
 const retry=find(dialog,x=>x.className==='sm-summary-retry');
 assert.ok(retry,'a single retry control does not need an advanced drawer');
 assert.equal(find(dialog,x=>x.className==='sm-summary-advanced'),undefined);
 const retryInput=walk(retry).find(x=>x.tag==='input');
 assert.ok(retryInput);retryInput.value='2';
 find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
 assert.equal(saved.summary.leafBatchThreshold,10);
 assert.equal(saved.summary.resummaryThreshold,5);
 assert.equal(saved.summary.higherResummaryThreshold,2);
 assert.equal(saved.summary.leafKeepRecent,4);
 assert.equal(saved.summary.retry,2);
}));
test('dark and light palettes have clear foreground and neutral cool backgrounds',()=>{
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/\.sm-dialog\{--bg:#101722;/);
 assert.match(css,/--fg:#f4f6fc;/);
 assert.match(css,/\.sm-dialog\[data-theme=light\]\{[\s\S]*?--bg:#f3f6fb;/);
 assert.match(css,/\.sm-level-strip\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
 assert.match(css,/@media\(max-width:610px\)/);
 assert.doesNotMatch(css,/#f8f7f4|#fffefa|#d3a569/i);
});

test('generated timeline reads once; edit and delete use separate modal dialogs',()=>withUI(body=>{
 const ctx={chat:[{is_user:true,mes:'用户问路'},{is_user:false,mes:'角色进入小巷',swipe_id:0}],getCurrentChatId:()=> 'local-test'};
 let memory=commitLeaf(freshMemory(),1,messageFingerprint(ctx.chat[1]),
   normalizeDelta({summary:'旧摘要',time:'2026/7/11 星期六 06:22-06:29',location:'巷口',
     items:[{op:'add',name:'钥匙',owner:'角色'}]}),userFingerprint(ctx.chat,1));
 const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
   queue:{busy:false,enqueueMissing(){}},
   editLeaf:(index,patch)=>{memory=editGeneratedLeaf(memory,ctx.chat,index,patch);},
   deleteLeaf:index=>{memory=deleteGeneratedLeaf(memory,ctx.chat,index);}
 });
 view.open();
 const dialog=body.children[0].shadow.children[1];
 let card=find(dialog,x=>x.className==='sm-record');
 assert.ok(card);
 assert.equal(walk(card).filter(x=>x.tag==='textarea').length,0);
 assert.equal(find(card,x=>x.className==='sm-record-text').textContent,'旧摘要');
 assert.ok(walk(card).some(x=>x.className==='sm-record-subtitle'&&x.textContent.includes('地点：巷口')));
 card.open=true;
 find(card,x=>x.attrs['aria-label']==='编辑摘要').fire('click');
 let overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
 assert.ok(overlay);
 assert.equal(walk(overlay).find(x=>x.attrs.role==='dialog')?.attrs['aria-modal'],'true');
 assert.equal(find(card,x=>x.className==='sm-record-text').textContent,'旧摘要','read view is not duplicated');
 assert.equal(walk(card).some(x=>x.tag==='textarea'),false);
 let editor=find(overlay,x=>x.tag==='textarea'),time=find(overlay,x=>x.tag==='input'&&x.value.startsWith('2026'));
 assert.ok(editor&&time);
 assert.equal(time.value,'2026/07/11 · 06:22–06:29');
 editor.value='不应保存的草稿';
 find(overlay,x=>x.tag==='button'&&x.textContent==='取消').fire('click');
 assert.equal(find(dialog,x=>x.className==='sm-record-modal-overlay'),undefined);
 assert.equal(memory.leaves[1].summary,'旧摘要');

 find(card,x=>x.attrs['aria-label']==='编辑摘要').fire('click');
 overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
 editor=find(overlay,x=>x.tag==='textarea');time=find(overlay,x=>x.tag==='input'&&x.value.startsWith('2026'));
 editor.value='人工更正后的剧情';time.value='2026/7/11 06:22-06:29';
 find(overlay,x=>x.tag==='button'&&x.textContent==='保存修改').fire('click');
 assert.equal(memory.leaves[1].summary,'人工更正后的剧情');
 assert.equal(memory.leaves[1].time,'2026/07/11 · 06:22–06:29');
 assert.equal(find(dialog,x=>x.className==='sm-record-modal-overlay'),undefined);

 card=find(dialog,x=>x.className==='sm-record');
 find(card,x=>x.attrs['aria-label']==='删除摘要').fire('click');
 overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
 assert.ok(overlay);
 assert.ok(walk(overlay).some(x=>x.textContent.includes('原始聊天不会删除')));
 assert.ok(memory.leaves[1]);
 find(overlay,x=>x.tag==='button'&&x.textContent==='取消').fire('click');
 assert.ok(memory.leaves[1]);
 find(card,x=>x.attrs['aria-label']==='删除摘要').fire('click');
 overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
 find(overlay,x=>x.tag==='button'&&x.textContent==='确认删除').fire('click');
 assert.equal(memory.leaves[1],undefined);
 assert.equal(ctx.chat[1].mes,'角色进入小巷');
 assert.equal(find(dialog,x=>x.className==='sm-record-modal-overlay'),undefined);
}));
test('generated L1 chapter uses text-only edit modal; Esc closes nested modal not whole extension',()=>withUI(body=>{
 const ctx={chat:[{is_user:false,mes:'AI剧情'}],getCurrentChatId:()=> 'local-test'};
 let memory=commitLeaf(freshMemory(),0,messageFingerprint(ctx.chat[0]),normalizeDelta({summary:'楼层'}));
 memory.chapters.push({id:'chapter:1',level:1,children:['floor:0'],summary:'阶段总结'});
 const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
   queue:{busy:false,enqueueMissing(){}},
   editChapter:(id,summary)=>{memory=editGeneratedChapter(memory,ctx.chat,id,summary);},
   deleteChapter:id=>{memory=deleteGeneratedChapter(memory,ctx.chat,id);}
 });
 view.open();const dialog=body.children[0].shadow.children[1];
 let card=find(dialog,x=>x.className==='sm-record');
 find(card,x=>x.attrs['aria-label']==='编辑摘要').fire('click');
 let overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
 assert.ok(overlay);
 assert.equal(walk(overlay).filter(x=>x.tag==='input').length,0,'L1 modal only has summary field');
 assert.ok(walk(overlay).some(x=>x.textContent==='编辑 阶段总结'));
 dialog.fire('cancel');
 assert.equal(find(dialog,x=>x.className==='sm-record-modal-overlay'),undefined);
 assert.equal(dialog.open,true,'closing inner modal does not close extension');
 find(card,x=>x.attrs['aria-label']==='编辑摘要').fire('click');
 overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
 find(overlay,x=>x.tag==='textarea').value='改写过的 L1 阶段总结';
 find(overlay,x=>x.tag==='button'&&x.textContent==='保存修改').fire('click');
 assert.equal(memory.chapters[0].summary,'改写过的 L1 阶段总结');
 card=find(dialog,x=>x.className==='sm-record');
 find(card,x=>x.attrs['aria-label']==='删除摘要').fire('click');
 overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
 find(overlay,x=>x.tag==='button'&&x.textContent==='确认删除').fire('click');
 assert.equal(memory.chapters.length,0);
 assert.ok(memory.leaves[0],'underlying fact stays');
}));
test('modal backdrop and close actions discard draft without changing saved summary',()=>withUI(body=>{
 const ctx={chat:[{is_user:false,mes:'内容'}],getCurrentChatId:()=> 'test'};
 const memory=commitLeaf(freshMemory(),0,messageFingerprint(ctx.chat[0]),normalizeDelta({summary:'保存的内容'}));
 const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
   queue:{busy:false,enqueueMissing(){}}});
 view.open();
 const dialog=body.children[0].shadow.children[1],card=find(dialog,x=>x.className==='sm-record');
 find(card,x=>x.attrs['aria-label']==='编辑摘要').fire('click');
 const overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
 find(overlay,x=>x.tag==='textarea').value='草稿';
 overlay.fire('click',{target:overlay});
 assert.equal(find(dialog,x=>x.className==='sm-record-modal-overlay'),undefined);
 assert.equal(memory.leaves[0].summary,'保存的内容');
 find(card,x=>x.attrs['aria-label']==='编辑摘要').fire('click');
 dialog.fire('click',{target:dialog,clientX:-10,clientY:0});
 assert.equal(find(dialog,x=>x.className==='sm-record-modal-overlay'),undefined);
 assert.equal(dialog.open,true,'outer backdrop should close inner dialog first');
 view.open(false);
 assert.equal(dialog.open,false);
}));
test('items provide an undoable merge selector, without changing scenes or characters',()=>withUI(body=>{
 const oldWindow=globalThis.window;globalThis.window={confirm:()=>true};
 try{
  const ctx={chat:[{is_user:false,mes:'发现道具'},{is_user:false,mes:'道具换称呼'}],getCurrentChatId:()=> 'alias-ui'};
  let memory=commitLeaf(freshMemory(),0,messageFingerprint(ctx.chat[0]),normalizeDelta({
    summary:'拾起',items:[{op:'add',name:'银钥匙'}],
    scenes:[{op:'add',name:'老走廊'}],characters:[{op:'add',name:'向导'}]
  }));
  memory=commitLeaf(memory,1,messageFingerprint(ctx.chat[1]),normalizeDelta({
    summary:'移动',items:[{op:'update',name:'背包里的钥匙',location:'口袋'}],
    scenes:[{op:'update',name:'走廊'}],characters:[{op:'update',name:'旅行者'}]
  }));
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},
    mergeEntity:(kind,from,to)=>{memory=mergeEntities(memory,ctx.chat,kind,from,to);},
    unmergeAlias:(kind,name)=>{memory=unmergeEntity(memory,kind,name);}
  });view.open();
  const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='物品')).fire('click');
  const before=deriveState(memory,ctx.chat);
  assert.equal(before.items.length,2);
  const source=find(dialog,x=>x.tag==='select'&&x.attrs['aria-label']==='待合并的实体');
  const dest=find(dialog,x=>x.tag==='select'&&x.attrs['aria-label']==='合并到实体');
  assert.ok(source&&dest);
  source.value=before.items[1].entity_id;
  dest.value=before.items[0].entity_id;
  find(dialog,x=>x.tag==='button'&&x.textContent==='确认合并').fire('click');
  assert.equal(deriveState(memory,ctx.chat).items.length,1);
  assert.equal(deriveState(memory,ctx.chat).scenes.length,2);
  assert.equal(deriveState(memory,ctx.chat).characters.length,2);
  view.refresh();
  const undo=find(dialog,x=>x.tag==='button'&&x.textContent==='撤销合并');
  assert.ok(undo);undo.fire('click');
  assert.equal(deriveState(memory,ctx.chat).items.length,2);
 }finally{globalThis.window=oldWindow;}
}));

test('entity cards offer explicit merge and undo instead of fuzzy automatic grouping',()=>withUI(body=>{
 const oldWindow=globalThis.window;let allow=false;
 globalThis.window={confirm:()=>allow};
 try{
   const ctx={chat:[{is_user:false,mes:'第一幕'},{is_user:false,mes:'第二幕'}],getCurrentChatId:()=> 'synthetic-chat'};
   let memory=freshMemory();
   memory=commitLeaf(memory,0,messageFingerprint(ctx.chat[0]),
     normalizeDelta({summary:'拾到钥匙',items:[{op:'add',name:'旧铜钥匙'}],
       scenes:[{op:'add',name:'大厅'}],characters:[{op:'add',name:'店主'}]}));
   memory=commitLeaf(memory,1,messageFingerprint(ctx.chat[1]),
     normalizeDelta({summary:'钥匙换了称呼',items:[{op:'update',name:'店主的钥匙'}],
       scenes:[{op:'add',name:'大厅侧门'}],characters:[{op:'add',name:'店员'}]}));
   const view=mountUI({
     context:()=>ctx,memory:()=>memory,settings:defaultSettings,
     queue:{busy:false,enqueueMissing(){}},
     mergeEntity:(kind,from,to)=>{memory=mergeEntities(memory,ctx.chat,kind,from,to);},
     unmergeAlias:(kind,name)=>{memory=unmergeEntity(memory,kind,name);}
   });
   view.open();const dialog=body.children[0].shadow.children[1];
   find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='物品')).fire('click');
   const cards=walk(dialog).filter(x=>x.className==='sm-record');
   assert.equal(cards.length,2);
   const controls=find(cards[1],x=>x.className==='sm-entity-controls');
   assert.ok(controls);
   const picker=find(controls,x=>x.tag==='select');
   const target=deriveState(memory,ctx.chat).items[0];
   picker.value=target.entity_id;
   find(controls,x=>x.tag==='button').fire('click');
   assert.equal(deriveState(memory,ctx.chat).items.length,2,'cancel must preserve both');
   allow=true;
   find(controls,x=>x.tag==='button').fire('click');
   assert.equal(deriveState(memory,ctx.chat).items.length,1);
   assert.equal(deriveState(memory,ctx.chat).scenes.length,2);
   assert.equal(deriveState(memory,ctx.chat).characters.length,2);
   view.refresh();
   const undo=find(dialog,x=>x.tag==='button'&&x.textContent==='撤销合并');
   assert.ok(undo);
   undo.fire('click');
   assert.equal(deriveState(memory,ctx.chat).items.length,2);
 }finally{globalThis.window=oldWindow;}
}));


test('history search settings are simple, editable and retain defaults',()=>withUI(body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=> 'history-form-test'};
  let saved;
  const ui=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},saveSettings:next=>{saved=next;}});
  ui.open();
  const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  const heading=walk(dialog).find(x=>x.textContent==='历史检索');
  assert.ok(heading);
  const toggle=walk(dialog).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='启用历史检索'));
  assert.ok(toggle);
  const check=walk(toggle).find(x=>x.tag==='input');
  assert.equal(check.checked,true);
  const hits=walk(dialog).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='最多参考记忆'));
  const sources=walk(dialog).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='最多补充原文'));
  assert.equal(walk(hits).find(x=>x.tag==='input').value,'5');
  assert.equal(walk(sources).find(x=>x.tag==='input').value,'3');
  check.checked=false;
  walk(hits).find(x=>x.tag==='input').value='7';
  walk(sources).find(x=>x.tag==='input').value='0';
  find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
  assert.deepEqual(saved.retrieval,{enabled:false,maxHits:7,maxSources:0});
  const visible=walk(dialog).map(x=>String(x.textContent||'')).join('\n');
  assert.doesNotMatch(visible,/保留现有.*分层规则|内部实现|内部说明|代码实现|本地开发版|使用同一次检查结果|逐级融合旧摘要，保留原始记忆/);
}));

test('source button opens original message details without mutating archived memory',()=>withUI(body=>{
  const ctx={chat:[{is_user:false,mes:'剧情正文'}],getCurrentChatId:()=> 'source-modal-test'};
  const memory=commitLeaf(freshMemory(),0,messageFingerprint(ctx.chat[0]),normalizeDelta({summary:'剧情摘要'}));
  let called=null;
  const ui=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},
    sourcePreview:(context,memo,key)=>{called=key;return [{index:0,text:'剧情：剧情正文'}];}});
  ui.open();
  const dialog=body.children[0].shadow.children[1];
  const card=find(dialog,x=>x.className==='sm-record');
  assert.ok(card);
  const source=find(card,x=>x.tag==='button'&&x.textContent==='查看原文');
  assert.ok(source);source.fire('click');
  assert.equal(called,'floor:0');
  const overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
  assert.ok(overlay);
  const area=find(overlay,x=>x.tag==='textarea');
  assert.equal(area.value,'剧情：剧情正文');
  assert.equal(area.readOnly,true);
  find(overlay,x=>x.tag==='button'&&x.textContent==='关闭').fire('click');
  assert.equal(find(dialog,x=>x.className==='sm-record-modal-overlay'),undefined);
  assert.equal(memory.leaves[0].summary,'剧情摘要');
}));

test('memory retrieval groups historical and semantic search while hiding vector setup by default',()=>withUI(body=>{
 const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};let saved;
 const view=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
   queue:{busy:false,enqueueMissing(){}},saveSettings:s=>{saved=s;}});
 view.open();const dialog=body.children[0].shadow.children[1];
 find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
 const groups=walk(dialog).filter(x=>x.className==='sm-accordion');
 assert.deepEqual(groups.map(g=>walk(g).find(x=>x.tag==='strong')?.textContent),[
   '摘要 API','摘要设置','记忆检索','记忆发送','提示配置'
 ]);
 const retrieval=groups[2],inject=groups[3];
 assert.equal(retrieval.tag,'details');
 const sections=walk(retrieval).filter(x=>x.className==='sm-memory-search-section');
 assert.equal(sections.length,2);
 assert.deepEqual(sections.map(x=>walk(x).find(y=>y.tag==='strong')?.textContent),
   ['历史检索','语义检索']);
 const historyToggle=find(sections[0],x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='启用历史检索'));
 const semanticToggle=find(sections[1],x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='启用语义检索'));
 assert.ok(historyToggle&&semanticToggle,'each search mode has an independent toggle');
 assert.equal(find(historyToggle,x=>x.tag==='input').checked,true);
 assert.equal(find(semanticToggle,x=>x.tag==='input').checked,false);
 const config=find(retrieval,x=>x.className==='sm-memory-vector-config');
 assert.ok(config,'vector API settings are inside memory retrieval');
 assert.equal(config.tag,'details');
 assert.equal(config.open,false,'technical settings are collapsed by default');
 assert.equal(config.parent,sections[1]);
 assert.equal(config.children[0].tag,'summary');
 assert.ok(walk(config).some(x=>x.textContent==='向量模型配置'));
 assert.ok(walk(config).some(x=>x.textContent==='Embedding API 密钥'));
 assert.ok(walk(config).some(x=>x.textContent==='重排模型'));
 const switches=walk(inject).filter(x=>x.className==='sm-switch-row');
 assert.equal(switches.length,4,'only four entity-memory injection switches remain');
 assert.ok(!walk(inject).some(x=>x.textContent==='剧情摘要'),
   'story summaries have no separate injection switch');
 assert.equal(walk(inject).filter(x=>x.className==='sm-switch-grid').length,1);
 assert.ok(!walk(inject).some(x=>['相关历史','向量召回'].includes(x.textContent)));
 assert.equal(walk(inject).filter(x=>x.className==='sm-switch-row').length,4);
 assert.ok(walk(inject).some(x=>x.textContent==='计划与伏笔'));
 const rerank=find(config,x=>x.className==='sm-vector-rerank');
 assert.ok(rerank);
 const fields=walk(rerank).find(x=>x.className==='sm-fields-grid');
 assert.equal(fields.hidden,true,'rerank fields remain hidden when disabled');
 const toggle=walk(rerank).find(x=>x.tag==='input'&&x.type==='checkbox');
 toggle.checked=true;toggle.fire('change');
 assert.equal(fields.hidden,false,'enabling rerank reveals its inputs');
 find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
 assert.equal(saved.vector.rerankEnabled,true);
 assert.equal(saved.retrieval.enabled,true);
 assert.equal(saved.vector.enabled,false);
 assert.ok(!Object.hasOwn(saved.injection,'retrieval'));
 assert.ok(!Object.hasOwn(saved.injection,'vector'));
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/\.sm-memory-search-section\{display:grid;gap:12px/);
 assert.match(css,/\.sm-memory-vector-config\{min-width:0;/);
 assert.match(css,/\.sm-memory-vector-config-body\{display:grid;gap:14px/);
 assert.match(css,/@media\(max-width:700px\)/);
 assert.match(css,/\.sm-fields-grid,\.sm-switch-grid\{grid-template-columns:1fr\}/);
}));

test('memory retrieval keeps old saved retrieval and vector settings independent',()=>withUI(body=>{
 const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=> 'saved-search'};let saved;
 const original=defaultSettings();original.retrieval={enabled:false,maxHits:7,maxSources:2};
 original.injection.retrieval=false;original.injection.vector=false;
 original.vector={...original.vector,enabled:true,model:'custom-embedding-model',
   key:'synthetic-vector-key',topK:3,rerankEnabled:true};
 const view=mountUI({context:()=>ctx,memory:freshMemory,settings:()=>original,
   queue:{busy:false,enqueueMissing(){}},saveSettings:s=>{saved=s;}});
 view.open();const dialog=body.children[0].shadow.children[1];
 find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
 const retrieval=find(dialog,x=>x.className==='sm-accordion'&&
   walk(x).some(y=>y.tag==='strong'&&y.textContent==='记忆检索'));
 const history=find(retrieval,x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='启用历史检索'));
 const semantic=find(retrieval,x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='启用语义检索'));
 assert.equal(find(history,x=>x.tag==='input').checked,false);
 assert.equal(find(semantic,x=>x.tag==='input').checked,true);
 const model=find(retrieval,x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='Embedding 模型'));
 assert.equal(find(model,x=>x.tag==='input').value,'custom-embedding-model');
 find(history,x=>x.tag==='input').checked=true;
 find(semantic,x=>x.tag==='input').checked=false;
 find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
 assert.deepEqual(saved.retrieval,{enabled:true,maxHits:7,maxSources:2});
 assert.equal(saved.vector.enabled,false);
 assert.equal(saved.vector.model,'custom-embedding-model');
 assert.equal(saved.vector.key,'synthetic-vector-key');
 assert.equal(saved.vector.topK,3);
 assert.equal(saved.vector.rerankEnabled,true,'collapsing the technical panel must not reset its data');
 assert.equal(Object.hasOwn(saved.injection,'retrieval'),false);
 assert.equal(Object.hasOwn(saved.injection,'vector'),false);
}));

test('settings save shows a centered transient success card and keeps the form in place',()=>withUI(body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
  const previousTimeout=globalThis.setTimeout,previousClear=globalThis.clearTimeout;
  const timers=new Map();let sequence=0,shouldFail=false,saves=0;
  globalThis.setTimeout=(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;};
  globalThis.clearTimeout=id=>timers.delete(id);
  try{
    const view=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
      queue:{busy:false,enqueueMissing(){}},
      saveSettings:()=>{if(shouldFail)throw Error('模拟保存失败');saves++;}});
    view.open();
    const dialog=body.children[0].shadow.children[1];
    find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
    const form=find(dialog,x=>x.tag==='main'),button=find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置');
    form.scrollTop=138;
    button.fire('click');
    assert.equal(saves,1);
    const toast=find(dialog,x=>x.className==='sm-save-toast');
    assert.ok(toast,'success card is visible');
    assert.equal(toast.parent,dialog,'centered relative to the dialog rather than the scrolling form');
    assert.equal(toast.attrs.role,'status');
    assert.ok(walk(toast).some(x=>x.textContent==='设置已保存'));
    assert.ok(walk(toast).some(x=>x.tag==='svg'),'success icon is shown');
    assert.equal(form.scrollTop,138,'saving must not move the settings scroll position');
    assert.equal(find(dialog,x=>x.className==='sm-notice'),undefined,'success is not duplicated at the top');
    assert.equal([...timers.values()][0]?.ms,2000);
    button.fire('click');
    assert.equal(walk(dialog).filter(x=>x.className==='sm-save-toast').length,1,'repeated saves replace the card');
    assert.equal(timers.size,1,'previous dismiss timer was canceled');
    [...timers.values()][0].fn();
    assert.equal(find(dialog,x=>x.className==='sm-save-toast'),undefined,'success card disappears automatically');
    shouldFail=true;button.fire('click');
    assert.equal(find(dialog,x=>x.className==='sm-save-toast'),undefined);
    assert.ok(find(dialog,x=>x.className==='sm-notice')?.textContent.includes('模拟保存失败'),
      'save errors still use the persistent error notice');
    shouldFail=false;button.fire('click');view.open(false);
    assert.equal(timers.size,0,'closing the extension cancels pending timers');
    assert.equal(find(dialog,x=>x.className==='sm-save-toast'),undefined);
    const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
    assert.match(css,/\.sm-save-toast\{position:absolute;left:50%;top:50%/);
    assert.match(css,/pointer-events:none/);
  }finally{globalThis.setTimeout=previousTimeout;globalThis.clearTimeout=previousClear;}
}));

test('entity merge panel aligns with other full-width cards and preserves inline controls',()=>withUI(body=>{
  const ctx={chat:[
    {is_user:false,mes:'发现银钥匙'},{is_user:false,mes:'改叫旧钥匙'}
  ],getCurrentChatId:()=> 'layout-merge'};
  let memory=commitLeaf(freshMemory(),0,messageFingerprint(ctx.chat[0]),
    normalizeDelta({summary:'第一把钥匙',items:[{op:'add',name:'银钥匙'}],
      characters:[{op:'add',name:'向导'}]}));
  memory=commitLeaf(memory,1,messageFingerprint(ctx.chat[1]),
    normalizeDelta({summary:'另一把钥匙',items:[{op:'add',name:'旧钥匙'}],
      characters:[{op:'add',name:'旅者'}]}));
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}}});
  view.open();const dialog=body.children[0].shadow.children[1];
  const selectPage=label=>find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent===label)).fire('click');
  for(const page of ['物品','角色']){
    selectPage(page);
    const list=find(dialog,x=>x.className==='sm-record-list');
    const panel=find(dialog,x=>x.className==='sm-manual sm-entity-merge-panel');
    const manual=find(dialog,x=>x.className==='sm-manual');
    assert.ok(list&&panel&&manual,page+' should have both merge and add panels');
    assert.equal(panel.parent,manual.parent,'merge panel is a full-width sibling, not inside a record');
    assert.equal(panel.parent.tag,'main');
    assert.ok(walk(panel).some(x=>x.textContent==='合并同一实体的不同称呼'));
    assert.ok(walk(panel).some(x=>x.className==='sm-btn sm-btn-primary sm-entity-merge-confirm'));
    const drawer=find(list,x=>x.className==='sm-entity-drawer-root');
    assert.ok(drawer,'record utilities use a shared compact drawer');
    const mergeTab=find(drawer,x=>x.tag==='button'&&x.textContent==='合并称呼');
    assert.ok(mergeTab);
    const controls=find(drawer,x=>x.className==='sm-entity-controls');
    assert.ok(controls);
    const panelNode=find(drawer,x=>x.className==='sm-entity-drawer'&&walk(x).includes(controls));
    assert.equal(panelNode.hidden,true,'merge is hidden before tab activation');
    mergeTab.fire('click');
    assert.equal(panelNode.hidden,false,'merge tab opens its own panel');
    assert.ok(walk(panel).every(x=>!x.className?.includes('sm-entity-merge-content')),
      'full-width merge panel does not inherit record-only spacing');
  }
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.sm-entity-drawer-root\{/);
  assert.match(css,/\.sm-entity-drawer\[hidden\]\{display:none\}/);
  assert.match(css,/\.sm-entity-merge-content\{display:grid;gap:11px/);
  assert.match(css,/\.sm-entity-merge-panel \.sm-manual-content\{display:grid;gap:12px/);
  assert.match(css,/@media\(max-width:560px\)\{[\s\S]*\.sm-entity-controls\{grid-template-columns:minmax\(0,1fr\)/);
  assert.doesNotMatch(css,/\.sm-record>\.sm-entity-merge\{/);
}));

test('long original story opens fully and older chapter floors load in pages',()=>withUI(body=>{
  const chat=[],base=freshMemory(),floors=[];let memory=base;
  for(let i=0;i<12;i++){
    const text='第'+i+'幕开头：'+'很长的剧情内容。'.repeat(260)+'第'+i+'幕最后的约定。';
    chat.push({is_user:false,mes:text,swipe_id:0});
    memory=commitLeaf(memory,i,messageFingerprint(chat[i]),normalizeDelta({summary:'第'+i+'幕完成'}));
    floors.push('floor:'+i);
  }
  memory.chapters.push({id:'chapter:all',level:1,children:floors,summary:'十二幕主线'});
  const ctx={chat,chatMetadata:{},getCurrentChatId:()=> 'paged-ui'};
  let shownArgs=[];
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},
    sourcePreview:(_ctx,_memory,_key,limit,offset)=>{
      shownArgs.push({limit,offset});
      return chat.slice(offset,offset+limit).map((item,i)=>({index:offset+i,text:item.mes}));
    }});
  view.open();const dialog=body.children[0].shadow.children[1];
  const chapter=find(dialog,x=>x.className==='sm-record');
  const source=find(chapter,x=>x.tag==='button'&&x.textContent==='查看原文');
  source.fire('click');
  const overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
  assert.ok(overlay);
  const areas=()=>walk(overlay).filter(x=>x.tag==='textarea');
  assert.equal(areas().length,5);
  assert.ok(areas()[0].value.endsWith('第0幕最后的约定。'));
  assert.ok(areas()[0].value.length>1800);
  const more=find(overlay,x=>x.tag==='button'&&x.textContent==='加载更多');
  assert.ok(more);assert.equal(more.hidden,false);
  more.fire('click');assert.equal(areas().length,10);
  more.fire('click');assert.equal(areas().length,12);
  assert.equal(more.hidden,true);
  assert.deepEqual(shownArgs.map(x=>x.offset),[0,5,10]);
  find(overlay,x=>x.tag==='button'&&x.textContent==='关闭').fire('click');
  assert.equal(find(dialog,x=>x.className==='sm-record-modal-overlay'),undefined);
}));

test('individual floor summaries show structured entity extraction counts',()=>withUI(body=>{
  const ctx={chat:[{is_user:false,mes:'发现古堡，遇见守卫，获得钥匙。'}],getCurrentChatId:()=> 'extraction-counts'};
  const memory=commitLeaf(freshMemory(),0,messageFingerprint(ctx.chat[0]),normalizeDelta({
    summary:'进入古堡，遇见守卫，获得钥匙',items:[{op:'add',name:'铜钥匙'}],
    scenes:[{op:'add',name:'古堡大厅'}],characters:[{op:'add',name:'守卫'}]
  }));
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}}});
  view.open();const dialog=body.children[0].shadow.children[1];
  const card=find(dialog,x=>x.className==='sm-record');
  const stats=find(card,x=>x.className==='sm-record-state');
  assert.equal(stats?.textContent,'本楼层更新：物品 1 · 场景 1 · 角色 1 · 计划 0');
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.sm-record-state\{margin:/);
}));

test('redundant source cap is not shown in settings and old values are discarded on save',()=>withUI(body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=> 'max-source-ui'};let saved;
  const view=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},saveSettings:s=>{saved=s;}});
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  assert.ok(!walk(dialog).some(x=>x.textContent==='单楼层原文上限（字符）'));
  find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
  assert.equal('maxInputChars' in saved.summary,false);
}));

test('legacy failed floor is retryable after automatic long-text processing',()=>withUI(body=>{
  const ctx={chat:[{is_user:true,mes:'继续'},{is_user:false,mes:'长剧情',swipe_id:0}],getCurrentChatId:()=> 'failed-floor'};
  const memory=freshMemory();memory.tasks[1]={status:'failed',code:'summary_source_oversize'};
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){},enqueue(){}}});
  view.open();const dialog=body.children[0].shadow.children[1];
  const panel=find(dialog,x=>x.attrs['data-testid']==='summary-progress');
  assert.ok(panel);
  assert.ok(walk(panel).some(x=>x.textContent==='需要关注'));
  assert.ok(walk(panel).some(x=>x.textContent==='#1 · 整理失败'));
  assert.ok(walk(panel).some(x=>x.tag==='button'&&x.textContent==='重新整理'));
  assert.ok(walk(dialog).some(x=>x.placeholder==='搜索楼层、故事时间、地点或剧情'));
}));

test('summary limits use distinct names and auto summary has a real toggle instead of an empty heading',()=>withUI(body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=> 'settings-clarity'};
  let settings=defaultSettings(),saved=null;
  const view=mountUI({context:()=>ctx,memory:freshMemory,settings:()=>settings,
    queue:{busy:false,enqueueMissing(){}},saveSettings:next=>{saved=next;settings=next;}});
  view.open();
  const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  const labels=walk(dialog).filter(x=>x.tag==='label');
  const fieldByName=name=>labels.find(x=>walk(x).some(y=>y.className==='sm-field-label'&&y.textContent===name));
  const out=fieldByName('输出上限（可选）');
  assert.ok(out);
  assert.ok(walk(out).some(x=>String(x.textContent||'').includes('留空')));
  const outInput=find(out,x=>x.tag==='input');
  assert.equal(outInput.value,'');outInput.value='4096';
  const summary=walk(dialog).find(x=>x.className==='sm-accordion'&&walk(x).some(y=>y.textContent==='摘要设置'));
  assert.ok(summary);
  assert.ok(!walk(summary).some(x=>x.className==='sm-summary-head'&&x.textContent==='自动整理'));
  const toggle=walk(summary).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='自动摘要'));
  assert.ok(toggle);
  const checkbox=find(toggle,x=>x.tag==='input');
  const delay=walk(summary).find(x=>x.className==='sm-summary-number-card'&&walk(x).some(y=>y.textContent==='延迟摘要'));
  const delayInput=find(delay,x=>x.tag==='input');
  const recent=walk(summary).find(x=>x.className==='sm-summary-number-card'&&walk(x).some(y=>y.textContent==='保留正文'));
  const recentInput=find(recent,x=>x.tag==='input');
  assert.equal(checkbox.checked,true);assert.equal(delayInput.disabled,false);
  checkbox.checked=false;checkbox.fire('change');
  assert.equal(delayInput.disabled,true,'delay is irrelevant while auto summary is off');
  assert.equal(recentInput.disabled,undefined,'manual summary still retains protected recent floors');
  checkbox.checked=true;checkbox.fire('change');assert.equal(delayInput.disabled,false);
  find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
  assert.equal(saved.autoSummary,true);
  assert.equal(saved.api.maxTokens,4096);
  assert.equal('maxInputChars' in saved.summary,false);
}));

test('injection preview opens a centered dialog without navigating away or losing settings drafts',()=>withUI(body=>{
  const ctx={chat:[{is_user:false,mes:'回忆最初的约定'}],chatMetadata:{},getCurrentChatId:()=> 'preview-modal'};
  const memory=commitLeaf(freshMemory(),0,messageFingerprint(ctx.chat[0]),
    normalizeDelta({summary:'回忆最初的约定',plans:[{op:'add',name:'完成约定',status:'未完成'}]}));
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},previewHistory:()=>[]});
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  const form=find(dialog,x=>x.tag==='main'),input=find(form,x=>x.tag==='input'&&x.placeholder==='自动');
  assert.ok(input);input.value='7777';form.scrollTop=156;
  const button=find(form,x=>x.tag==='button'&&x.textContent==='预览发送内容');
  assert.ok(button);button.fire('click');
  const overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
  assert.ok(overlay);
  const panel=find(overlay,x=>x.className==='sm-record-modal sm-preview-modal');
  assert.equal(panel.parent,overlay);
  assert.equal(panel.attrs.role,'dialog');
  assert.equal(panel.attrs['aria-modal'],'true');
  const area=find(panel,x=>x.tag==='textarea');
  assert.equal(area.readOnly,true);
  assert.ok(area.value.includes('计划与伏笔'),'plans are previewed in the same injection');
  assert.ok(walk(dialog).some(x=>x.className?.includes('sm-nav-item is-current')&&walk(x).some(y=>y.textContent==='设置')));
  const done=find(overlay,x=>x.tag==='button'&&x.textContent==='关闭');
  assert.ok(done);done.fire('click');
  assert.equal(find(dialog,x=>x.className==='sm-record-modal-overlay'),undefined);
  assert.equal(input.value,'7777');
  assert.equal(form.scrollTop,156,'preview does not reset scroll position');
  button.fire('click');
  find(dialog,x=>x.className==='sm-record-modal-overlay').fire('keydown',{
    key:'Escape',preventDefault(){},stopPropagation(){}
  });
  assert.equal(find(dialog,x=>x.className==='sm-record-modal-overlay'),undefined);
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.sm-preview-modal\{width:min\(720px,100%\)/);
}));

test('plans have a standalone page, work with old memory and can be manually maintained',()=>withUI(body=>{
  const ctx={chat:[{is_user:false,mes:'守门人承诺明日归还银盒。'}],getCurrentChatId:()=> 'plans-tab'};
  let memory=commitLeaf(freshMemory(),0,messageFingerprint(ctx.chat[0]),
    normalizeDelta({summary:'守门人承诺明日归还银盒',plans:[{
      op:'add',name:'归还银盒',status:'未完成',kind:'plan'
    }]}));
  delete memory.manual.plans; // A chat saved with an older version.
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},
    addManual:(kind,text)=>{memory=addManual(memory,kind,text);}});
  view.open();const dialog=body.children[0].shadow.children[1];
  const plansNav=find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='计划'));
  assert.ok(plansNav);plansNav.fire('click');
  const record=find(dialog,x=>x.className==='sm-record');
  assert.ok(record);assert.ok(walk(record).some(x=>x.textContent==='归还银盒'));
  const entry=find(dialog,x=>x.tag==='textarea'&&x.placeholder==='写下需要长期保留的信息…');
  assert.ok(entry);entry.value='查明密室真相';
  find(dialog,x=>x.tag==='button'&&x.textContent==='保存记录').fire('click');
  assert.equal(memory.manual.plans.length,1);
  assert.ok(deriveState(memory,ctx.chat).plans.some(x=>x.name==='查明密室真相'));
}));

test('plans injection is independent from narrative and character toggles',()=>withUI(body=>{
  const chat=[{is_user:false,mes:'守门人许诺明日送还银盒。'}];
  let memory=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),
    normalizeDelta({summary:'守门人许诺明日送还银盒',plans:[{
      op:'add',name:'归还银盒',status:'未完成',kind:'plan'
    }]}));
  const settings=defaultSettings();settings.summary.keepRecent=0;
  settings.injection.plans=true;settings.injection.summary=false;settings.injection.characters=false;
  const api={context:()=>({chat,getCurrentChatId:()=> 'plans-injection'}),memory:()=>memory,settings:()=>settings,
    queue:{busy:false,enqueueMissing(){}},saveSettings:next=>{Object.assign(settings,next);}};
  const view=mountUI(api);view.open();
  const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  const planSwitch=walk(dialog).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='计划与伏笔'));
  assert.ok(planSwitch);
  assert.equal(find(planSwitch,x=>x.tag==='input').checked,true);
  const preview=find(dialog,x=>x.tag==='button'&&x.textContent==='预览发送内容');
  preview.fire('click');
  let value=find(dialog,x=>x.tag==='textarea'&&x.attrs['aria-label']==='发送预览内容').value;
  assert.match(value,/计划与伏笔/);assert.match(value,/【剧情摘要】/);
  find(dialog,x=>x.className==='sm-record-modal-overlay').fire('click',{target:find(dialog,x=>x.className==='sm-record-modal-overlay')});
  find(planSwitch,x=>x.tag==='input').checked=false;
  find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
  preview.fire('click');
  value=find(dialog,x=>x.tag==='textarea'&&x.attrs['aria-label']==='发送预览内容').value;
  assert.doesNotMatch(value,/【计划与伏笔】/);
}));

test('preview honors unsaved history retrieval changes without saving unrelated form settings',()=>withUI(body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=> 'unsaved-retrieval'};
  let saves=0,lookups=0;
  const api={context:()=>ctx,memory:freshMemory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},
    previewHistory:()=>{lookups++;return [{text:'遥远的记忆片段'}];},
    saveSettings:()=>{saves++;}};
  const view=mountUI(api);view.open();
  const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  const button=find(dialog,x=>x.tag==='button'&&x.textContent==='预览发送内容');
  button.fire('click');
  let overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
  assert.ok(walk(overlay).some(x=>x.tag==='textarea'&&x.value.includes('遥远的记忆片段')));
  find(overlay,x=>x.tag==='button'&&x.textContent==='关闭').fire('click');
  const history=walk(dialog).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='启用历史检索'));
  assert.ok(history);
  const checkbox=find(history,x=>x.tag==='input');checkbox.checked=false;
  button.fire('click');
  overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
  const contents=find(overlay,x=>x.tag==='textarea').value;
  assert.doesNotMatch(contents,/遥远的记忆片段/);
  assert.equal(lookups,1,'disabled draft does not trigger history preview search');
  assert.equal(saves,0,'preview does not save drafts');
}));

test('old summaries with explicit opening time show labeled time and place without re-summarizing',()=>withUI(body=>{
  const chat=[{is_user:false,mes:'三月十二日清晨八点十五分，星来到家门前庭院。',swipe_id:0}];
  const ctx={chat,getCurrentChatId:()=> 'legacy-time-field'};
  const memory=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({
    summary:'三月十二日清晨八点十五分，星在庭院开始新的旅程。',
    location:'帕底亚地区-平碟镇家门前庭院'
  }));
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}}});
  view.open();
  const dialog=body.children[0].shadow.children[1];
  const card=find(dialog,x=>x.className==='sm-record');
  const info=find(card,x=>x.className==='sm-record-subtitle');
  assert.ok(info?.textContent.includes('时间：三月十二日清晨八点十五分'));
  assert.ok(info?.textContent.includes('地点：帕底亚地区-平碟镇家门前庭院'));
  find(card,x=>x.attrs['aria-label']==='编辑摘要').fire('click');
  const overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
  assert.ok(walk(overlay).some(x=>x.tag==='input'&&x.value==='三月十二日清晨八点十五分'));
  assert.equal(memory.leaves[0].time,'','fallback display must not silently rewrite old saved memory');
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.sm-record-subtitle\{[^}]*white-space:normal;overflow-wrap:anywhere/);
}));

test('Think dropdown sits with temperature and output limit and persists Auto to Max',()=>withUI(body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=> 'think-setting'};
  let cfg=defaultSettings(),saved;
  cfg.api.mode='custom';cfg.api.model='synthetic-model';cfg.api.url='https://example.invalid/v1';
  cfg.api.key='synthetic-test-only';
  const view=mountUI({context:()=>ctx,memory:freshMemory,settings:()=>cfg,
    queue:{busy:false,enqueueMissing(){}},saveSettings:s=>{saved=s;cfg=s;}});
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  const tuning=find(dialog,x=>x.className?.includes('sm-api-tuning-grid'));
  assert.ok(tuning);
  assert.equal(tuning.children.length,3,'three aligned controls under the selected model');
  const think=walk(tuning).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='Think 等级'));
  assert.ok(think);
  const select=find(think,x=>x.tag==='select');
  assert.ok(select);
  assert.deepEqual(select.children.map(x=>x.value),['auto','low','medium','high','max']);
  assert.equal(select.value,'auto');
  select.value='max';
  find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
  assert.equal(saved.api.thinkLevel,'max');
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.sm-api-tuning-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css,/@media\(max-width:700px\)[\s\S]*\.sm-api-tuning-grid\{grid-template-columns:1fr\}/);
}));


test('async queue refresh preserves open edit dialog and a dirty manual draft',()=>withUI(body=>{
  const chat=[{is_user:false,mes:'角色到达旧城。',swipe_id:0}];
  const memory=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({summary:'进入旧城'}));
  const ctx={chat,chatMetadata:{},getCurrentChatId:()=> 'keep-ui-drafts'};
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},sourcePreview:()=>[],saveSettings() {}});
  view.open();
  const dialog=body.children[0].shadow.children[1];
  const edit=find(dialog,x=>x.attrs['aria-label']==='编辑摘要');
  assert.ok(edit);
  edit.fire('click');
  const modal=find(dialog,x=>x.className==='sm-record-modal-overlay');
  const area=find(modal,x=>x.tag==='textarea');
  area.value='正在修改的剧情摘要';
  view.refresh();
  assert.ok(find(dialog,x=>x.className==='sm-record-modal-overlay')===modal);
  assert.equal(area.value,'正在修改的剧情摘要');
  const close=find(modal,x=>x.attrs['aria-label']==='关闭弹窗');
  close.fire('click');
  const manual=find(dialog,x=>x.tag==='textarea'&&x.placeholder==='写下需要长期保留的信息…');
  assert.ok(manual);
  manual.value='还没保存的手动记忆';
  find(dialog,x=>x.tag==='main').fire('input',{target:manual});
  view.refresh();
  assert.equal(manual.value,'还没保存的手动记忆');
}));


test('injection viewer distinguishes simulated content from last generation submitted text',()=>withUI(body=>{
  const ctx={chat:[{is_user:false,mes:'旧城剧情'}],chatMetadata:{},getCurrentChatId:()=> 'snapshot-preview'};
  const memory=commitLeaf(freshMemory(),0,messageFingerprint(ctx.chat[0]),normalizeDelta({summary:'旧城剧情摘要'}));
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    lastInjection:()=>({chatId:'snapshot-preview',text:'【实际提交】\n过去的剧情摘要',at:Date.now()}),
    queue:{busy:false,enqueueMissing(){}},previewHistory:()=>[]});
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  find(dialog,x=>x.tag==='button'&&x.textContent==='预览发送内容').fire('click');
  const overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
  const text=find(overlay,x=>x.tag==='textarea');
  assert.ok(!text.value.includes('实际提交'));
  const toggle=find(overlay,x=>x.tag==='button'&&x.textContent==='查看上轮扩展发送');
  assert.ok(toggle);toggle.fire('click');
  assert.equal(text.value,'【实际提交】\n过去的剧情摘要');
  assert.ok(walk(overlay).some(x=>x.className==='sm-preview-counter'&&x.textContent.includes('上轮生成时提交')));
  toggle.fire('click');
  assert.ok(!text.value.includes('实际提交'));
}));


test('long summary timelines page older records and filter by floor number',()=>withUI(body=>{
  const chat=Array.from({length:76},(_,i)=>({is_user:false,mes:'第'+i+'楼的剧情',swipe_id:0}));
  let memory=freshMemory();
  for(let i=0;i<chat.length;i++)memory=commitLeaf(memory,i,messageFingerprint(chat[i]),
    normalizeDelta({summary:'第'+i+'楼摘要'}));
  const ctx={chat,chatMetadata:{},getCurrentChatId:()=> 'long-timeline-ui'};
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},sourcePreview:()=>[]});
  view.open();const dialog=body.children[0].shadow.children[1];
  const cards=()=>walk(dialog).filter(x=>x.className==='sm-record');
  assert.equal(cards().length,50,'initial timeline renders only the newest 50');
  const more=find(dialog,x=>x.tag==='button'&&x.textContent==='加载更早的楼层摘要');
  assert.ok(more);more.fire('click');
  assert.equal(cards().length,76);
  const search=find(dialog,x=>x.attrs['aria-label']==='搜索剧情时间线');
  assert.ok(search);
  search.value='#10';
  find(dialog,x=>x.tag==='button'&&x.textContent==='搜索').fire('click');
  assert.equal(cards().length,1);
  assert.ok(walk(cards()[0]).some(x=>x.textContent==='#10'));
}));


test('retired entities are visible as historical records instead of current inventory',()=>withUI(body=>{
  const chat=[{is_user:false,mes:'获得银钥匙',swipe_id:0},{is_user:false,mes:'丢失银钥匙',swipe_id:0}];
  let memory=freshMemory();
  memory=commitLeaf(memory,0,messageFingerprint(chat[0]),normalizeDelta({summary:'获得银钥匙',items:[{op:'add',name:'银钥匙'}]}));
  memory=commitLeaf(memory,1,messageFingerprint(chat[1]),normalizeDelta({summary:'丢失银钥匙',items:[{op:'remove',name:'银钥匙'}]}));
  const ctx={chat,chatMetadata:{},getCurrentChatId:()=> 'archive-ui'};
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}}});
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='物品')).fire('click');
  assert.ok(walk(dialog).some(x=>x.textContent==='已归档物品'));
  assert.ok(walk(dialog).some(x=>x.textContent==='归档于 #1'));
  assert.ok(find(dialog,x=>x.className==='sm-entity-history'));
}));


test('entity correction stays collapsed by default and updates only after explicit save',()=>withUI(body=>{
  const chat=[{is_user:false,mes:'守门人目前受伤。',swipe_id:0}];
  let memory=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({
    summary:'守门人受伤',characters:[{op:'add',name:'守门人',status:'受伤'}]
  }));
  const ctx={chat,chatMetadata:{},getCurrentChatId:()=> 'editable-character'};
  const changed=[];
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},
    correctEntity:(kind,id,values)=>{changed.push({kind,id,values});memory=correctEntity(memory,chat,kind,id,values);},
    clearEntityCorrection:(kind,id)=>{memory=clearEntityCorrection(memory,kind,id);}});
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='角色')).fire('click');
  const correction=find(dialog,x=>x.className==='sm-entity-panel-content'&&
    walk(x).some(y=>y.tag==='button'&&y.textContent==='保存纠错'));
  assert.ok(correction);
  assert.equal(correction.parent.hidden,true,'correction is hidden before choosing its tab');
  const tab=find(dialog,x=>x.tag==='button'&&String(x.textContent).startsWith('人工纠错'));
  tab.fire('click');
  assert.equal(correction.parent.hidden,false);
  const input=find(correction,x=>x.attrs['aria-label']==='守门人 · 状态');
  input.value='痊愈';
  assert.equal(changed.length,0,'typing must not silently persist the result');
  find(correction,x=>x.tag==='button'&&x.textContent==='保存纠错').fire('click');
  assert.equal(changed.length,1);
  assert.equal(deriveState(memory,chat).characters[0].status,'痊愈');
  view.refresh(true);
  assert.ok(find(dialog,x=>x.textContent==='人工纠错 · 已生效'));
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.sm-entity-correction-fields\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css,/@media\(max-width:700px\)\{\.sm-entity-correction-fields\{grid-template-columns:1fr\}/);
}));

test('injection preview reveals per-section character count in a collapsed drawer',()=>withUI(body=>{
  const chat=[{is_user:false,mes:'记住这些剧情',swipe_id:0}];
  const memory=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({summary:'回到故乡'}));
  const ctx={chat,chatMetadata:{},getCurrentChatId:()=> 'budget-ui'};
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},previewHistory:()=>[]});
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  find(dialog,x=>x.tag==='button'&&x.textContent==='预览发送内容').fire('click');
  const drawer=find(dialog,x=>x.className==='sm-injection-breakdown');
  assert.ok(drawer);
  assert.equal(drawer.open,false);
  assert.ok(walk(drawer).some(x=>String(x.textContent||'').includes('记忆组成')));
  assert.ok(walk(dialog).some(x=>x.textContent==='Token（约）'));
  assert.ok(walk(dialog).some(x=>x.textContent==='字符数'));
}));

test('plans, items, scenes and characters share tidy metadata and closed utility rows',()=>withUI(body=>{
  const chat=[{is_user:false,mes:'事件发生',swipe_id:0}];
  const ctx={chat,getCurrentChatId:()=> 'entity-layout-all'};
  const memory=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({
    summary:'记下四类实体',
    items:[{op:'add',name:'银钥匙',location:'口袋'},{op:'add',name:'铜钥匙'}],
    scenes:[{op:'add',name:'广场',location:'城内'},{op:'add',name:'花园'}],
    characters:[{op:'add',name:'守卫',status:'受伤'},{op:'add',name:'旅人'}],
    plans:[{op:'add',name:'找回钥匙',description:'钥匙已经找回。',status:'已完成',location:'广场',time:'上午'},
      {op:'add',name:'修复城门',status:'进行中'}]
  }));
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}}});
  view.open();const dialog=body.children[0].shadow.children[1];
  const selectPage=label=>find(dialog,x=>x.className?.includes('sm-nav-item')&&
    walk(x).some(y=>y.textContent===label)).fire('click');
  for(const page of ['物品','场景','角色','计划']){
    selectPage(page);
    const current=find(dialog,x=>x.className==='sm-record-list');
    const card=find(current,x=>x.className==='sm-record');
    assert.ok(card,page+' needs a record card');
    const details=find(card,x=>x.className==='sm-entity-drawer-root');
    assert.ok(details);
    const merge=find(details,x=>x.tag==='button'&&x.textContent==='合并称呼');
    assert.ok(merge,page+' merge belongs to a shared tabs drawer');
    const panel=find(details,x=>x.className==='sm-entity-panel-content'&&
      walk(x).some(y=>y.className==='sm-entity-controls'));
    assert.equal(panel.parent.hidden,true,'merge drawer is initially hidden');
    assert.ok(walk(details).every(x=>x.className!=='sm-entity-hint'||x.parent?.className==='sm-entity-merge-content'));
  }
  selectPage('计划');
  const plans=find(dialog,x=>x.className==='sm-record-list');
  const planCard=find(plans,x=>x.className==='sm-record');
  assert.ok(walk(dialog).some(x=>x.tag==='h3'&&x.textContent==='计划记录'));
  const status=find(planCard,x=>x.className?.startsWith('sm-record-status'));
  assert.equal(status?.textContent,'已完成');
  assert.ok(status.className.includes('is-complete'));
  const description=find(planCard,x=>x.className==='sm-record-text');
  assert.equal(description?.textContent,'钥匙已经找回。');
  const facts=find(planCard,x=>x.className==='sm-entity-facts');
  assert.ok(facts);
  assert.ok(walk(facts).some(x=>x.textContent==='位置：'));
  assert.ok(walk(facts).some(x=>x.textContent==='时间：'));
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.sm-entity-facts\{display:flex;flex-wrap:wrap/);
  assert.match(css,/\.sm-entity-fact-value\{min-width:0;overflow-wrap:anywhere/);
  assert.match(css,/\.sm-record-status\{flex-shrink:0;max-width/);
}));

test('settings show consistent concise Chinese labels and readable preview naming',()=>withUI(body=>{
  const view=mountUI({context:()=>({chat:[],chatMetadata:{},getCurrentChatId:()=>''}),
    memory:freshMemory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},previewHistory:()=>[]});
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  const headings=walk(dialog).filter(x=>x.className==='sm-accordion')
    .map(group=>walk(group).find(x=>x.tag==='strong')?.textContent);
  assert.deepEqual(headings,['摘要 API','摘要设置','记忆检索','记忆发送','提示配置']);
  assert.ok(headings.slice(1).every(x=>x.length===4),
    'non-API settings headings should share the same visual width');
  assert.ok(walk(dialog).some(x=>x.textContent==='启用剧情记忆'));
  assert.ok(walk(dialog).some(x=>x.textContent==='自定义楼层摘要与分层总结提示词'));
  assert.ok(walk(dialog).some(x=>x.textContent==='记忆长度上限（约 Tokens）'));
  const send=walk(dialog).find(x=>x.className==='sm-accordion'&&
    walk(x).some(y=>y.tag==='strong'&&y.textContent==='记忆发送'));
  assert.equal(walk(send).filter(x=>x.className==='sm-switch-row').length,4);
  const preview=find(send,x=>x.tag==='button'&&x.textContent==='预览发送内容');
  assert.ok(preview);
  assert.ok(!walk(dialog).some(x=>['启用记忆引擎','注入设置','自定义提示词',
    'RP 记忆预算（近似 Tokens）','查看注入预览'].includes(x.textContent)));
  preview.fire('click');
  const modal=find(dialog,x=>x.className==='sm-record-modal sm-preview-modal');
  assert.ok(modal);
  assert.ok(walk(modal).some(x=>x.className==='sm-record-modal-title'&&x.textContent==='发送预览'));
  assert.ok(walk(modal).some(x=>x.tag==='textarea'&&x.attrs['aria-label']==='发送预览内容'));
  assert.ok(walk(modal).some(x=>String(x.textContent||'').includes('当前草稿模拟')));
  assert.equal(walk(modal).filter(x=>x.className==='sm-preview-stat').length,2);
  assert.match(readFileSync(new URL('../style.css',import.meta.url),'utf8'),/\.sm-preview-stats\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.sm-accordion-head\{display:flex;align-items:center;justify-content:space-between;gap:12px/);
  assert.match(css,/\.sm-accordion-copy\{display:flex;flex-direction:column;gap:2px/);
  assert.match(css,/\.sm-accordion-copy\{[^}]*min-width:0/);
  assert.match(css,/\.sm-accordion-copy small\{[^}]*overflow-wrap:anywhere/);
  assert.match(css,/@media\(max-width:700px\)[\s\S]*\.sm-fields-grid,\.sm-switch-grid\{grid-template-columns:1fr\}/);
}));

test('L0 extraction switches preserve drafts and preview exact model-facing prompt',()=>withUI(body=>{
  const cfg=defaultSettings();let saved;
  const view=mountUI({context:()=>({chat:[],chatMetadata:{},getCurrentChatId:()=> 'extraction-ui'}),
    memory:freshMemory,settings:()=>cfg,saveSettings:value=>{saved=value;},
    queue:{busy:false,enqueueMissing(){}}});
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  const promptPanel=find(dialog,x=>x.className==='sm-accordion'&&
    walk(x).some(y=>y.tag==='strong'&&y.textContent==='提示配置'));
  assert.ok(promptPanel);
  const extraction=find(promptPanel,x=>x.className==='sm-extraction-panel');
  assert.ok(extraction);
  const rows=walk(extraction).filter(x=>x.className==='sm-switch-row');
  assert.equal(rows.length,4);
  const labels=['提取物品','提取场景','提取人物','提取计划'];
  assert.deepEqual(rows.map(row=>walk(row).find(x=>x.tag==='strong')?.textContent),labels);
  assert.ok(rows.every(row=>find(row,x=>x.tag==='input').checked));
  const first=find(promptPanel,x=>x.className==='sm-prompt-group');
  const editor=find(first,x=>x.tag==='textarea');
  assert.ok(editor.value.includes('【物品 items】'));
  editor.value='只按事实摘要，别复制这个示例：{"summary":"示例"}';
  find(rows[0],x=>x.tag==='input').checked=false;
  find(rows[2],x=>x.tag==='input').checked=false;
  const preview=find(first,x=>x.tag==='button'&&x.textContent==='预览最终提示词');
  assert.ok(preview);preview.fire('click');
  const overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
  const rendered=find(overlay,x=>x.tag==='textarea'&&x.attrs['aria-label']==='最终 L0 提示词');
  assert.ok(rendered?.readOnly);
  assert.ok(rendered.value.startsWith(editor.value));
  assert.ok(rendered.value.includes('固定输出协议'));
  assert.doesNotMatch(rendered.value,/"items":\s*\[/);
  assert.doesNotMatch(rendered.value,/"characters":\s*\[/);
  assert.match(rendered.value,/"scenes":\s*\[/);
  assert.match(rendered.value,/"plans":\s*\[/);
  find(overlay,x=>x.tag==='button'&&x.textContent==='关闭').fire('click');
  assert.equal(saved,undefined,'preview must not save settings');
  find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
  assert.equal(saved.extraction.items,false);
  assert.equal(saved.extraction.scenes,true);
  assert.equal(saved.extraction.characters,false);
  assert.equal(saved.extraction.plans,true);
  assert.equal(saved.prompts.summaryFull,editor.value);
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.sm-extraction-panel\{[^}]*min-width:0/);
  assert.match(css,/\.sm-prompt-actions\{[^}]*flex-wrap:wrap/);
}));

test('Token counters use native tokenizer and Unicode characters correctly',()=>withUI(async body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=> 'metrics',getTokenCountAsync:async()=>37};
  const view=mountUI({context:()=>ctx,memory:()=>addManual(freshMemory(),'summaries','旅途🙂'),
    settings:defaultSettings,queue:{busy:false,enqueueMissing(){}},previewHistory:()=>[]});
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  find(dialog,x=>x.tag==='button'&&x.textContent==='预览发送内容').fire('click');
  await new Promise(resolve=>setImmediate(resolve));
  const stats=walk(dialog).filter(x=>x.className==='sm-preview-stat');
  assert.equal(stats.length,2);
  assert.equal(walk(stats[0]).find(x=>x.className==='sm-preview-stat-value').textContent,'37');
  const area=walk(dialog).find(x=>x.tag==='textarea'&&x.attrs['aria-label']==='发送预览内容');
  const {characterCount}=await import('../text-stats.js');
  assert.equal(Number(walk(stats[1]).find(x=>x.className==='sm-preview-stat-value').textContent.replace(/,/g,'')),characterCount(area.value));
}));

test('field locks render as compact controls and warn before overwriting newer plot facts',()=>withUI(body=>{
  const chat=[
    {is_user:false,mes:'守门人保护主角。',swipe_id:0},
    {is_user:false,mes:'守门人后来加入敌方。',swipe_id:0}
  ];
  let memory=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({
    summary:'守门人保护主角',characters:[{op:'add',name:'守门人',relationship:'盟友',evidence:'守门人保护主角。'}]
  }));
  const ctx={chat,chatMetadata:{},getCurrentChatId:()=> 'field-lock-ui'};
  const calls=[];
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},
    correctEntity:(kind,id,values,locks)=>{calls.push({kind,id,values,locks});memory=correctEntity(memory,chat,kind,id,values,locks);},
    clearEntityCorrection:(kind,id)=>{memory=clearEntityCorrection(memory,kind,id);}});
  view.open();
  const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='角色')).fire('click');
  let form=find(dialog,x=>x.className==='sm-entity-panel-content'&&walk(x).some(y=>y.tag==='button'&&y.textContent==='保存纠错'));
  const titleLock=find(form,x=>x.attrs['aria-label']==='守门人 · 锁定名称');
  const relationLock=find(form,x=>x.attrs['aria-label']==='守门人 · 锁定关系');
  assert.ok(titleLock&&relationLock);
  titleLock.checked=true;
  relationLock.checked=true;
  find(form,x=>x.tag==='button'&&x.textContent==='保存纠错').fire('click');
  assert.equal(calls.length,1);
  assert.equal(calls[0].locks.name,true);
  assert.equal(calls[0].locks.relationship,true);
  assert.equal(deriveState(memory,chat).characters[0].relationship,'盟友');
  const id=deriveState(memory,chat).characters[0].entity_id;
  memory=commitLeaf(memory,1,messageFingerprint(chat[1]),normalizeDelta({
    summary:'守门人反叛',characters:[{op:'update',name:'守门人',entity_id:id,relationship:'敌人',
      evidence:'守门人后来加入敌方。'}]
  }));
  view.refresh(true);
  form=find(dialog,x=>x.className==='sm-entity-panel-content'&&walk(x).some(y=>y.tag==='button'&&y.textContent==='保存纠错'));
  assert.ok(walk(form).some(x=>String(x.textContent||'').includes('新剧情与锁定字段不一致')));
  assert.equal(deriveState(memory,chat).characters[0].relationship,'盟友');
  const latestRelationLock=find(form,x=>x.attrs['aria-label']==='守门人 · 锁定关系');
  latestRelationLock.checked=false;
  find(form,x=>x.tag==='button'&&x.textContent==='保存纠错').fire('click');
  assert.equal(deriveState(memory,chat).characters[0].relationship,'敌人');
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.sm-correction-field-heading/);
  assert.match(css,/\.sm-lock-checkbox/);
}));

test('semantic search displays background index state without resetting settings drafts',()=>withUI(body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=> 'vector-status-ui'};
  const status={enabled:true,busy:false,pending:true,error:'',lastCount:0};
  const view=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
    vectorStatus:()=>status,queue:{busy:false,enqueueMissing(){}}});
  view.open();
  const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  const label=find(dialog,x=>x.className==='sm-help sm-vector-index-status');
  assert.match(label.textContent,/等待后台更新/);
  const key=find(dialog,x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='Embedding API 密钥'));
  const input=walk(key).find(x=>x.tag==='input');
  input.value='draft-not-saved';
  status.pending=false;status.busy=true;
  view.updateVectorStatus();
  assert.match(label.textContent,/后台更新中/);
  assert.equal(input.value,'draft-not-saved');
  status.busy=false;status.error='Embedding API HTTP 503';
  view.updateVectorStatus();
  assert.match(label.textContent,/索引失败/);
  assert.equal(input.value,'draft-not-saved');
}));

test('mobile navigation exposes all six tabs without horizontal scrolling',()=>{
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/@media\(max-width:430px\)\{\s*\.sm-nav\{display:grid;grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(css,/\.sm-nav-item\{min-width:0;width:100%;justify-content:center;gap:3px/);
});

test('processing console expands groups, retries individual floors and keeps original timeline',()=>withUI(body=>{
  const ctx={chat:Array.from({length:5},(_,i)=>({is_user:false,mes:'synthetic floor '+i,swipe_id:0})),
    getCurrentChatId:()=> 'console-test'};
  let memory=commitLeaf(freshMemory(),0,messageFingerprint(ctx.chat[0]),
    normalizeDelta({summary:'synthetic timeline',time:'2026/11/14',location:'test area'}));
  memory.tasks[1]={status:'failed',code:'upstream_http_401',attempts:3,updatedAt:Date.now(),
    fingerprint:messageFingerprint(ctx.chat[1])};
  const config=defaultSettings();config.summary.delayFloors=1;
  const enqueued=[];
  const ui=mountUI({context:()=>ctx,memory:()=>memory,settings:()=>config,
    queue:{busy:false,enqueueMissing(){},enqueue:indices=>enqueued.push(indices)}});
  ui.open();
  const dialog=body.children[0].shadow.children[1];
  assert.ok(find(dialog,x=>x.attrs['data-testid']==='summary-progress'));
  assert.ok(walk(dialog).some(x=>x.textContent==='剧情时间线'));
  const retry=find(dialog,x=>x.tag==='button'&&x.textContent==='重新整理');
  assert.ok(retry);retry.fire('click');
  assert.deepEqual(enqueued,[[1]]);
  const viewAll=find(dialog,x=>x.tag==='button'&&x.className==='sm-progress-expand');
  assert.ok(viewAll);viewAll.fire('click');
  assert.ok(find(dialog,x=>x.className==='sm-progress-all'));
  const ready=find(dialog,x=>x.className==='sm-progress-group-head'&&walk(x).some(t=>t.textContent==='等待整理'));
  assert.ok(ready);ready.fire('click');
  const detail=find(dialog,x=>x.className==='sm-progress-details');
  assert.ok(detail);
  const openReady=find(dialog,x=>x.className==='sm-progress-group-head'&&walk(x).some(t=>t.textContent==='等待整理'));
  assert.equal(openReady.attrs['aria-expanded'],'true');
  openReady.fire('click');
  const collapsed=find(dialog,x=>x.className==='sm-progress-group-head'&&walk(x).some(t=>t.textContent==='等待整理'));
  assert.equal(collapsed.attrs['aria-expanded'],'false','user can collapse all groups');
  ui.showFailures();
  const again=find(dialog,x=>x.className==='sm-progress-group-head'&&walk(x).some(t=>t.textContent==='需要关注'));
  assert.equal(again.attrs['aria-expanded'],'true');
  assert.ok(walk(dialog).some(x=>x.textContent==='剧情时间线'));
}));

test('injection preview shows actual token usage and explains excluded candidate counts',()=>withUI(async body=>{
  const memory=freshMemory(),settings=defaultSettings();
  settings.injection.budget=400;
  memory.manual.summaries=[
    {id:'x',text:'短记忆'},
    {id:'y',text:'短记忆'},
    {id:'z',text:'超长记忆'.repeat(450)},
    {id:'w',text:' '}
  ];
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=> 'injection-exclusions',
    getTokenCountAsync:async value=>Math.ceil(value.length/3)};
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:()=>settings,
    queue:{busy:false,enqueueMissing(){}},previewHistory:()=>[]});
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  find(dialog,x=>x.tag==='button'&&x.textContent==='预览发送内容').fire('click');
  await new Promise(resolve=>setTimeout(resolve,20));
  const skipped=find(dialog,x=>x.className==='sm-preview-skipped');
  assert.ok(skipped);
  assert.match(skipped.textContent,/跳过 3 条/);
  assert.match(skipped.textContent,/容量不足 1、重复 1、空记录 1/);
  const usage=find(dialog,x=>x.className==='sm-preview-counter');
  assert.match(usage.textContent,/400 Tokens/);
  const drawer=find(dialog,x=>x.className==='sm-injection-breakdown');
  assert.ok(walk(drawer).some(x=>String(x.textContent||'').includes('容量不足 1 条')));
  const field=find(dialog,x=>x.attrs['aria-label']==='发送预览内容');
  assert.ok(field);assert.ok(field.value.includes('短记忆'));
  const bodyContent=find(dialog,x=>x.className==='sm-record-modal-body'&&
    walk(x).some(y=>y.className==='sm-preview-skipped'));
  assert.ok(bodyContent.children.indexOf(skipped)<bodyContent.children.indexOf(field),
    'over-budget alert must stay above the long memory textarea');
}));

test('settings drafts require confirmation before navigation and closing, while reverted edits do not',()=>withUI(body=>{
  const prevWindow=globalThis.window;
  const asked=[],answers=[false,true,false,true];
  globalThis.window={confirm:message=>{asked.push(message);return answers.shift()??true;}};
  try{
    const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
    let writes=0;
    const view=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
      queue:{busy:false,enqueueMissing(){}},saveSettings:()=>writes++});
    view.open();
    const dialog=body.children[0].shadow.children[1];
    const nav=name=>find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent===name));
    nav('设置').fire('click');
    const budget=find(dialog,x=>x.className==='sm-field'&&walk(x).some(y=>y.textContent==='记忆长度上限（约 Tokens）'));
    const input=find(budget,x=>x.tag==='input');
    input.value='12000';input.fire('input');
    nav('摘要').fire('click');
    assert.ok(nav('设置').className.includes('is-current'),'cancel navigation keeps edited form open');
    assert.equal(input.value,'12000');
    nav('摘要').fire('click');
    assert.ok(nav('摘要').className.includes('is-current'),'confirmed exit discards edits');
    nav('设置').fire('click');
    const now=find(dialog,x=>x.className==='sm-field'&&walk(x).some(y=>y.textContent==='记忆长度上限（约 Tokens）'));
    assert.equal(find(now,x=>x.tag==='input').value,'16000','discarded edit never persisted');
    const current=find(now,x=>x.tag==='input');
    current.value='14000';current.fire('input');
    dialog.fire('cancel');
    assert.equal(dialog.open,true,'Escape must not silently discard settings');
    dialog.fire('cancel');
    assert.equal(dialog.open,false,'Escape can close after explicit confirmation');
    assert.equal(asked.length,4);
    assert.equal(writes,0);
  }finally{globalThis.window=prevWindow;}
}));

test('restored defaults remain only a draft and can be discarded without saving',()=>withUI(body=>{
  const prevWindow=globalThis.window,answers=[true,false,true];
  globalThis.window={confirm:()=>answers.shift()??true};
  try{
    const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
    const cfg=defaultSettings();cfg.summary.delayFloors=9;
    let writes=0;
    const ui=mountUI({context:()=>ctx,memory:freshMemory,settings:()=>cfg,
      queue:{busy:false,enqueueMissing(){}},saveSettings:()=>writes++});
    ui.open();const dialog=body.children[0].shadow.children[1];
    const nav=name=>find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent===name));
    nav('设置').fire('click');
    find(dialog,x=>x.attrs['data-testid']==='reset-settings').fire('click');
    assert.equal(writes,0);
    assert.ok(find(dialog,x=>x.className==='sm-settings-draft-note'));
    const delay=find(dialog,x=>x.className==='sm-summary-number-card'&&walk(x).some(y=>y.textContent==='延迟摘要'));
    assert.equal(find(delay,x=>x.tag==='input').value,'3');
    nav('摘要').fire('click');
    assert.ok(nav('设置').className.includes('is-current'),'declined discard must keep reset draft');
    nav('摘要').fire('click');
    nav('设置').fire('click');
    const original=find(dialog,x=>x.className==='sm-summary-number-card'&&walk(x).some(y=>y.textContent==='延迟摘要'));
    assert.equal(find(original,x=>x.tag==='input').value,'9','discarding reset must restore saved values');
    assert.equal(writes,0);
  }finally{globalThis.window=prevWindow;}
}));

test('numeric settings reject out-of-range and fractional values instead of saving a different result',()=>withUI(body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
  let saved=null,writes=0;
  const ui=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},saveSettings:s=>{saved=s;writes++;}});
  ui.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  const save=()=>find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
  const budget=find(dialog,x=>x.className==='sm-field'&&walk(x).some(y=>y.textContent==='记忆长度上限（约 Tokens）'));
  const budgetInput=find(budget,x=>x.tag==='input');
  for(const invalid of ['30000','399','12.5','','abc','Infinity']){
    budgetInput.value=invalid;save();
    assert.equal(writes,0,invalid+' may not be saved');
    assert.equal(budgetInput.attrs['aria-invalid'],'true');
    assert.match(find(dialog,x=>x.className==='sm-notice')?.textContent||'',/记忆长度上限/);
  }
  budgetInput.value='18000';budgetInput.fire('input');
  assert.equal(budgetInput.attrs['aria-invalid'],'false');
  const retry=find(dialog,x=>x.className==='sm-summary-retry');
  const retryInput=find(retry,x=>x.tag==='input');
  retryInput.value='1.5';save();
  assert.equal(writes,0,'integer-only retries cannot be fractional');
  assert.equal(retryInput.attrs['aria-invalid'],'true');
  retryInput.value='2';save();
  assert.equal(writes,1);
  assert.equal(saved.injection.budget,18000);
  assert.equal(saved.summary.retry,2);
}));

test('history count inputs disable with retrieval without erasing their saved values',()=>withUI(body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
  const cfg=defaultSettings();cfg.retrieval={enabled:false,maxHits:7,maxSources:2};
  let saved=null;
  const ui=mountUI({context:()=>ctx,memory:freshMemory,settings:()=>cfg,
    queue:{busy:false,enqueueMissing(){}},saveSettings:s=>saved=s});
  ui.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  const retrieval=find(dialog,x=>x.className==='sm-accordion'&&walk(x).some(y=>y.tag==='strong'&&y.textContent==='记忆检索'));
  const control=find(retrieval,x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='启用历史检索'));
  const toggle=find(control,x=>x.tag==='input');
  const a=find(retrieval,x=>x.className==='sm-field'&&walk(x).some(y=>y.textContent==='最多参考记忆'));
  const b=find(retrieval,x=>x.className==='sm-field'&&walk(x).some(y=>y.textContent==='最多补充原文'));
  const ai=find(a,x=>x.tag==='input'),bi=find(b,x=>x.tag==='input');
  assert.equal(ai.disabled,true);assert.equal(bi.disabled,true);
  assert.equal(ai.value,'7');assert.equal(bi.value,'2');
  toggle.checked=true;toggle.fire('change');
  assert.equal(ai.disabled,false);assert.equal(bi.disabled,false);
  ai.value='8';bi.value='4';
  toggle.checked=false;toggle.fire('change');
  assert.equal(ai.disabled,true);assert.equal(ai.value,'8','disabled values remain a draft');
  find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
  assert.equal(saved.retrieval.enabled,false);
  assert.equal(saved.retrieval.maxHits,8,'count changes made before disabling are preserved');
  assert.equal(saved.retrieval.maxSources,4);
  assert.ok(walk(dialog).some(x=>String(x.textContent||'').includes('自动隐藏时保留最近 N 楼原文')));
}));

test('injection preview validates the same token budget limit as saving',()=>withUI(body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
  const ui=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},previewHistory:()=>[]});
  ui.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  const budget=find(dialog,x=>x.className==='sm-field'&&walk(x).some(y=>y.textContent==='记忆长度上限（约 Tokens）'));
  const input=find(budget,x=>x.tag==='input');
  input.value='30000';
  find(dialog,x=>x.tag==='button'&&x.textContent==='预览发送内容').fire('click');
  assert.equal(input.attrs['aria-invalid'],'true');
  assert.equal(find(dialog,x=>x.className==='sm-record-modal-overlay'),undefined);
  assert.match(find(dialog,x=>x.className==='sm-notice')?.textContent||'',/记忆长度上限/);
}));

test('summary page offers explicit restoration of hidden text only after auto-hide is disabled',()=>withUI(async body=>{
  const oldWindow=globalThis.window;
  let confirmResult=false,restored=0;
  globalThis.window={confirm:()=>confirmResult};
  try{
    const chat=[{is_user:true,is_system:true,extra:{story_memory_hidden:true},mes:'我决定出发。'},
      {is_user:false,is_system:true,extra:{story_memory_hidden:true},mes:'出发经过森林。'}];
    const cfg=defaultSettings();cfg.summary.autoHide=false;
    const ctx={chat,chatMetadata:{},getCurrentChatId:()=> 'hidden-restore-demo'};
    const queue={busy:false,enqueueMissing(){},restoreAllHidden:async()=>{
      restored++;for(const m of chat){m.is_system=false;delete m.extra.story_memory_hidden;}return 2;
    }};
    const ui=mountUI({context:()=>ctx,memory:freshMemory,settings:()=>cfg,queue});
    ui.open();const dialog=body.children[0].shadow.children[1];
    let restore=find(dialog,x=>x.tag==='button'&&x.textContent==='恢复已隐藏正文');
    assert.ok(restore,'explicit restoration is accessible on the summary page');
    assert.ok(walk(dialog).some(x=>String(x.textContent||'').includes('不删除摘要')));
    restore.fire('click');
    assert.equal(restored,0,'cancel confirmation changes nothing');
    confirmResult=true;restore.fire('click');
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(restored,1);
    assert.ok(chat.every(x=>!x.is_system));
    assert.equal(find(dialog,x=>x.tag==='button'&&x.textContent==='恢复已隐藏正文'),undefined);
  }finally{globalThis.window=oldWindow;}
}));

test('chapter compression failure is visible in summary and can be retried without clearing leaves',()=>withUI(async body=>{
  const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=> 'chapter-failure'};
  const cfg=defaultSettings(),mem=freshMemory();
  mem.chapterError={code:'chapter_no_progress',message:'分层总结没有缩短内容',updatedAt:Date.now()};
  let calls=0;
  const queue={busy:false,enqueueMissing(){},retryChapters:async()=>{calls++;delete mem.chapterError;return true;}};
  const view=mountUI({context:()=>ctx,memory:()=>mem,settings:()=>cfg,queue});
  view.open();const dialog=body.children[0].shadow.children[1];
  const alert=find(dialog,x=>x.className==='sm-chapter-warning');
  assert.ok(alert);
  assert.ok(walk(alert).some(x=>String(x.textContent||'').includes('分层总结没有缩短内容')));
  const retry=find(alert,x=>x.tag==='button'&&x.textContent==='重试分层压缩');
  assert.ok(retry);retry.fire('click');
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(calls,1);
  assert.equal(find(dialog,x=>x.className==='sm-chapter-warning'),undefined);
}));

test('completed progress compacts only when truly complete, with working expand/collapse controls',()=>withUI(body=>{
  const chat=[{is_user:false,swipe_id:0,mes:'已完成的剧情'}];
  const memory=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({summary:'已总结剧情'}));
  const ctx={chat,getCurrentChatId:()=> 'complete-progress'};
  const ui=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,queue:{busy:false,enqueueMissing(){}}});
  ui.open();const dialog=body.children[0].shadow.children[1];
  assert.ok(find(dialog,x=>x.className==='sm-status-strip'));
  assert.equal(find(dialog,x=>x.className==='sm-metrics'),undefined);
  find(dialog,x=>x.tag==='button'&&x.textContent==='展开进度').fire('click');
  assert.ok(find(dialog,x=>x.className==='sm-metrics'));
  assert.ok(find(dialog,x=>x.attrs['data-testid']==='summary-progress'));
  find(dialog,x=>x.tag==='button'&&x.textContent==='收起进度').fire('click');
  assert.ok(find(dialog,x=>x.className==='sm-status-strip'));
  const withDelay=[...chat,{is_user:false,swipe_id:0,mes:'新剧情'}];
  ctx.chat=withDelay;ui.refresh(true);
  assert.equal(find(dialog,x=>x.className==='sm-status-strip'),undefined,'pending or delayed floors need full status');
  assert.ok(find(dialog,x=>x.attrs['data-testid']==='summary-progress'));
}));

test('background refresh preserves expanded floor and entity cards across page changes',()=>withUI(body=>{
  const chat=[{is_user:false,swipe_id:0,mes:'守卫持有钥匙'}];
  const memory=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({
    summary:'守卫持有钥匙',items:[{op:'add',name:'钥匙',owner:'守卫'}]
  }));
  const ctx={chat,getCurrentChatId:()=> 'keep-open-card'};
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}}});
  view.open();const dialog=body.children[0].shadow.children[1];
  let card=find(dialog,x=>x.tag==='details'&&x.attrs['data-record-key']==='floor:0');
  card.open=true;card.fire('toggle');
  view.refresh();
  card=find(dialog,x=>x.tag==='details'&&x.attrs['data-record-key']==='floor:0');
  assert.equal(card.open,true,'floor stays open after queue refresh');
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='物品')).fire('click');
  card=find(dialog,x=>x.tag==='details'&&x.attrs['data-record-key']?.startsWith('entity:items:'));
  card.open=true;card.fire('toggle');
  view.refresh();
  card=find(dialog,x=>x.tag==='details'&&x.attrs['data-record-key']?.startsWith('entity:items:'));
  assert.equal(card.open,true,'entity card stays open');
  const chip=find(card,x=>x.className?.includes('sm-meta-chip')&&x.textContent.includes('守卫'));
  assert.ok(chip,'owner visible while collapsed');
  assert.ok(find(card,x=>x.className==='sm-entity-tabs'));
  view.resetChatView();
  view.refresh(true);
  card=find(dialog,x=>x.tag==='details'&&x.attrs['data-record-key']?.startsWith('entity:items:'));
  assert.equal(card.open,false,'new chat does not inherit old open cards');
}));

test('timeline query updates only its list after debounce; search and clear buttons preserve the field',()=>withUI(async body=>{
  const chat=[{is_user:false,swipe_id:0,mes:'城堡门打开'},{is_user:false,swipe_id:0,mes:'森林里找到地图'}];
  let memory=freshMemory();
  for(const [i,summary] of ['城堡的守门人','森林的地图'].entries())
    memory=commitLeaf(memory,i,messageFingerprint(chat[i]),normalizeDelta({summary}));
  const ctx={chat,getCurrentChatId:()=> 'search-only'};
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,queue:{busy:false,enqueueMissing(){}}});
  view.open();const dialog=body.children[0].shadow.children[1];
  let search=find(dialog,x=>x.attrs['aria-label']==='搜索剧情时间线');
  const before=search,main=find(dialog,x=>x.tag==='main');
  search.value='森林';search.fire('input');main.fire('input',{target:search});
  await new Promise(resolve=>setTimeout(resolve,190));
  assert.ok(walk(dialog).includes(before),'typing preserves the exact search control');
  assert.equal(find(dialog,x=>x.className==='sm-record-list is-timeline')?.children.length,1);
  assert.equal(find(dialog,x=>x.attrs['data-record-key']==='floor:1')?.tag,'details');
  assert.equal(find(dialog,x=>x.attrs['data-record-key']==='floor:0'),undefined);
  search.value='城堡';
  find(dialog,x=>x.tag==='button'&&x.textContent==='搜索').fire('click');
  assert.ok(walk(dialog).includes(before));
  assert.ok(find(dialog,x=>x.attrs['data-record-key']==='floor:0'));
  find(dialog,x=>x.tag==='button'&&x.textContent==='清空').fire('click');
  assert.equal(search.value,'');
  assert.equal(find(dialog,x=>x.className==='sm-record-list is-timeline')?.children.length,2);
  view.refresh();
  search=find(dialog,x=>x.attrs['aria-label']==='搜索剧情时间线');
  assert.equal(search.value,'');
  // A completion event during the 150 ms debounce must not erase fresh typing.
  search.value='森林';search.fire('input');main.fire('input',{target:search});
  view.refresh();
  search=find(dialog,x=>x.attrs['aria-label']==='搜索剧情时间线');
  assert.equal(search.value,'森林');
  assert.equal(find(dialog,x=>x.className==='sm-record-list is-timeline')?.children.length,1);
}));

test('switching entity tabs retains unsaved corrections and saves through the real callback',()=>withUI(body=>{
  const chat=[{is_user:false,swipe_id:0,mes:'守门人守护城堡'}];
  let memory=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({
    summary:'守门人守护城堡',characters:[{op:'add',name:'守门人',status:'巡逻',presence:'present',
      knowledge:[{op:'add',fact:'城堡位置',stance:'knows',evidence:'守门人守护城堡'}]}]
  }));
  const ctx={chat,getCurrentChatId:()=> 'entity-tabs'};
  let saved=0;
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},
    correctEntity:(kind,id,values,locks)=>{memory=correctEntity(memory,chat,kind,id,values,locks);saved++;}
  });
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='角色')).fire('click');
  let card=find(dialog,x=>x.className==='sm-record');
  card.open=true;card.fire('toggle');
  const badge=find(card,x=>x.className?.includes('sm-meta-chip')&&x.textContent.includes('在场'));
  assert.ok(badge);
  assert.ok(find(card,x=>x.className==='sm-knowledge-badge'));
  const correctionTab=find(card,x=>x.tag==='button'&&String(x.textContent).startsWith('人工纠错'));
  const historyTab=find(card,x=>x.tag==='button'&&String(x.textContent).startsWith('变更记录'));
  correctionTab.fire('click');
  const input=find(card,x=>x.attrs['aria-label']==='守门人 · 状态');
  input.value='休息';find(dialog,x=>x.tag==='main').fire('input',{target:input});
  historyTab.fire('click');correctionTab.fire('click');
  assert.equal(input.value,'休息','tab change cannot discard an uncommitted draft');
  assert.equal(saved,0);
  find(card,x=>x.tag==='button'&&x.textContent==='保存纠错').fire('click');
  assert.equal(saved,1);
  assert.equal(deriveState(memory,chat).characters[0].status,'休息');
  card=find(dialog,x=>x.className==='sm-record');
  assert.equal(card.open,true);
  assert.ok(find(card,x=>x.tag==='button'&&String(x.textContent).startsWith('人工纠错')).className.includes('is-active'));
}));

test('source modal keyboard loop skips hidden load-more button and preview includes all actions',()=>withUI(body=>{
  const chat=[{is_user:false,swipe_id:0,mes:'原文甲'}];
  const memory=commitLeaf(freshMemory(),0,messageFingerprint(chat[0]),normalizeDelta({summary:'摘要甲'}));
  const ctx={chat,getCurrentChatId:()=> 'focus-cycle'};
  const view=mountUI({context:()=>ctx,memory:()=>memory,settings:defaultSettings,
    queue:{busy:false,enqueueMissing(){}},sourcePreview:()=>[{index:0,text:'原文甲'}],
    lastInjection:()=>({chatId:'focus-cycle',text:'上轮记忆'})});
  view.open();const dialog=body.children[0].shadow.children[1];
  find(dialog,x=>x.tag==='button'&&x.textContent==='查看原文').fire('click');
  let overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
  const close=find(overlay,x=>x.className==='sm-record-modal-close');
  const foot=find(overlay,x=>x.className==='sm-record-modal-footer');
  assert.equal(foot.children[0].hidden,true);
  let focusName='';
  for(const node of walk(overlay).filter(x=>x.tag==='button'||x.tag==='textarea'))node.focus=()=>{focusName=node.textContent||node.className;};
  let prevented=0;
  overlay.fire('keydown',{key:'Tab',target:close,shiftKey:true,preventDefault(){prevented++;}});
  assert.ok(focusName.includes('关闭'),'shift+tab from close wraps to visible footer Close');
  assert.equal(prevented,1);
  find(foot,x=>x.tag==='button'&&x.textContent==='关闭').fire('click');
  assert.equal(find(dialog,x=>x.className==='sm-record-modal-overlay'),undefined);
  find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
  find(dialog,x=>x.tag==='button'&&x.textContent==='预览发送内容').fire('click');
  overlay=find(dialog,x=>x.className==='sm-record-modal-overlay');
  assert.ok(find(overlay,x=>x.tag==='button'&&x.textContent==='查看上轮扩展发送'));
  assert.ok(find(overlay,x=>x.tag==='summary'&&x.textContent.includes('记忆组成')));
  const previewFoot=find(overlay,x=>x.className==='sm-record-modal-footer');
  const previewClose=find(overlay,x=>x.className==='sm-record-modal-close');
  focusName='';
  for(const node of walk(overlay).filter(x=>x.tag==='button'||x.tag==='textarea'||x.tag==='summary'))
    node.focus=()=>{focusName=node.textContent||node.className;};
  overlay.fire('keydown',{key:'Tab',target:previewClose,shiftKey:true,preventDefault(){prevented++;}});
  assert.equal(focusName,'关闭');
  find(previewFoot,x=>x.tag==='button'&&x.textContent==='查看上轮扩展发送').fire('click');
  assert.ok(find(previewFoot,x=>x.tag==='button'&&x.textContent==='返回模拟预览'));
}));
