import test from 'node:test';
import assert from 'node:assert/strict';
import {mountUI} from '../ui.js';
import {freshMemory,defaultSettings} from '../core.js';
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
  assert.equal(groups.length,5,'settings must have 5 collapsible groups');
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

test('summary settings expose delayed floor count and automatic hiding toggle',()=>withUI(body=>{
 const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>''};
 let saved;
 const view=mountUI({context:()=>ctx,memory:freshMemory,settings:defaultSettings,
   queue:{busy:false,enqueueMissing(){}},saveSettings:x=>{saved=x;}});
 view.open();const dialog=body.children[0].shadow.children[1];
 find(dialog,x=>x.className?.includes('sm-nav-item')&&walk(x).some(y=>y.textContent==='设置')).fire('click');
 const delay=walk(dialog).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='延迟自动摘要（AI 楼层）'));
 assert.ok(delay);
 const delayInput=walk(delay).find(x=>x.tag==='input');
 assert.equal(delayInput.value,'3');
 delayInput.value='4';
 const toggle=walk(dialog).find(x=>x.tag==='label'&&walk(x).some(y=>y.textContent==='摘要成功后自动隐藏楼层'));
 assert.ok(toggle);const checkbox=walk(toggle).find(x=>x.tag==='input');
 assert.equal(checkbox.checked,false);
 checkbox.checked=true;
 find(dialog,x=>x.tag==='button'&&x.textContent==='保存设置').fire('click');
 assert.equal(saved.summary.delayFloors,4);
 assert.equal(saved.summary.autoHide,true);
}));
