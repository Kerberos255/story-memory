import test from 'node:test';
import assert from 'node:assert/strict';
import {mountUI} from '../ui.js';
import {freshMemory,defaultSettings,commitLeaf,normalizeDelta,messageFingerprint,userFingerprint,editGeneratedLeaf,deleteGeneratedLeaf,editGeneratedChapter,deleteGeneratedChapter,mergeEntities,unmergeEntity,deriveState} from '../core.js';
import {readFileSync} from 'node:fs';

class FakeElement{
  constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.style={};this.dataset={};this.listeners={};this.open=false;this.value='';this.className='';this.textContent='';this.checked=false;this.scrollTop=0;}
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
  querySelectorAll(selector){return selector==='input'?walk(this).filter(x=>x.tag==='input'):[];}
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
  assert.equal(groups.length,6,'settings must have 6 collapsible groups');
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
 assert.equal(next.api.maxTokens,8192);
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
    assert.equal(saves,1);
    assert.equal(cfg.api.temperature,0);
    assert.equal(cfg.api.maxTokens,8192);
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
 const advanced=find(dialog,x=>x.className==='sm-summary-advanced');
 assert.ok(advanced);
 assert.equal(advanced.open,false,'advanced settings stay collapsed');
 find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
 assert.equal(saved.summary.leafBatchThreshold,10);
 assert.equal(saved.summary.resummaryThreshold,5);
 assert.equal(saved.summary.higherResummaryThreshold,2);
 assert.equal(saved.summary.leafKeepRecent,4);
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
 assert.ok(walk(card).some(x=>x.className==='sm-record-subtitle'&&x.textContent==='巷口'));
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
  const toggle=walk(dialog).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='自动查找历史'));
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

test('settings cards stay in one consistent workflow and rerank options reveal only when enabled',()=>withUI(body=>{
 const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};let saved;
 const view=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
   queue:{busy:false,enqueueMissing(){}},saveSettings:s=>{saved=s;}});
 view.open();const dialog=body.children[0].shadow.children[1];
 find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
 const groups=walk(dialog).filter(x=>x.className==='sm-accordion');
 assert.deepEqual(groups.map(g=>walk(g).find(x=>x.tag==='strong')?.textContent),[
   '摘要 API','摘要设置','历史检索','向量记忆','注入设置','自定义提示词'
 ]);
 const inject=groups[4],switches=walk(inject).filter(x=>x.className==='sm-switch-row');
 assert.equal(switches.length,6,'injection toggles form three balanced pairs');
 assert.ok(walk(inject).some(x=>x.textContent==='相关历史'));
 const rerank=walk(groups[3]).find(x=>x.className==='sm-vector-rerank');
 assert.ok(rerank,'reranking is visually separated from embeddings');
 const fields=walk(rerank).find(x=>x.className==='sm-fields-grid');
 assert.equal(fields.hidden,true,'default-off reranker does not clutter the form');
 const toggle=walk(rerank).find(x=>x.tag==='input'&&x.type==='checkbox');
 toggle.checked=true;toggle.fire('change');
 assert.equal(fields.hidden,false,'enabling reranking reveals its inputs');
 find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
 assert.equal(saved.vector.rerankEnabled,true);
 assert.equal(saved.injection.retrieval,true);
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/sm-vector-rerank\{border-top/);
 assert.match(css,/@media\(max-width:700px\)/);
 assert.match(css,/\.sm-fields-grid,\.sm-switch-grid\{grid-template-columns:1fr\}/);
}));
