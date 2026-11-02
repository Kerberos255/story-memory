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
  try{return fn(body,storage);}finally{globalThis.document=old.document;globalThis.localStorage=old.localStorage;}
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
