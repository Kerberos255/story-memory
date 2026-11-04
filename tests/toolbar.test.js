import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureStoryMemoryEntry} from '../toolbar.js';

class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.parentElement=null;this.id='';this.className='';this.handlers={};this.textContent='';this.title='';}
  get classList(){return {contains:name=>this.className.split(/\s+/).includes(name)};}
  append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
  prepend(node){node.remove();node.parentElement=this;this.children.unshift(node);}
  remove(){if(!this.parentElement)return;const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this),1);this.parentElement=null;}
  setAttribute(key,value){(this.attrs??={})[key]=value;}
  addEventListener(event,handler){(this.handlers[event]??=[]).push(handler);}
  fire(type,event={preventDefault(){}}){for(const handler of this.handlers[type]||[])handler(event);}
  querySelectorAll(selector){
    const result=[];
    const matches=node=>{
      if(selector==='[id="qr--bar"]')return node.id==='qr--bar';
      if(selector==='[id="story-memory-open"]')return node.id==='story-memory-open';
      if(selector==='.story-memory-made-bar')return node.classList.contains('story-memory-made-bar');
      if(selector.startsWith('#'))return node.id===selector.slice(1);
      if(selector.startsWith('.'))return node.classList.contains(selector.slice(1));
      throw Error('Unsupported test selector: '+selector);
    };
    const visit=node=>{for(const child of node.children){if(matches(child))result.push(child);visit(child);}};
    visit(this);return result;
  }
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
function makeDocument(){
  const head=new Element('head'),body=new Element('body'),form=new Element('form');
  form.id='send_form';body.append(form);
  return {head,body,form,createElement:tag=>new Element(tag),
    getElementById(id){return body.querySelector('#'+id)||head.querySelector('#'+id);}};
}
function addQR(form,doc){
  const bar=doc.createElement('div');bar.id='qr--bar';
  const holder=doc.createElement('div');holder.className='qr--buttons';
  bar.append(holder);form.prepend(bar);
  return {bar,holder};
}
test('without Quick Replies, creates exactly one independent entry and no fake qr--bar',()=>{
  const doc=makeDocument();let opened=0;
  const a=ensureStoryMemoryEntry(doc,()=>opened++);
  const b=ensureStoryMemoryEntry(doc,()=>opened++);
  assert.equal(a,b);
  assert.equal(doc.form.querySelectorAll('[id="story-memory-open"]').length,1);
  assert.equal(doc.form.querySelectorAll('[id="qr--bar"]').length,0);
  assert.equal(a.parentElement.id,'story-memory-entry-bar');
  assert.equal(doc.head.querySelectorAll('#story-memory-entry-style').length,1);
  a.fire('click');a.fire('keydown',{key:'Enter',preventDefault(){}});
  assert.equal(opened,2);
});
test('when Quick Replies already exists, shares the existing row without making a second bar',()=>{
  const doc=makeDocument(),{holder}=addQR(doc.form,doc);
  const entry=ensureStoryMemoryEntry(doc,()=>{});
  assert.equal(entry.parentElement,holder);
  assert.equal(doc.form.querySelector('#story-memory-entry-bar'),null);
  assert.equal(doc.form.querySelectorAll('[id="qr--bar"]').length,1);
});
test('when Quick Replies mounts late, moves existing entry instead of cloning it',()=>{
  const doc=makeDocument();let opened=0;
  const first=ensureStoryMemoryEntry(doc,()=>opened++);
  const {holder}=addQR(doc.form,doc);
  const second=ensureStoryMemoryEntry(doc,()=>opened++);
  assert.equal(first,second);
  assert.equal(second.parentElement,holder);
  assert.equal(doc.form.querySelector('#story-memory-entry-bar'),null);
  assert.equal(doc.form.querySelectorAll('[id="story-memory-open"]').length,1);
  second.fire('click');assert.equal(opened,1);
});
test('duplicate entry nodes are removed on reconciliation, while unrelated QR buttons survive',()=>{
  const doc=makeDocument(),{holder}=addQR(doc.form,doc);
  const first=ensureStoryMemoryEntry(doc,()=>{});
  const duplicate=doc.createElement('div');duplicate.id='story-memory-open';holder.append(duplicate);
  const other=doc.createElement('div');other.textContent='其他快捷回复';holder.append(other);
  ensureStoryMemoryEntry(doc,()=>{});
  assert.equal(doc.form.querySelectorAll('[id="story-memory-open"]').length,1);
  assert.equal(doc.form.querySelectorAll('.qr--buttons')[0].children.includes(other),true);
  assert.equal(first.parentElement,holder);
});
test('a legacy self-made QR bar is discarded without removing genuine Quick Replies',()=>{
  const doc=makeDocument();
  const legacy=doc.createElement('div');legacy.id='qr--bar';legacy.className='story-memory-made-bar';
  const oldHolder=doc.createElement('div');oldHolder.className='qr--buttons';
  const oldButton=doc.createElement('div');oldButton.id='story-memory-open';oldHolder.append(oldButton);
  legacy.append(oldHolder);doc.form.prepend(legacy);
  const {holder}=addQR(doc.form,doc);
  const button=ensureStoryMemoryEntry(doc,()=>{});
  assert.equal(button,oldButton);
  assert.equal(button.parentElement,holder);
  assert.equal(legacy.parentElement,null);
  assert.equal(doc.form.querySelectorAll('[id="story-memory-open"]').length,1);
});
test('after the host replaces its Quick Reply toolbar, entry is recreated once',()=>{
  const doc=makeDocument(),firstBar=addQR(doc.form,doc);
  const first=ensureStoryMemoryEntry(doc,()=>{});
  firstBar.bar.remove();
  const nextBar=addQR(doc.form,doc);
  const second=ensureStoryMemoryEntry(doc,()=>{});
  assert.notEqual(first,second);
  assert.equal(second.parentElement,nextBar.holder);
  assert.equal(doc.form.querySelectorAll('[id="story-memory-open"]').length,1);
});
