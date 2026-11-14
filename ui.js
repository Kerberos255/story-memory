import {defaultSettings,entityNameKey,formatStoryTime,leadingStoryTime,messageFingerprint,userFingerprint,deriveState,injectionText,injectionTextWithinBudget,validChapters} from './core.js';
import {createPendingPanel,pendingGroups} from './pending-ui.js';
import {characterCount,countTokens} from './text-stats.js';
import {DEFAULT_SUMMARY_PROMPT,DEFAULT_CHAPTER_PROMPT,DEFAULT_RESUMMARY2_PROMPT,DEFAULT_OVERVIEW_PROMPT,effectiveSummaryPrompt,composeL0Prompt,parseExtraBody,parseExcluded,parseHeaderLines} from './api.js';

const NAV=[['summaries','摘要','book'],['items','物品','package'],['scenes','场景','pin'],
  ['characters','角色','users'],['plans','计划','target'],['settings','设置','sliders']];
const ICONS={
  book:['M4 19.5A2.5 2.5 0 0 1 6.5 17H20','M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z','M8 7h8','M8 11h6'],
  package:['m12 3 9 5-9 5-9-5 9-5Z','M3 8v8l9 5 9-5V8','M12 13v8'],
  pin:['M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z','M12 10h.01'],
  users:['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2','M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z','M22 21v-2a4 4 0 0 0-3-3.87','M16 3.13a4 4 0 0 1 0 7.75'],
  sliders:['M4 7h16','M4 17h16','M9 4v6','M15 14v6'],
  target:['M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z','M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z','M12 10v4','M10 12h4'],
  moon:['M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z'],
  sun:['M12 2v2','M12 20v2','M4.93 4.93l1.42 1.42','m17.65 17.65 1.42 1.42','M2 12h2','M20 12h2','m6.35 17.65-1.42 1.42','m19.07 4.93-1.42 1.42','M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'],
  x:['M18 6 6 18','M6 6l12 12'],
  chevron:['m6 9 6 6 6-6'],
  plus:['M12 5v14','M5 12h14'],
  arrow:['M7 17 17 7','M8 7h9v9'],
  pencil:['M12 20h9','M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z'],
  trash:['M3 6h18','M8 6V4h8v2','M6 6l1 15h10l1-15','M10 10v7','M14 10v7'],
  check:['M20 6 9 17l-5-5']
};
const el=(tag,cls,text)=>{
  const result=document.createElement(tag);
  if(cls)result.className=cls;
  if(text!==undefined)result.textContent=String(text);
  return result;
};
const svg=(name)=>{
  const xmlns='http://www.w3.org/2000/svg',element=document.createElementNS(xmlns,'svg');
  element.setAttribute('viewBox','0 0 24 24');element.setAttribute('aria-hidden','true');
  element.setAttribute('fill','none');element.setAttribute('stroke','currentColor');
  element.setAttribute('stroke-width','1.75');element.setAttribute('stroke-linecap','round');
  element.setAttribute('stroke-linejoin','round');
  for(const d of ICONS[name]||[]){
    const p=document.createElementNS(xmlns,'path');p.setAttribute('d',d);element.append(p);
  }
  return element;
};
function button(label,onClick,cls='sm-btn'){
  const b=el('button',cls,label);b.type='button';b.addEventListener('click',onClick);return b;
}
function field(title,value,type='text',help=''){
  const wrap=el('label','sm-field'),caption=el('span','sm-field-label',title);
  const input=el('input','sm-input');input.type=type;input.value=String(value??'');
  if(type==='number')input.addEventListener('input',()=>input.setAttribute('aria-invalid','false'));
  wrap.append(caption,input);
  if(help)wrap.append(el('small','sm-help',help));
  return {wrapper:wrap,input};
}
function switchRow(title,checked,help=''){
  const label=el('label','sm-switch-row'),copy=el('span','sm-switch-copy');
  copy.append(el('strong','',title));
  if(help)copy.append(el('small','',help));
  const control=el('span','sm-switch'),input=el('input');
  input.type='checkbox';input.checked=Boolean(checked);
  control.append(input,el('span','sm-switch-track'));
  label.append(copy,control);return {wrapper:label,input};
}
function textArea(value='',rows=4,placeholder=''){
  const area=el('textarea','sm-textarea');area.value=value;area.rows=rows;area.placeholder=placeholder;return area;
}
function sectionTitle(title,description=''){
  const holder=el('div','sm-subheading');
  holder.append(el('h3','',title));
  if(description)holder.append(el('p','',description));return holder;
}

/** Two compact counters shared by prompt and injection previews. */
function textStats(){
  const wrap=el('div','sm-preview-stats'),token=el('strong','sm-preview-stat-value','计算中…');
  const chars=el('strong','sm-preview-stat-value','0');
  for(const [label,value] of [['Token（约）',token],['字符数',chars]]){
    const item=el('div','sm-preview-stat');
    item.append(el('span','sm-preview-stat-label',label),value);wrap.append(item);
  }
  return {wrap,token,chars};
}

// Numeric fields should enforce the same range in the UI and saved settings.
function settingNumber(input,label,min,max,{integer=true,optional=false}={}){
  const raw=String(input.value??'').trim(),value=Number(raw);
  if(optional&&raw===''){input.setAttribute('aria-invalid','false');return null;}
  if(raw===''||!Number.isFinite(value)||(integer&&!Number.isInteger(value))||value<min||value>max){
    input.setAttribute('aria-invalid','true');input.focus?.();
    throw Error(label+'须为 '+min+' 到 '+max+' 的'+(integer?'整数':'数字'));
  }
  input.setAttribute('aria-invalid','false');
  return value;
}

function settingsFormSnapshot(root){
  const entries=[];
  const visit=node=>{
    const tag=String(node?.tagName||node?.tag||'').toLowerCase();
    const aria=node?.getAttribute?.('aria-label')||node?.attrs?.['aria-label'];
    if(['input','textarea','select'].includes(tag)&&aria!=='选择摘要模型'){
      entries.push([tag,node.type==='checkbox'?'checked':String(node.type||''),
        node.type==='checkbox'?Boolean(node.checked):String(node.value??'')]);
    }
    for(const child of node?.children||[])visit(child);
  };
  visit(root);
  return JSON.stringify(entries);
}
export function mountUI(api){
  const host=el('div');host.id='story-memory-host';host.style.display='contents';document.body.append(host);
  const shadow=host.attachShadow({mode:'open'}),style=el('link');
  style.rel='stylesheet';style.href=new URL('./style.css',import.meta.url).href;shadow.append(style);
  const dialog=el('dialog','sm-dialog');dialog.setAttribute('aria-label','剧情记忆');shadow.append(dialog);
  const top=el('header','sm-topbar'),mark=el('div','sm-brand-mark','✦'),brand=el('div','sm-brand');
  brand.append(mark,el('span','sm-brand-name','剧情记忆'));
  const topActions=el('div','sm-top-actions');
  const themeButton=button('',()=>toggleTheme(),'sm-icon-button'),close=button('',()=>open(false),'sm-icon-button');
  themeButton.setAttribute('data-testid','theme-toggle');
  close.append(svg('x'));close.setAttribute('aria-label','关闭');close.title='关闭';
  topActions.append(themeButton,close);top.append(brand,topActions);
  const layout=el('div','sm-layout'),nav=el('nav','sm-nav'),body=el('main','sm-content');
  layout.append(nav,body);dialog.append(top,layout);
  let active=false,page='summaries',notice='',settingsOpen=new Set(),vectorStatusField=null;
  let dirtyEditor=false,settingsDraft=null,settingsReadDirty=()=>false;
  let timelineLimit=50,chapterLimit=40,timelineQuery='';
  const pendingView={expanded:'failed',all:false,limit:40};
  // Queue progress must not replace an in-progress form or destroy nested dialogs.
  body.addEventListener('input',e=>{
    const tag=String(e.target?.tagName||e.target?.tag||'').toLowerCase();
    if(['textarea','input','select'].includes(tag))dirtyEditor=true;
  });
  let saveToast=null,saveToastTimer=null;
  let theme='dark';
  try{theme=localStorage.getItem('story-memory-theme')==='light'?'light':'dark';}catch{}
  const updateTheme=()=>{
    dialog.dataset.theme=theme;
    themeButton.replaceChildren(svg(theme==='dark'?'sun':'moon'));
    const label=theme==='dark'?'切换到明亮主题':'切换到暗色主题';
    themeButton.setAttribute('aria-label',label);themeButton.title=label;
  };
  const toggleTheme=()=>{
    theme=theme==='dark'?'light':'dark';
    try{localStorage.setItem('story-memory-theme',theme);}catch{}
    updateTheme();
  };
  updateTheme();
  function clearSaveToast(){
    if(saveToastTimer!==null){clearTimeout(saveToastTimer);saveToastTimer=null;}
    saveToast?.remove();saveToast=null;
  }
  const showNotice=(message)=>{
    clearSaveToast();
    notice=String(message||'');
    if(!active)return;
    const old=body.querySelector('.sm-notice');if(old)old.remove();
    if(notice){const toast=el('div','sm-notice',notice);body.prepend(toast);}
  };
  function showSaveSuccess(message='设置已保存'){
    if(!active)return;
    clearSaveToast();notice='';
    body.querySelector('.sm-notice')?.remove();
    const toast=el('div','sm-save-toast');
    toast.setAttribute('role','status');toast.setAttribute('aria-live','polite');
    const mark=el('span','sm-save-toast-mark');mark.append(svg('check'));
    toast.append(mark,el('span','sm-save-toast-text',message));
    dialog.append(toast);saveToast=toast;
    saveToastTimer=setTimeout(()=>{if(saveToast===toast)clearSaveToast();},2000);
  }
  function confirmLeaveSettings(){
    if(page!=='settings'||!settingsReadDirty())return true;
    return typeof globalThis.window?.confirm==='function'&&
      globalThis.window.confirm('设置有尚未保存的修改，离开将丢弃这些修改。确定放弃吗？');
  }
  dialog.addEventListener('cancel',e=>{e.preventDefault();if(recordOverlay)closeRecordModal();else open(false);});
  dialog.addEventListener('click',e=>{
    if(e.target!==dialog)return;
    const rect=dialog.getBoundingClientRect();
    if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom){
      if(recordOverlay)closeRecordModal();else open(false);
    }
  });
  function open(value=true){
    if(value){
      active=true;if(!dialog.open)dialog.showModal();
      dirtyEditor=false;render();close.focus();
    }else{
      if(!confirmLeaveSettings())return;
      clearSaveToast();closeRecordModal(false);
      settingsDraft=null;settingsReadDirty=()=>false;
      active=false;dirtyEditor=false;if(dialog.open)dialog.close();
      body.replaceChildren();nav.replaceChildren();
      api.onClose?.();
    }
  }
  function title(text,subtitle='',action=null){
    const header=el('div','sm-page-heading'),caption=el('div','sm-page-title');
    caption.append(el('h2','',text));
    if(subtitle)caption.append(el('p','',subtitle));
    header.append(caption);
    if(action)header.append(action);
    body.append(header);
  }
  function emptyState(icon,titleText,description){
    const box=el('div','sm-empty');
    const mark=el('span','sm-empty-icon');mark.append(svg(icon));
    box.append(mark,el('strong','',titleText),el('p','',description));body.append(box);
  }
  // Keep generated summaries read-only in the timeline. Edit/delete are
  // separate dialogs layered over the existing SillyTavern extension dialog.
  let recordOverlay=null,recordReturnFocus=null;
  function closeRecordModal(refocus=true){
    if(!recordOverlay)return;
    recordOverlay.remove();recordOverlay=null;
    layout.inert=false;top.inert=false;
    const target=recordReturnFocus;recordReturnFocus=null;
    if(refocus)target?.focus?.();
  }
  function openRecordModal(entry,type,mode,trigger){
    closeRecordModal(false);
    recordReturnFocus=trigger||null;
    const isFloor=type==='floor',isDelete=mode==='delete';
    const overlay=el('div','sm-record-modal-overlay');
    recordOverlay=overlay;
    const panel=el('section','sm-record-modal');
    panel.setAttribute('role','dialog');
    panel.setAttribute('aria-modal','true');
    const modalTitle=el('h3','sm-record-modal-title',
      (isDelete?'删除':'编辑')+(isFloor?' #'+entry.sourceIndex+' 楼摘要':' '+(entry.level===1?'阶段总结':entry.level===2?'二次总结':'高层总结')));
    modalTitle.id='sm-record-modal-heading';
    panel.setAttribute('aria-labelledby',modalTitle.id);
    const head=el('div','sm-record-modal-head');
    const x=button('',()=>closeRecordModal(),'sm-record-modal-close');
    x.append(svg('x'));x.setAttribute('aria-label','关闭弹窗');
    head.append(modalTitle,x);
    const content=el('div','sm-record-modal-body');
    const footer=el('div','sm-record-modal-footer');
    const cancel=button('取消',()=>closeRecordModal(),'sm-btn');
    const action=isDelete?button('确认删除',()=>{
      try{
        if(isFloor)api.deleteLeaf(entry.sourceIndex);
        else api.deleteChapter(entry.id);
        closeRecordModal(false);render();showNotice('摘要已删除');
      }catch(e){error.textContent=e?.message||'删除失败';}
    },'sm-btn sm-record-modal-danger'):button('保存修改',()=>{
      if(!editor.value.trim()){error.textContent='摘要正文不能为空';editor.focus?.();return;}
      try{
        if(isFloor)api.editLeaf(entry.sourceIndex,{summary:editor.value,time:time.input.value,location:place.input.value});
        else api.editChapter(entry.id,editor.value);
        closeRecordModal(false);render();showNotice('修改已保存');
      }catch(e){error.textContent=e?.message||'保存失败';}
    },'sm-btn sm-btn-primary');
    const error=el('p','sm-record-modal-error');
    error.setAttribute('role','alert');
    let editor=null,time=null,place=null;
    if(isDelete){
      content.append(el('p','sm-record-modal-warning','确定删除这条摘要吗？'));
      content.append(el('p','sm-record-modal-explain',isFloor
        ?'将删除此楼层摘要及其提取的物品、场景、角色等状态变化，并使相关高层总结失效。'
        :'相关的更高层总结将失效，但楼层摘要和下层记录仍会保留。'));
      content.append(el('p','sm-record-modal-safe','原始聊天不会删除。'+(isFloor?'之后可手动重新摘要。':'')));
    }else{
      const summaryField=el('label','sm-field');
      summaryField.append(el('span','sm-field-label','剧情摘要'));
      editor=textArea(entry.summary,6,'输入整理后的剧情摘要…');
      editor.setAttribute('aria-label',isFloor?'编辑楼层摘要':'编辑分层总结');
      summaryField.append(editor);content.append(summaryField);
      if(isFloor){
        const fields=el('div','sm-grid sm-record-modal-fields');
        time=field('故事时间',formatStoryTime(entry.time||'')||leadingStoryTime(entry.summary),'text');
        place=field('地点',entry.location||'');
        fields.append(time.wrapper,place.wrapper);
        content.append(fields);
        content.append(el('p','sm-record-modal-help','修改摘要正文不会自动改写已提取的物品、场景、角色状态。'));
      }
    }
    content.append(error);
    footer.append(cancel,action);panel.append(head,content,footer);overlay.append(panel);dialog.append(overlay);
    layout.inert=true;top.inert=true;
    overlay.addEventListener('click',e=>{if(e.target===overlay)closeRecordModal();});
    overlay.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation?.();closeRecordModal();return;}
      if(e.key!=='Tab')return;
      const controls=[...panel.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled])')];
      if(!controls.length)return;
      const first=controls[0],last=controls[controls.length-1];
      if(e.shiftKey&&e.target===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&e.target===last){e.preventDefault();first.focus();}
    });
    (isDelete?cancel:editor)?.focus?.();
  }
  function openSourceModal(entry,type,trigger){
    closeRecordModal(false);
    recordReturnFocus=trigger||null;
    const overlay=el('div','sm-record-modal-overlay'),panel=el('section','sm-record-modal sm-source-modal');
    recordOverlay=overlay;
    panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
    const header=el('div','sm-record-modal-head');
    const title=el('h3','sm-record-modal-title','剧情原文');
    title.id='sm-story-source-heading';panel.setAttribute('aria-labelledby',title.id);
    const close=button('',()=>closeRecordModal(),'sm-record-modal-close');
    close.append(svg('x'));close.setAttribute('aria-label','关闭');header.append(title,close);
    const content=el('div','sm-record-modal-body');
    const key=type==='floor'?'floor:'+entry.sourceIndex:entry.id;
    let shown=0;
    const footer=el('div','sm-record-modal-footer');
    const more=button('加载更多',()=>appendSourcePage(),'sm-btn');
    function appendSourcePage(){
      const records=api.sourcePreview?.(api.context(),api.memory(),key,6,shown)||[];
      const page=records.slice(0,5);
      if(!shown&&!page.length)content.append(el('p','sm-help','没有找到可查看的原文。'));
      for(const item of page){
        const label=el('p','sm-field-label','#'+item.index);
        const text=textArea(item.text,8);text.readOnly=true;
        content.append(label,text);
      }
      shown+=page.length;
      more.hidden=records.length<=5;
    }
    footer.append(more,button('关闭',()=>closeRecordModal(),'sm-btn sm-btn-primary'));
    appendSourcePage();
    panel.append(header,content,footer);overlay.append(panel);dialog.append(overlay);
    layout.inert=true;top.inert=true;
    overlay.addEventListener('click',e=>{if(e.target===overlay)closeRecordModal();});
    overlay.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation?.();closeRecordModal();return;}
      if(e.key==='Tab'&&e.target===close&&e.shiftKey){e.preventDefault();footer.children[0].focus?.();}
      else if(e.key==='Tab'&&e.target===footer.children[0]&&!e.shiftKey){e.preventDefault();close.focus?.();}
    });
    close.focus?.();
  }
  function recordCards(heading,entries,extract,type=null,detailFactory=null){
    if(!entries.length)return;
    body.append(sectionTitle(heading));
    const list=el('div','sm-record-list');
    for(const entry of entries){
      const value=extract(entry),details=el('details','sm-record');
      const head=el('summary','sm-record-head');
      const headingCopy=el('span','sm-record-heading');
      headingCopy.append(el('span','sm-record-label',value.title));
      if(value.subtitle)headingCopy.append(el('small','sm-record-subtitle',value.subtitle));
      head.append(headingCopy);
      if(value.status){
        const done=/^(?:已完成|完成|已解决|已关闭|已取消|已放弃|done|completed|resolved|closed|cancelled)$/i.test(String(value.status).trim());
        head.append(el('span','sm-record-status'+(done?' is-complete':''),value.status));
      }
      head.append(svg('chevron'));
      details.append(head);
      if(value.description||!value.facts?.length)details.append(el('p','sm-record-text',value.description||'暂无详情'));
      if(value.facts?.length){
        const facts=el('div','sm-entity-facts');
        for(const [label,content] of value.facts){
          if(content===undefined||content===null||content==='')continue;
          const fact=el('span','sm-entity-fact');
          fact.append(el('span','sm-entity-fact-label',label+'：'),el('span','sm-entity-fact-value',content));
          facts.append(fact);
        }
        if(facts.children.length)details.append(facts);
      }
      if(value.meta)details.append(el('p','sm-record-state',value.meta));
      if(detailFactory){const extra=detailFactory(entry);if(extra)details.append(extra);}
      if(type){
        const actions=el('div','sm-record-actions');
        const edit=button('编辑',()=>openRecordModal(entry,type,'edit',edit),'sm-btn sm-record-edit-button');
        const remove=button('删除',()=>openRecordModal(entry,type,'delete',remove),'sm-btn sm-record-delete-button');
        edit.setAttribute('aria-label','编辑摘要');
        remove.setAttribute('aria-label','删除摘要');
        const source=button('查看原文',()=>openSourceModal(entry,type,source),'sm-btn');
        actions.append(source,edit,remove);details.append(actions);
      }
      list.append(details);
    }
    body.append(list);
  }
  function manualList(kind,entries){
    if(!entries?.length)return;
    body.append(sectionTitle('手动记录'));
    const list=el('div','sm-record-list');
    for(const entry of entries){
      const card=el('details','sm-record'),header=el('summary','sm-record-head');
      header.append(el('span','sm-record-label',entry.text.slice(0,84)),svg('chevron'));
      const editor=textArea(entry.text,4),actions=el('div','sm-row-actions');
      actions.append(button('删除',()=>{
        if(!window.confirm('确定删除这条记录？'))return;
        try{api.removeManual(kind,entry.id);showNotice('已删除');}catch(e){showNotice(e.message);}
      },'sm-btn sm-btn-danger'));
      actions.append(button('保存修改',()=>{
        try{api.editManual(kind,entry.id,editor.value);showNotice('修改已保存');}catch(e){showNotice(e.message);}
      },'sm-btn sm-btn-primary'));
      const inner=el('div','sm-record-edit');inner.append(editor,actions);
      card.append(header,inner);list.append(card);
    }
    body.append(list);
  }
  function manualInput(kind){
    const details=el('details','sm-manual'),head=el('summary','sm-manual-head');
    const left=el('span','sm-manual-title');left.append(svg('plus'),el('span','', '添加记忆'));
    head.append(left,svg('chevron'));details.append(head);
    const area=textArea('',4,'写下需要长期保留的信息…');
    const actionRow=el('div','sm-row-actions'),file=el('input','sm-file');
    file.type='file';file.accept='.txt,.md,text/plain,text/markdown';
    file.addEventListener('change',async()=>{
      const f=file.files?.[0];if(!f)return;
      if(f.size>12000){showNotice('单条记录不能超过 12 KB');return;}
      try{area.value=await f.text();}catch{showNotice('文件读取失败');}
    });
    actionRow.append(file,button('保存记录',()=>{
      try{api.addManual(kind,area.value);showNotice('已保存到当前聊天');}
      catch(e){showNotice(e.message);}
    },'sm-btn sm-btn-primary'));
    const content=el('div','sm-manual-content');content.append(area,actionRow);details.append(content);body.append(details);
  }
  function renderSummary(){
    const ctx=api.context(),mem=api.memory(),cfg=api.settings();
    const status=pendingGroups(mem,ctx?.chat||[],cfg);
    const action=button(api.queue.busy?'正在整理':'批量补摘',()=>api.queue.enqueueMissing(80),'sm-btn sm-btn-primary');
    action.disabled=Boolean(api.queue.busy);
    title('剧情摘要','时间线、章节与重要事件',action);
    const metrics=el('div','sm-metrics');
    for(const [count,label] of [[status.complete,'已摘要'],[status.groups.ready.length,'可自动整理'],[status.groups.delay.length,'延迟中'],[validChapters(mem,ctx?.chat||[]).length,'已压缩']]){
      const item=el('div','sm-metric');item.append(el('span','sm-metric-number',count),el('span','sm-metric-label',label));metrics.append(item);
    }
    body.append(metrics);
    if(mem.chapterError){
      const alert=el('div','sm-chapter-warning');
      alert.setAttribute('role','alert');
      const reason=el('p','sm-help','分层压缩暂停：'+String(mem.chapterError.message||'请检查摘要模型')+
        '。已有摘要仍然保留。');
      const retry=button('重试分层压缩',async()=>{
        retry.disabled=true;retry.textContent='正在重试…';
        try{
          const ok=await api.queue.retryChapters();
          render();showNotice(ok?'分层压缩已重新检查':'分层压缩仍未完成，请查看错误原因');
        }catch(e){retry.disabled=false;retry.textContent='重试分层压缩';showNotice(e.message||'重试失败');}
      },'sm-btn sm-btn-sm');
      retry.disabled=Boolean(api.queue.busy);
      alert.append(reason,retry);body.append(alert);
    }
    const hidden=(ctx?.chat||[]).filter(msg=>msg?.is_system&&msg.extra?.story_memory_hidden).length;
    if(hidden&&!cfg.summary?.autoHide){
      const bar=el('div','sm-hidden-restore');
      const explanation=el('p','sm-help','有 '+hidden+' 条原文曾被自动隐藏。恢复只改变聊天中的隐藏标记，不删除摘要。');
      const restore=button('恢复已隐藏正文',async()=>{
        if(!window.confirm('确定恢复 '+hidden+' 条已隐藏的原文吗？\\n\\n原文将重新参与酒馆上下文计算，长篇聊天可能增加 Token 占用。'))return;
        restore.disabled=true;restore.textContent='正在恢复…';
        try{
          const count=await api.queue.restoreAllHidden();
          render();showNotice('已恢复 '+count+' 条原文；摘要和实体记忆仍保留');
        }catch(e){restore.disabled=false;restore.textContent='恢复已隐藏正文';showNotice(e.message||'恢复失败');}
      },'sm-btn sm-btn-sm');
      bar.append(explanation,restore);body.append(bar);
    }
    body.append(createPendingPanel({
      memory:mem,chat:ctx?.chat||[],config:cfg,queue:api.queue,state:pendingView,
      summary:status,rerender:render,notice:showNotice
    }));
    const valid=validChapters(mem,ctx?.chat||[]);
    recordCards('分层剧情回顾',valid.slice(-chapterLimit).reverse(),c=>({title:'L'+c.level+' · '+(c.level===1?'阶段总结':c.level===2?'二次总结':'高层总结'),subtitle:c.children.length+' 段剧情',description:c.summary}),'chapter');
    if(valid.length>chapterLimit)body.append(button('加载更早的分层总结',()=>{
      chapterLimit+=40;render();
    },'sm-btn sm-btn-text'));
    const state=deriveState(mem,ctx?.chat||[]);
    const queryRow=el('div','sm-timeline-search');
    const query=el('input','sm-input');query.type='search';query.placeholder='搜索楼层、故事时间、地点或剧情';
    query.value=timelineQuery;query.setAttribute('aria-label','搜索剧情时间线');
    const applyQuery=()=>{timelineQuery=query.value.trim();timelineLimit=50;render();};
    query.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();applyQuery();}});
    queryRow.append(query,button('搜索',applyQuery,'sm-btn'));
    body.append(queryRow);
    const term=timelineQuery.toLocaleLowerCase();
    const filtered=term?state.timeline.filter(e=>
      ['#'+e.sourceIndex,e.summary,e.time,e.location].some(x=>String(x||'').toLocaleLowerCase().includes(term))
    ):state.timeline;
    recordCards('剧情时间线',filtered.slice(-timelineLimit).reverse(),e=>({
      title:'#'+e.sourceIndex,
      subtitle:[
        ['时间',formatStoryTime(e.time)||leadingStoryTime(e.summary)],
        ['地点',e.location]
      ].filter(([,value])=>Boolean(value)).map(([label,value])=>label+'：'+value).join('  ·  '),
      description:e.summary,
      meta:'本楼层更新：物品 '+(e.delta?.items?.length||0)+' · 场景 '+(e.delta?.scenes?.length||0)+
        ' · 角色 '+(e.delta?.characters?.length||0)+' · 计划 '+(e.delta?.plans?.length||0)
    }),'floor');
    if(filtered.length>timelineLimit)body.append(button('加载更早的楼层摘要',()=>{
      timelineLimit+=50;render();
    },'sm-btn sm-btn-text'));
    if(term&&!filtered.length)body.append(el('p','sm-help','未找到匹配的剧情摘要。'));
    const skipped=Object.keys(mem.skippedFloors||{}).map(Number).filter(i=>
      mem.skippedFloors[i]?.fingerprint===messageFingerprint(ctx?.chat?.[i])&&
      mem.skippedFloors[i]?.userFingerprint===userFingerprint(ctx.chat,i)).sort((a,b)=>a-b);
    if(skipped.length){
      const panel=el('div','sm-pending-box'),heading=el('div','sm-pending-heading');
      heading.append(el('strong','','已删除／跳过的摘要'),el('span','sm-pending-count',skipped.length+' 楼'));
      const row=el('div','sm-pills');
      for(const i of skipped)row.append(button('#'+i+' · 重新摘要',()=>{
        try{api.resumeLeaf(i);api.queue.enqueue([i]);showNotice('已重新加入摘要队列');}
        catch(e){showNotice(e.message||'恢复失败');}
      },'sm-pill'));
      panel.append(heading,row);body.append(panel);
    }
    manualList('summaries',mem.manual.summaries);
    if(!state.timeline.length&&!mem.manual.summaries.length)emptyState('book','还没有剧情摘要','可以先添加记忆，或配置副 API 后整理楼层。');
    manualInput('summaries');
  }
  function entityMergeControl(kind,entry,entries,aliases){
    if(entries.length<2&&!aliases.length)return null;
    const panel=el('details','sm-entity-history sm-entity-merge');
    const heading=aliases.length?'合并称呼 · 已合并 '+aliases.length+' 个':'合并称呼';
    panel.append(el('summary','sm-entity-history-heading',heading));
    const inside=el('div','sm-entity-merge-content');
    if(entries.length>1){
      inside.append(el('p','sm-entity-hint','确认两条记录属于同一实体后再合并；不会修改原始摘要。'));
      const controls=el('div','sm-entity-controls');
      const picker=el('select','sm-input sm-select');
      picker.setAttribute('aria-label','合并到哪条记录');
      const blank=el('option','','选择同一实体…');blank.value='';picker.append(blank);
      for(const other of entries){
        if(other.entity_id===entry.entity_id)continue;
        const option=el('option','',other.name);option.value=other.entity_id;picker.append(option);
      }
      const merge=button('合并到所选记录',()=>{
        if(!picker.value)return showNotice('请先选择目标记录');
        const target=entries.find(x=>x.entity_id===picker.value);
        if(!target)return showNotice('目标实体已变化，请重新打开页面');
        if(!window.confirm('确定将「'+entry.name+'」识别为「'+target.name+'」的同一实体吗？\n合并仅影响当前聊天的记忆呈现，不会删除原始摘要，可撤销。'))return;
        try{api.mergeEntity(kind,entry.entity_id,target.entity_id);showNotice('已合并同一实体');}
        catch(e){showNotice(e?.message||'合并失败');}
      },'sm-btn');
      controls.append(picker,merge);inside.append(controls);
    }
    if(aliases.length){
      const aliasBox=el('div','sm-entity-aliases');
      aliasBox.append(el('small','sm-help','已合并别名'));
      for(const rule of aliases){
        const row=el('div','sm-entity-alias');
        row.append(el('span','',rule.name));
        row.append(button('撤销合并',()=>{
          try{api.unmergeAlias(kind,rule.name);showNotice('已撤销合并');}
          catch(e){showNotice(e?.message||'撤销失败');}
        },'sm-btn'));
        aliasBox.append(row);
      }
      inside.append(aliasBox);
    }
    panel.append(inside);
    return panel;
  }
  function entityHistoryDetails(entry){
    const history=entry.history||[];
    if(!history.length)return el('span');
    const wrap=el('details','sm-entity-history');
    wrap.append(el('summary','sm-entity-history-heading','变更记录 · '+history.length+' 条'));
    const list=el('div','sm-entity-history-list');
    for(const event of history.slice(-12).reverse()){
      const row=el('div','sm-entity-history-row');
      const operation=event.op==='add'?'登记':event.op==='remove'?'移除':'更新';
      row.append(el('strong','', '#'+event.floor+' · '+operation+
        (event.fields?.length?' · '+event.fields.join('、'):'')));
      if(event.evidence)row.append(el('small','', '原文依据：'+event.evidence));
      else if(event.op!=='remove')row.append(el('small','','无可核对引文 · 建议人工确认'));
      list.append(row);
    }
    wrap.append(list);
    const versions=Object.entries(entry.fieldVersions||{});
    if(versions.length){
      const window=el('div','sm-entity-version-list');
      for(const [field,items] of versions){
        const last=items.at(-1);if(!last)continue;
        window.append(el('small','',field+'：#'+last.validFromFloor+' → '+
          (last.validToFloor===null?'当前':'#'+last.validToFloor)+
          (last.evidenceStatus==='verified'?' · 有原文依据':' · 待核对')));
      }
      wrap.append(window);
    }
    return wrap;
  }
  function entityCorrection(kind,entry){
    const fields={items:['name','description','location','owner','status','quantity'],
      scenes:['name','description','location','status'],
      characters:['name','description','location','status','relationship','presence'],
      plans:['name','description','location','status','time']}[kind]||[];
    const labels={name:'名称',description:'说明',location:'位置',owner:'归属',status:'状态',
      quantity:'数量',relationship:'关系',presence:'在场状态',time:'故事时间'};
    const panel=el('details','sm-entity-history sm-entity-correction');
    panel.append(el('summary','sm-entity-history-heading',
      entry.lockedFields?.length?'人工纠错 · 已锁定 '+entry.lockedFields.length+' 项':
      entry.correctionStale?'人工纠错 · 部分待核对':entry.manualCorrection?'人工纠错 · 已生效':'人工纠错'));
    const content=el('div','sm-entity-correction-content');
    content.append(el('p','sm-help','未锁定的纠错在新证据出现时自动更新；锁定的字段保留人工确认值，解除锁定后可恢复最新提取结果。'));
    if(entry.lockConflicts?.length){
      const names=entry.lockConflicts.map(x=>(labels[x.field]||x.field)+'（#'+x.floor+'）').join('、');
      content.append(el('p','sm-help sm-lock-conflict','新剧情与锁定字段不一致：'+names+'。请核对后决定保留锁定值，或解除锁定使用最新提取结果。'));
    }
    const grid=el('div','sm-entity-correction-fields'),inputs={},locks={};
    for(const fieldName of fields){
      const row=el('div','sm-field sm-correction-field'),heading=el('div','sm-correction-field-heading');
      heading.append(el('span','sm-field-label',labels[fieldName]));
      const lockLabel=el('label','sm-lock-field');
      const lock=el('input','sm-lock-checkbox');lock.type='checkbox';
      lock.checked=Boolean(entry.lockedFields?.includes(fieldName));
      lock.setAttribute('aria-label',entry.name+' · 锁定'+labels[fieldName]);
      lockLabel.append(lock,el('span','','锁定'));
      locks[fieldName]=lock;heading.append(lockLabel);row.append(heading);
      let input;
      if(fieldName==='presence'){
        input=el('select','sm-input sm-select');
        for(const [value,label] of [['unknown','未确认'],['present','在场'],['absent','不在场']]){
          const option=el('option','',label);option.value=value;input.append(option);
        }
        input.value=entry[fieldName]||'unknown';
      }else{
        input=el('input','sm-input');input.type=fieldName==='quantity'?'number':'text';
        input.value=String(entry[fieldName]??'');
        if(fieldName==='quantity')input.min='0';
      }
      input.setAttribute('aria-label',entry.name+' · '+labels[fieldName]);
      inputs[fieldName]=input;row.append(input);grid.append(row);
    }
    const actions=el('div','sm-row-actions');
    actions.append(button('保存纠错',()=>{
      try{api.correctEntity(kind,entry.entity_id,
        Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value])),
        Object.fromEntries(Object.entries(locks).map(([k,v])=>[k,v.checked])));
        showNotice('已更新当前状态');}
      catch(e){showNotice(e.message||'保存失败');}
    },'sm-btn sm-btn-primary'));
    if(entry.manualCorrection||entry.correctionStale)actions.append(button('恢复提取值',()=>{
      try{api.clearEntityCorrection(kind,entry.entity_id);showNotice('已恢复提取值');}
      catch(e){showNotice(e.message||'恢复失败');}
    },'sm-btn'));
    content.append(grid,actions);panel.append(content);
    return panel;
  }
  function renderCollection(kind,heading,caption){
    const ctx=api.context(),mem=api.memory(),state=deriveState(mem,ctx?.chat||[]);
    title(heading,caption);
    const entries=(state[kind]||[]).filter(x=>!x.manual);
    const rules=Object.entries(mem.entityAliases?.[kind]||{});
    recordCards(kind==='plans'?'计划记录':'当前'+heading,entries,x=>({
      title:x.name,
      subtitle:x.lockConflicts?.length?'锁定字段与新剧情有冲突':x.lockedFields?.length?'已锁定 '+x.lockedFields.length+' 个字段':
        x.correctionStale?'新剧情已更新部分人工纠错':x.manualCorrection?'当前状态 · 人工确认':'',
      description:x.description||'',
      status:x.status||'',
      facts:[
        ['位置',x.location],['归属',x.owner],['关系',x.relationship],
        ['数量',Number.isFinite(x.quantity)?String(x.quantity):''],
        ['时间',x.time],
        ['在场',kind==='characters'&&x.presence==='present'?'当前在场':
          kind==='characters'&&x.presence==='absent'?'当前不在场':''],
        ['知情',kind==='characters'&&x.knowledge?.length?x.knowledge.map(k=>
          ({knows:'知道',suspects:'怀疑',believes:'误信',hides:'隐瞒'}[k.stance]||k.stance)+
          '「'+k.fact+'」'+(k.provenance==='secondhand'?'（转述）':'')).join('；'):'']
      ].filter(([,value])=>value!==undefined&&value!==null&&value!=='')
    }),null,x=>{
      const wrap=el('div','sm-entity-details');
      if(x.history?.length)wrap.append(entityHistoryDetails(x));
      wrap.append(entityCorrection(kind,x));
      const merge=entityMergeControl(kind,x,entries,
        rules.filter(([,rule])=>entityNameKey(rule.to)===entityNameKey(x.name))
          .map(([,rule])=>rule));
      if(merge)wrap.append(merge);
      return wrap;
    });
    const warnings=state.ambiguities?.[kind]||[];
    if(warnings.length){
      const notice=el('details','sm-entity-history sm-entity-ambiguity');
      notice.append(el('summary','sm-entity-history-heading','待核对的同名身份 · '+warnings.length+' 条'));
      for(const issue of warnings.slice(-15))notice.append(el('p','sm-help',
        '#'+issue.sourceIndex+' · '+issue.name+'：'+issue.reason));
      body.append(notice);
    }
    const archived=(state.archived?.[kind]||[]).slice(-30).reverse();
    recordCards('已归档'+heading,archived,x=>({title:x.name,
      subtitle:'归档于 #'+x.retiredAtFloor,
      description:x.description||'这条状态已被后续剧情移除；完整来源仍保存在楼层摘要中。'
    }),null,entityHistoryDetails);

    const aliases=Object.values(mem.entityAliases?.[kind]||{});
    if(entries.length>=2||aliases.length){
      const panel=el('details','sm-manual sm-entity-merge-panel');
      const heading=el('summary','sm-manual-head');
      const label=el('span','sm-manual-title');
      label.append(el('span','','合并同一实体的不同称呼'));
      heading.append(label,svg('chevron'));
      const inside=el('div','sm-manual-content');
      inside.append(el('p','sm-help','确认是同一对象后再合并，之后可以撤销。'));
      if(entries.length>=2){
        const pair=el('div','sm-fields-grid');
        function entityPicker(titleText){
          const field=el('label','sm-field');
          field.append(el('span','sm-field-label',titleText));
          const picker=el('select','sm-input sm-select');
          const empty=el('option','','请选择…');empty.value='';picker.append(empty);
          for(const row of entries){
            const choice=el('option','',row.name);choice.value=row.entity_id;picker.append(choice);
          }
          field.append(picker);return {field,picker};
        }
        const from=entityPicker('重复名称'),to=entityPicker('保留的名称');
        from.picker.setAttribute('aria-label','待合并的实体');
        to.picker.setAttribute('aria-label','合并到实体');
        pair.append(from.field,to.field);inside.append(pair);
        inside.append(button('确认合并',()=>{
          if(!from.picker.value||!to.picker.value||from.picker.value===to.picker.value){
            showNotice('请选择两个不同的记录');return;
          }
          const source=entries.find(x=>x.entity_id===from.picker.value);
          const target=entries.find(x=>x.entity_id===to.picker.value);
          if(!source||!target)return;
          if(!window.confirm('确认「'+source.name+'」与「'+target.name+'」指同一实体？合并后以「'+target.name+'」显示，可随时撤销。'))return;
          try{api.mergeEntity(kind,source.entity_id,target.entity_id);showNotice('已合并重复记录');}
          catch(e){showNotice(e.message||'合并失败');}
        },'sm-btn sm-btn-primary sm-entity-merge-confirm'));
      }
      if(aliases.length){
        const ruleList=el('div','sm-entity-alias-list');
        for(const rule of aliases){
          const line=el('div','sm-entity-alias-row');
          line.append(el('span','',rule.name+' → '+rule.to));
          line.append(button('撤销合并',()=>{
            try{api.unmergeAlias(kind,rule.name);showNotice('已撤销合并');}
            catch(e){showNotice(e.message||'撤销失败');}
          },'sm-btn'));
          ruleList.append(line);
        }
        inside.append(ruleList);
      }
      panel.append(heading,inside);body.append(panel);
    }
    const manual=mem.manual?.[kind]||[];
    manualList(kind,manual);
    if(!entries.length&&!manual.length)emptyState(kind==='plans'?'target':'package',
      '暂无'+heading+'记录','从剧情提取后会显示在这里，也可以手动添加。');
    manualInput(kind);
  }
  function accordion(id,label,description,children){
    const details=el('details','sm-accordion');
    details.open=settingsOpen.has(id);
    const summary=el('summary','sm-accordion-head'),copy=el('span','sm-accordion-copy');
    copy.append(el('strong','',label));
    if(description)copy.append(el('small','',description));
    summary.append(copy,svg('chevron'));
    const content=el('div','sm-accordion-body');content.append(...children);
    details.append(summary,content);
    details.addEventListener('toggle',()=>{if(details.open)settingsOpen.add(id);else settingsOpen.delete(id);});
    return details;
  }
  function grid(...elements){const row=el('div','sm-fields-grid');row.append(...elements);return row;}
  function updateVectorStatus(){
    if(!vectorStatusField)return;
    const info=api.vectorStatus?.();
    if(!info){vectorStatusField.textContent='索引状态：未连接';return;}
    if(!info.enabled)vectorStatusField.textContent='索引状态：语义检索未启用';
    else if(info.error)vectorStatusField.textContent='索引失败：'+String(info.error).slice(0,120)+'；可点击更新索引重试';
    else if(info.busy)vectorStatusField.textContent='索引状态：后台更新中…';
    else if(info.pending)vectorStatusField.textContent='索引状态：等待后台更新';
    else vectorStatusField.textContent='索引状态：已完成本轮同步'+(info.lastCount?' · 最近更新 '+info.lastCount+' 条':'');
  }
  function renderSettings(){
    const cfg=settingsDraft||api.settings();
    title('设置','管理摘要渠道、记忆整理和召回方式');
    const box=el('section','sm-settings'),main=el('div','sm-setting-global');
    const enabled=switchRow('启用剧情记忆',cfg.enabled,'控制剧情整理、记忆检索和发送');
    main.append(enabled.wrapper);box.append(main);

    const modeWrap=el('label','sm-field'),modeLabel=el('span','sm-field-label','摘要使用的 API');
    const mode=el('select','sm-input sm-select');
    for(const [value,caption] of [['main','跟随主 API'],['custom','独立副 API']]){
      const option=el('option','',caption);option.value=value;mode.append(option);
    }
    mode.value=cfg.api.mode==='custom'?'custom':'main';
    modeWrap.append(modeLabel,mode);
    const modeTip=el('p','sm-help','使用酒馆当前连接、模型及思考设置生成摘要。');
    const apiUrl=field('API 地址',cfg.api.url,'url');
    const apiKey=field('API 密钥',cfg.api.key||'','password');
    apiKey.input.autocomplete='new-password';
    const modelWrap=el('div','sm-field'),modelLabel=el('span','sm-field-label','模型');
    const modelLine=el('div','sm-model-line'),modelInput=el('input','sm-input');
    modelInput.type='text';modelInput.value=cfg.api.model||'';modelInput.placeholder='填写模型 ID 或刷新获取';
    const modelPicker=el('select','sm-input sm-select');
    modelPicker.hidden=true;modelPicker.setAttribute('aria-label','选择摘要模型');
    const refreshModels=button('↻',async()=>{
      refreshModels.disabled=true;refreshModels.title='正在获取模型列表';
      try{
        const found=await api.fetchSummaryModels({
          url:apiUrl.input.value,key:apiKey.input.value,
          headers:parseHeaderLines(headers.value)
        });
        if(!found.length){showNotice('模型列表为空，可手动填写模型 ID');return;}
        modelPicker.replaceChildren();
        const placeholder=el('option','', '选择模型…');placeholder.value='';modelPicker.append(placeholder);
        for(const id of found){const option=el('option','',id);option.value=id;modelPicker.append(option);}
        const manual=el('option','','手动输入模型 ID');manual.value='__manual__';modelPicker.append(manual);
        modelPicker.value=found.includes(modelInput.value)?modelInput.value:'';
        modelPicker.hidden=false;modelInput.hidden=true;
        showNotice('已获取 '+found.length+' 个模型，请选择');
      }catch(e){showNotice(e.message||'获取模型列表失败');}
      finally{refreshModels.disabled=false;refreshModels.title='刷新模型列表';}
    },'sm-btn sm-refresh-models');
    refreshModels.title='刷新模型列表';refreshModels.setAttribute('aria-label','刷新模型列表');
    modelPicker.addEventListener('change',()=>{
      if(modelPicker.value&&modelPicker.value!=='__manual__')modelInput.value=modelPicker.value;
      modelPicker.hidden=true;modelInput.hidden=false;
    });
    modelLine.append(modelInput,modelPicker,refreshModels);modelWrap.append(modelLabel,modelLine);
    const temp=field('温度',cfg.api.temperature,'number');
    temp.input.min='0';temp.input.max='2';temp.input.step='any';
    const thinkingWrap=el('label','sm-field');
    thinkingWrap.append(el('span','sm-field-label','Think 等级'));
    const thinking=el('select','sm-input sm-select');
    for(const [value,label] of [['auto','Auto'],['low','Low'],['medium','Medium'],['high','High'],['max','Max']]){
      const option=el('option','',label);option.value=value;thinking.append(option);
    }
    thinking.value=['auto','low','medium','high','max'].includes(cfg.api.thinkLevel)?cfg.api.thinkLevel:'auto';
    thinkingWrap.append(thinking,el('small','sm-help','Auto 使用默认等级；手动选择须模型支持。'));
    const max=field('输出上限（可选）',cfg.api.maxTokens??'','number',
      '留空沿用模型默认长度；输出不完整时再填写。');
    max.input.placeholder='自动';max.input.max='65536';max.input.min='256';
    const tuning=grid(temp.wrapper,thinkingWrap,max.wrapper);
    tuning.className+=' sm-api-tuning-grid';
    const customFields=el('div','sm-form-stack');
    customFields.append(apiUrl.wrapper,apiKey.wrapper,modelWrap,tuning);
    const updateMode=()=>{const custom=mode.value==='custom';customFields.hidden=!custom;modeTip.hidden=custom;};
    mode.addEventListener('change',updateMode);updateMode();

    const extra=el('details','sm-advanced sm-extra');
    const extraHead=el('summary','sm-advanced-title'),extraLabel=el('span','','附加参数');
    extraHead.append(extraLabel,svg('chevron'));
    const extraContent=el('div','sm-advanced-content');
    const included=textArea(Object.keys(cfg.api.include||{}).length?JSON.stringify(cfg.api.include,null,2):'',4,'prefix: true');
    const excluded=textArea((cfg.api.exclude||[]).join('\n'),3,'frequency_penalty\npresence_penalty');
    const headerLines=Object.entries(cfg.api.headers||{}).map(([k,v])=>k+': '+v).join('\n');
    const headers=textArea(headerLines,3,'x-example-session: demo');
    const extras=[
      ['包含主体参数','每行一个 名称: 值，也支持 JSON 对象',included],
      ['排除主体参数','每行填写一个参数名',excluded],
      ['包含请求标头','每行填写 名称: 内容，由你自行配置',headers]
    ];
    for(const [heading,description,area] of extras){
      const section=el('div','sm-extra-section');section.append(sectionTitle(heading,description),area);
      extraContent.append(section);
    }
    extra.append(extraHead,extraContent);

    customFields.append(extra);
    box.append(accordion('api','摘要 API','选择跟随主 API，或配置独立摘要模型',[
      modeWrap,modeTip,customFields
    ]));

    const auto=switchRow('自动摘要',cfg.autoSummary,'按延迟楼层自动整理剧情');
    const hide=switchRow('摘要完成后自动隐藏',cfg.summary.autoHide??true,
      '仅隐藏确认已摘要的旧楼层，原文仍可恢复');
    const recent=field('保留正文',cfg.summary.keepRecent,'number');
    const delay=field('延迟摘要',cfg.summary.delayFloors??3,'number');
    recent.input.min='0';recent.input.max='50';delay.input.min='0';delay.input.max='50';
    recent.input.setAttribute('aria-label','保留正文（AI 楼层）');
    delay.input.setAttribute('aria-label','延迟摘要（AI 楼层）');
    const autoPanel=el('section','sm-summary-panel');
    const autoGrid=el('div','sm-summary-control-grid');
    for(const [entry,description] of [
      [delay,'最近 AI 楼层暂不摘要'],[recent,'自动隐藏时保留最近 N 楼原文']
    ]){
      const card=el('div','sm-summary-number-card');
      const label=el('div','sm-summary-number-copy');
      label.append(el('strong','',entry===delay?'延迟摘要':'保留正文'),el('small','',description));
      const inputWrap=el('div','sm-summary-input'),unit=el('span','sm-summary-unit','楼');
      inputWrap.append(entry.input,unit);card.append(label,inputWrap);
      autoGrid.append(card);
    }
    const updateAuto=()=>{
      delay.input.disabled=!auto.input.checked;
      autoGrid.children[0]?.classList?.toggle('is-disabled',!auto.input.checked);
    };
    auto.input.addEventListener('change',updateAuto);
    updateAuto();
    const hideNote=el('p','sm-summary-note','仅隐藏已摘要且离开保留窗口的旧楼层。');
    autoPanel.append(auto.wrapper,autoGrid,hide.wrapper,hideNote);

    function levelSetting(level,name,description,value){
      const panel=el('div','sm-level-cell');
      const heading=el('div','sm-level-heading');
      heading.append(el('span','sm-level-badge',level),el('strong','',name));
      const lower=el('div','sm-level-bottom');
      lower.append(el('small','',description));
      const control=el('label','sm-level-input');
      control.setAttribute('aria-label',name+'触发阈值');
      const input=el('input');input.type='number';input.min='0';input.max='100';
      input.value=String(value);input.setAttribute('aria-label',name+'触发阈值');
      input.addEventListener('input',()=>input.setAttribute('aria-invalid','false'));
      control.append(input,el('span','','条'));
      lower.append(control);
      panel.append(heading,lower);
      return {panel,input};
    }
    const leafBatch=levelSetting('L1','阶段总结','合并楼层摘要',cfg.summary.leafBatchThreshold??cfg.summary.chapterEvery??12);
    const second=levelSetting('L2','二次总结','融合多个阶段',cfg.summary.resummaryThreshold??6);
    const higher=levelSetting('L3+','高层总结','浓缩长期主线',cfg.summary.higherResummaryThreshold??3);
    const leafKeep=field('保留最近 L0 摘要',cfg.summary.leafKeepRecent??3,'number');
    leafKeep.input.min='0';leafKeep.input.max='50';
    const compression=el('section','sm-summary-panel');
    const compHead=el('div','sm-summary-head');
    compHead.append(el('strong','','分层压缩'));
    const pipeline=el('div','sm-level-path');
    for(const token of ['L0 楼层摘要','→','L1 阶段总结','→','L2 二次总结','→','L3+ 长期记忆']){
      pipeline.append(el('span',token==='→'?'sm-level-arrow':'',token));
    }
    const levelStrip=el('div','sm-level-strip');
    levelStrip.append(leafBatch.panel,second.panel,higher.panel);
    const keepRow=el('div','sm-level-keep');
    const keepLabel=el('div','sm-level-keep-copy');
    keepLabel.append(el('strong','','保留最近 L0 摘要'),
      el('small','','已生成的最新 L0 摘要暂不合并到 L1；与延迟生成 L0 无关。'));
    keepRow.append(keepLabel);
    const keepControl=el('label','sm-level-input');
    keepControl.setAttribute('aria-label','保留最近 L0 摘要');
    keepControl.append(leafKeep.input,el('span','','条'));
    keepRow.append(keepControl);
    compression.append(compHead,pipeline,levelStrip,keepRow);

    const retries=field('网络失败重试次数',cfg.summary.retry,'number');
    retries.input.min='0';retries.input.max='2';retries.input.step='1';
    const retryRow=el('div','sm-summary-retry'),retryCopy=el('div','sm-summary-retry-copy');
    retryCopy.append(el('strong','','网络失败重试次数'),
      el('small','','单次任务额外重试 0–2 次；临时故障还有有限自动恢复。'));
    const retryControl=el('label','sm-level-input');
    retryControl.setAttribute('aria-label','网络失败重试次数');
    retryControl.append(retries.input,el('span','','次'));
    retryRow.append(retryCopy,retryControl);
    box.append(accordion('summary','摘要设置','自动摘要、楼层隐藏与分层压缩',[
      autoPanel,compression,retryRow
    ]));

    const flags=[['inventory','物品状态'],['scenes','场景地点'],
      ['characters','人物档案'],['plans','计划与伏笔']]
      .map(([key,label])=>[key,switchRow(label,cfg.injection[key]??(key==='plans'))]);
    const flagGroup=el('div','sm-switch-grid');
    flagGroup.append(...flags.map(([,x])=>x.wrapper));
    const budget=field('记忆长度上限（约 Tokens）',cfg.injection.budget,'number',
      '默认 16,000；只限制每轮注入的剧情记忆，不包含聊天、预设和世界书。小上下文模型建议适当调低。');
    budget.input.min='400';budget.input.max='18000';budget.input.step='1';
    const previewButton=button('预览发送内容',()=>{
      let budgetValue;
      try{budgetValue=settingNumber(budget.input,'记忆长度上限',400,18000);}
      catch(e){showNotice(e.message);return;}
      const previewCfg=structuredClone(cfg);
      for(const [key,value] of flags)previewCfg.injection[key]=value.input.checked;
      previewCfg.injection.budget=budgetValue;
      previewCfg.retrieval={...previewCfg.retrieval,enabled:retrievalEnabled.input.checked,
        maxHits:Math.max(1,Math.min(10,Number(recallCount.input.value)||5)),
        maxSources:Math.max(0,Math.min(5,Number(sourceCount.input.value)||0))};
      openInjectionPreview(previewButton,previewCfg);
    },'sm-btn');
    const injectionPanel=accordion('inject','记忆发送','选择发送给主模型的实体记忆',[
      flagGroup,budget.wrapper,previewButton
    ]);

    const retrievalEnabled=switchRow('启用历史检索',cfg.retrieval?.enabled!==false);
    const recallCount=field('最多参考记忆',cfg.retrieval?.maxHits??5,'number');
    recallCount.input.min='1';recallCount.input.max='10';
    const sourceCount=field('最多补充原文',cfg.retrieval?.maxSources??3,'number');
    sourceCount.input.min='0';sourceCount.input.max='5';
    const historyCountFields=grid(recallCount.wrapper,sourceCount.wrapper);
    const updateHistoryFields=()=>{
      const disabled=!retrievalEnabled.input.checked;
      historyCountFields.className='sm-fields-grid'+(disabled?' is-disabled':'');
      recallCount.input.disabled=disabled;
      sourceCount.input.disabled=disabled;
    };
    retrievalEnabled.input.addEventListener('change',updateHistoryFields);
    updateHistoryFields();
    const vector=switchRow('启用语义检索',cfg.vector.enabled);
    const vectorUrl=field('Embedding API 地址',cfg.vector.url||'https://api.siliconflow.cn/v1','url');
    const vectorKey=field('Embedding API 密钥',cfg.vector.key||'','password');
    vectorKey.input.autocomplete='new-password';
    const vectorModel=field('Embedding 模型',cfg.vector.model);
    const topK=field('召回数量 Top-K',cfg.vector.topK,'number');
    const threshold=field('相似度阈值',cfg.vector.threshold,'number');
    threshold.input.min='0';threshold.input.max='1';threshold.input.step='any';
    const rerank=switchRow('启用重排（Rerank）',cfg.vector.rerankEnabled??false,
      '先通过向量筛选候选，再用专用重排模型排序；失败自动回退向量结果');
    const rerankModel=field('重排模型',cfg.vector.rerankModel||'BAAI/bge-reranker-v2-m3');
    const rerankCount=field('重排候选数',cfg.vector.rerankCandidates??15,'number');
    rerankCount.input.min='2';rerankCount.input.max='30';
    const vectorHelp=el('p','sm-help','向量和重排共用 API 地址与密钥。开启语义检索后，摘要、实体和章节将后台分批增量索引；旧聊天首次建立索引可能需要一段时间，不会阻塞正文。下方按钮可立即补齐当前聊天索引。');
    const vectorStatus=el('p','sm-help sm-vector-index-status');
    vectorStatus.setAttribute('role','status');
    vectorStatusField=vectorStatus;updateVectorStatus();
    const vectorActions=el('div','sm-row-actions');
    vectorActions.append(button('更新当前聊天索引',async()=>{
      showNotice('正在更新向量索引…');
      try{const count=await api.indexNow();showNotice('已更新 '+count+' 条记忆');}
      catch(e){showNotice(e?.message||'索引失败，请检查 API 与跨域设置');}
    },'sm-btn'));
    const rerankFields=grid(rerankModel.wrapper,rerankCount.wrapper);
    rerankFields.hidden=!rerank.input.checked;
    rerank.input.addEventListener('change',()=>{rerankFields.hidden=!rerank.input.checked;});
    const rerankSection=el('div','sm-vector-rerank');
    rerankSection.append(rerank.wrapper,rerankFields);
    const historySection=el('section','sm-memory-search-section');
    const historyHeading=el('div','sm-memory-search-heading');
    historyHeading.append(el('strong','','历史检索'),
      el('small','','开启后检索并发送相关历史给主模型，无需额外 API。'));
    historySection.append(historyHeading,retrievalEnabled.wrapper,
      historyCountFields);

    const semanticSection=el('section','sm-memory-search-section');
    const semanticHeading=el('div','sm-memory-search-heading');
    semanticHeading.append(el('strong','','语义检索'),
      el('small','','开启后用向量模型召回并发送相关记忆给主模型。'));
    semanticSection.append(semanticHeading,vector.wrapper);

    const vectorConfig=el('details','sm-memory-vector-config');
    const vectorConfigHead=el('summary','sm-memory-vector-config-head');
    const vectorConfigCopy=el('span','sm-memory-vector-config-copy');
    vectorConfigCopy.append(el('strong','','向量模型配置'),
      el('small','','Embedding API、模型与重排参数'));
    vectorConfigHead.append(vectorConfigCopy,svg('chevron'));
    const vectorConfigBody=el('div','sm-memory-vector-config-body');
    vectorConfigBody.append(vectorUrl.wrapper,vectorKey.wrapper,vectorModel.wrapper,
      grid(topK.wrapper,threshold.wrapper),rerankSection,vectorHelp,vectorStatus,vectorActions);
    vectorConfig.append(vectorConfigHead,vectorConfigBody);
    semanticSection.append(vectorConfig);

    box.append(accordion('retrieval','记忆检索','找回与当前剧情相关的旧信息',[
      historySection,semanticSection
    ]));
    box.append(injectionPanel);

    const extractionSwitches=[['items','提取物品'],['scenes','提取场景'],
      ['characters','提取人物'],['plans','提取计划']]
      .map(([key,label])=>[key,switchRow(label,cfg.extraction?.[key]!==false)]);
    const extractionPanel=el('section','sm-extraction-panel');
    const extractionHeading=el('div','sm-memory-search-heading');
    extractionHeading.append(el('strong','','实体提取'),
      el('small','','控制 L0 是否新增和更新独立档案；旧记录保留，与「记忆发送」独立。'));
    const extractionGrid=el('div','sm-switch-grid sm-extraction-grid');
    extractionGrid.append(...extractionSwitches.map(([,row])=>row.wrapper));
    extractionPanel.append(extractionHeading,extractionGrid);

    const promptConfigs=[
      {key:'summaryFull',name:'楼层摘要与状态提取',desc:'整理本轮剧情，按上方开关提取实体档案',def:DEFAULT_SUMMARY_PROMPT,initial:effectiveSummaryPrompt(cfg)},
      {key:'chapter',name:'首次总结（L1）',desc:'将楼层摘要整理为章节',def:DEFAULT_CHAPTER_PROMPT,initial:cfg.prompts.chapter||DEFAULT_CHAPTER_PROMPT},
      {key:'resummary2',name:'二次总结（L2）',desc:'进一步融合多条首次总结',def:DEFAULT_RESUMMARY2_PROMPT,initial:cfg.prompts.resummary2||DEFAULT_RESUMMARY2_PROMPT},
      {key:'overview',name:'高层总结（L3+）',desc:'持续压缩旧剧情，保留长期主线',def:DEFAULT_OVERVIEW_PROMPT,initial:cfg.prompts.overview||DEFAULT_OVERVIEW_PROMPT}
    ];
    const promptEditors=new Map(),promptSections=[extractionPanel];
    for(const spec of promptConfigs){
      const group=el('details','sm-prompt-group'),head=el('summary','sm-prompt-head');
      const label=el('span','sm-prompt-title');
      label.append(el('strong','',spec.name),el('small','',spec.desc));
      head.append(label,svg('chevron'));
      const promptArea=textArea(spec.initial,11);
      promptArea.classList?.add('sm-prompt-textarea');
      const toolbar=el('div','sm-prompt-toolbar');
      toolbar.append(el('small','sm-help','编辑后点击页面底部「保存设置」生效'));
      const promptActions=el('div','sm-prompt-actions');
      promptActions.append(button('恢复默认',()=>{promptArea.value=spec.def;},'sm-btn'));
      if(spec.key==='summaryFull'){
        const preview=button('预览最终提示词',()=>{
          const draft=structuredClone(cfg);
          draft.prompts.summaryFull=promptArea.value.trim();
          draft.extraction={...draft.extraction};
          for(const [key,row] of extractionSwitches)draft.extraction[key]=row.input.checked;
          openL0PromptPreview(preview,composeL0Prompt(draft));
        },'sm-btn');
        promptActions.append(preview);
      }
      toolbar.append(promptActions);
      const content=el('div','sm-prompt-content');content.append(promptArea,toolbar);
      group.append(head,content);promptSections.push(group);
      promptEditors.set(spec.key,promptArea);
    }
    box.append(accordion('prompts','提示配置','自定义楼层摘要与分层总结提示词',promptSections));

    let draftNote=null;
    const saveBar=el('div','sm-settings-save'),save=button('保存设置',()=>{
      try{
        const next=structuredClone(cfg);
        next.enabled=enabled.input.checked;next.autoSummary=auto.input.checked;
        next.api.mode=mode.value==='main'?'main':'custom';
        next.api.url=apiUrl.input.value.trim();next.api.key=apiKey.input.value.trim();
        next.api.model=modelInput.value.trim();
        const tempChanged=String(temp.input.value).trim()!==String(cfg.api.temperature);
        next.api.temperature=next.api.mode==='custom'||tempChanged
          ?settingNumber(temp.input,'温度',0,2,{integer:false}):cfg.api.temperature;
        next.api.thinkLevel=thinking.value;
        const savedOutput=cfg.api.maxTokens==null?'':String(cfg.api.maxTokens);
        next.api.maxTokens=next.api.mode==='custom'||String(max.input.value).trim()!==savedOutput
          ?settingNumber(max.input,'输出上限',256,65536,{optional:true}):cfg.api.maxTokens;
        next.api.include=parseExtraBody(included.value);
        next.api.exclude=parseExcluded(excluded.value);
        next.api.headers=parseHeaderLines(headers.value);
        next.summary.keepRecent=settingNumber(recent.input,'保留正文',0,50);
        next.summary.delayFloors=settingNumber(delay.input,'延迟摘要',0,50);
        next.summary.autoHide=hide.input.checked;
        next.summary.leafBatchThreshold=settingNumber(leafBatch.input,'L1 压缩阈值',0,100);
        next.summary.leafKeepRecent=settingNumber(leafKeep.input,'保留最近 L0 摘要',0,50);
        next.summary.resummaryThreshold=settingNumber(second.input,'L2 压缩阈值',0,100);
        next.summary.higherResummaryThreshold=settingNumber(higher.input,'L3+ 压缩阈值',0,100);
        delete next.summary.chapterEvery;
        delete next.summary.maxInputChars;
        next.summary.retry=settingNumber(retries.input,'网络失败重试次数',0,2);
        next.extraction={...next.extraction};
        for(const [key,row] of extractionSwitches)next.extraction[key]=row.input.checked;
        next.injection.budget=settingNumber(budget.input,'记忆长度上限',400,18000);
        for(const [key,value] of flags)next.injection[key]=value.input.checked;
        delete next.injection.summary;
        delete next.injection.retrieval;
        delete next.injection.vector;
        next.retrieval={enabled:retrievalEnabled.input.checked,
          maxHits:retrievalEnabled.input.checked||String(recallCount.input.value)!==String(cfg.retrieval.maxHits)
            ?settingNumber(recallCount.input,'最多参考记忆',1,10):cfg.retrieval.maxHits,
          maxSources:retrievalEnabled.input.checked||String(sourceCount.input.value)!==String(cfg.retrieval.maxSources)
            ?settingNumber(sourceCount.input,'最多补充原文',0,5):cfg.retrieval.maxSources};
        next.vector.enabled=vector.input.checked;
        next.vector.url=vectorUrl.input.value.trim();
        next.vector.key=vectorKey.input.value.trim();
        next.vector.model=vectorModel.input.value.trim();
        next.vector.topK=settingNumber(topK.input,'召回数量 Top-K',1,10);
        next.vector.threshold=settingNumber(threshold.input,'相似度阈值',0,1,{integer:false});
        next.vector.rerankEnabled=rerank.input.checked;
        next.vector.rerankModel=rerankModel.input.value.trim()||'BAAI/bge-reranker-v2-m3';
        next.vector.rerankCandidates=settingNumber(rerankCount.input,'重排候选数',2,30);
        next.prompts.summaryFull=promptEditors.get('summaryFull').value.trim();
        next.prompts.summary='';
        next.prompts.chapter=promptEditors.get('chapter').value.trim();
        next.prompts.resummary2=promptEditors.get('resummary2').value.trim();
        next.prompts.overview=promptEditors.get('overview').value.trim();
        // Unmodified defaults stay empty in settings, so later default improvements apply.
        for(const [key,defaultText] of [['summaryFull',DEFAULT_SUMMARY_PROMPT],['chapter',DEFAULT_CHAPTER_PROMPT],
          ['resummary2',DEFAULT_RESUMMARY2_PROMPT],['overview',DEFAULT_OVERVIEW_PROMPT]]){
          if(next.prompts[key]===defaultText)next.prompts[key]='';
        }
        delete next.api.secretId;delete next.vector.source;
        api.saveSettings(next);
        settingsDraft=null;settingsBaseline=settingsFormSnapshot(box);dirtyEditor=false;
        draftNote?.remove();draftNote=null;
        showSaveSuccess();
      }catch(e){showNotice('保存失败：'+e.message);}
    },'sm-btn sm-btn-primary');
    const reset=button('恢复默认',()=>{
      const ask=window.confirm(
        '要将设置恢复为默认草稿吗？\n\n点击「保存设置」后才会生效；API 连接信息与已保存的剧情记忆不会删除。'
      );
      if(!ask)return;
      try{
        const defaults=defaultSettings();
        defaults.api={
          ...defaults.api,
          mode:cfg.api.mode||defaults.api.mode,
          url:cfg.api.url||'',key:cfg.api.key||'',model:cfg.api.model||'',
          headers:structuredClone(cfg.api.headers||{}),
          exclude:[...(cfg.api.exclude||[])],
          include:structuredClone(cfg.api.include||{})
        };
        defaults.vector={
          ...defaults.vector,
          url:cfg.vector.url||defaults.vector.url,
          key:cfg.vector.key||'',
          model:defaults.vector.model
        };
        settingsDraft=defaults;
        render();
      }catch(e){showNotice('恢复失败：'+e.message);}
    },'sm-btn');
    reset.setAttribute('data-testid','reset-settings');
    if(settingsDraft){draftNote=el('p','sm-settings-draft-note','已填入默认设置，点击「保存设置」后才会生效。');box.append(draftNote);}
    saveBar.append(reset,save);box.append(saveBar);body.append(box);
    let settingsBaseline=settingsFormSnapshot(box);
    settingsReadDirty=()=>Boolean(settingsDraft)||settingsFormSnapshot(box)!==settingsBaseline;
  }
  function openL0PromptPreview(trigger,prompt){
    clearSaveToast();closeRecordModal(false);
    recordReturnFocus=trigger||null;
    const overlay=el('div','sm-record-modal-overlay'),panel=el('section','sm-record-modal sm-preview-modal');
    recordOverlay=overlay;
    panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
    const heading=el('h3','sm-record-modal-title','最终提示词预览');
    heading.id='sm-l0-preview-heading';panel.setAttribute('aria-labelledby',heading.id);
    const header=el('div','sm-record-modal-head');
    const close=button('',()=>closeRecordModal(),'sm-record-modal-close');
    close.append(svg('x'));close.setAttribute('aria-label','关闭弹窗');
    header.append(heading,close);
    const content=el('div','sm-record-modal-body');
    const stats=textStats();stats.chars.textContent=characterCount(prompt).toLocaleString();
    content.append(el('p','sm-help','仅预览 L0 摘要 API 的系统提示词，不发送请求；按当前草稿开关生成，包含固定输出协议。Token 按酒馆当前主模型分词器统计，独立摘要 API 可能不同。'),stats.wrap);
    void countTokens(api.context(),prompt).then(result=>{
      if(recordOverlay===overlay)stats.token.textContent=result.tokens.toLocaleString()+(result.estimated?'（回退估算）':'');
    });
    const area=textArea(prompt,18);area.readOnly=true;area.setAttribute('aria-label','最终 L0 提示词');
    content.append(area);
    const footer=el('div','sm-record-modal-footer');
    const done=button('关闭',()=>closeRecordModal(),'sm-btn sm-btn-primary');
    footer.append(done);panel.append(header,content,footer);overlay.append(panel);dialog.append(overlay);
    layout.inert=true;top.inert=true;
    overlay.addEventListener('click',e=>{if(e.target===overlay)closeRecordModal();});
    overlay.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation?.();closeRecordModal();return;}
      if(e.key!=='Tab')return;
      if(e.shiftKey&&e.target===close){e.preventDefault();done.focus();}
      else if(!e.shiftKey&&e.target===done){e.preventDefault();close.focus();}
    });
    close.focus?.();
  }
  function openInjectionPreview(trigger,previewSettings=null){
    clearSaveToast();closeRecordModal(false);
    recordReturnFocus=trigger||null;
    const ctx=api.context(),memory=api.memory(),cfg=previewSettings||api.settings();
    const recalled=cfg.retrieval?.enabled!==false?api.previewHistory?.(ctx,memory,cfg)||[]:[];
    const usage={};
    const result=injectionText(memory,ctx?.chat||[],cfg,[],recalled,usage);
    const snapshot=api.lastInjection?.();
    const hasSnapshot=Boolean(snapshot?.chatId&&snapshot.chatId===ctx?.getCurrentChatId?.());
    const overlay=el('div','sm-record-modal-overlay');
    const panel=el('section','sm-record-modal sm-preview-modal');
    recordOverlay=overlay;
    panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
    const heading=el('h3','sm-record-modal-title','发送预览');
    heading.id='sm-injection-preview-heading';
    panel.setAttribute('aria-labelledby',heading.id);
    const header=el('div','sm-record-modal-head');
    const close=button('',()=>closeRecordModal(),'sm-record-modal-close');
    close.append(svg('x'));close.setAttribute('aria-label','关闭弹窗');
    header.append(heading,close);
    const content=el('div','sm-record-modal-body');
    const explanation=el('p','sm-help','当前草稿模拟使用本地历史检索，不发送向量请求。Token 按酒馆当前分词器统计；跳过统计只涵盖参与本轮筛选的候选记忆，不包含已关闭类别或来源数量上限之外的记录。');
    const stats=textStats();
    const textarea=textArea(result||'当前没有需要发送的记忆。',15);
    textarea.readOnly=true;textarea.setAttribute('aria-label','发送预览内容');
    let showSnapshot=false,simulated=result,previewEpoch=0,previewReady=false;
    const budgetLabel=el('p','sm-preview-counter','记忆用量 · 统计中…');
    const skippedLabel=el('p','sm-preview-skipped','跳过记录 · 统计中…');
    const update=()=>{
      const epoch=++previewEpoch;
      const value=String(showSnapshot?(snapshot?.text||''):simulated||'');
      textarea.value=value||'当前没有需要发送的记忆。';
      stats.chars.textContent=characterCount(value).toLocaleString();
      stats.token.textContent='计算中…';
      budgetLabel.textContent=(showSnapshot?'上轮生成时提交':'当前草稿模拟')+' · Token 统计中…';
      breakdown.hidden=showSnapshot;
      skippedLabel.hidden=showSnapshot;
      if(!showSnapshot){
        if(previewReady){
          stats.token.textContent=usage.usedTokens.toLocaleString()+(usage.tokenEstimated?'（回退估算）':'');
          budgetLabel.textContent='当前草稿模拟 · '+(usage.tokenEstimated?'约 ':'')+
            usage.usedTokens.toLocaleString()+' / '+usage.budgetTokens.toLocaleString()+' Tokens'+
            (usage.tokenAdjusted?' · 已按 Token 上限重新筛选':'');
        }
        return;
      }
      void countTokens(ctx,value).then(measured=>{
        if(recordOverlay!==overlay||epoch!==previewEpoch)return;
        stats.token.textContent=measured.tokens.toLocaleString()+(measured.estimated?'（回退估算）':'');
        budgetLabel.textContent=(showSnapshot?'上轮生成时提交':'当前草稿模拟')+
          ' · 约 '+measured.tokens.toLocaleString()+' / '+usage.budgetTokens.toLocaleString()+' Tokens';
      });
    };
    content.append(explanation,stats.wrap,budgetLabel,skippedLabel);
    const breakdown=el('details','sm-injection-breakdown');
    const breakdownTitle=el('summary','sm-entity-history-heading','记忆组成 · 统计中…');
    breakdown.append(breakdownTitle);
    const breakdownList=el('div','sm-injection-breakdown-list');
    const refreshBreakdown=()=>{
      breakdownList.replaceChildren();
      const sections=usage.sections||[];
      let selected=0,skippedBudget=0,skippedDuplicate=0,skippedEmpty=0;
      for(const section of sections){
        selected+=section.selected;
        skippedBudget+=section.skippedBudget||0;
        skippedDuplicate+=section.skippedDuplicate||0;
        skippedEmpty+=section.skippedEmpty||0;
        const row=el('div','sm-injection-breakdown-row');
        const details=[
          section.selected+' 条已选',
          section.chars.toLocaleString()+' 字符',
          ...(section.skippedBudget?['容量不足 '+section.skippedBudget+' 条']:[]),
          ...(section.skippedDuplicate?['重复 '+section.skippedDuplicate+' 条']:[]),
          ...(section.skippedEmpty?['空记录 '+section.skippedEmpty+' 条']:[])
        ];
        row.append(el('span','',section.title.replace(/[【】]/g,'')),
          el('span','',details.join(' · ')));
        breakdownList.append(row);
      }
      const skipped=skippedBudget+skippedDuplicate+skippedEmpty;
      skippedLabel.textContent=usage.tokenLimitFailed
        ?'本次记忆未发送：反复校验后仍无法满足 Token 限制。'
        :'本轮候选 '+(selected+skipped)+' 条 · 已选 '+selected+' 条 · 跳过 '+skipped+
          ' 条（容量不足 '+skippedBudget+'、重复 '+skippedDuplicate+'、空记录 '+skippedEmpty+'）';
      breakdownTitle.textContent='按类别查看选中与跳过 · '+sections.length+' 类';
    };
    breakdown.append(breakdownList);
    content.append(breakdown,textarea);
    update();
    const footer=el('div','sm-record-modal-footer');
    if(hasSnapshot){
      const toggle=button('查看上轮扩展发送',()=>{
        showSnapshot=!showSnapshot;
        toggle.textContent=showSnapshot?'返回模拟预览':'查看上轮扩展发送';
        update();
      },'sm-btn');
      footer.append(toggle);
    }
    const done=button('关闭',()=>closeRecordModal(),'sm-btn sm-btn-primary');
    footer.append(done);
    panel.append(header,content,footer);overlay.append(panel);dialog.append(overlay);
    layout.inert=true;top.inert=true;
    overlay.addEventListener('click',e=>{if(e.target===overlay)closeRecordModal();});
    overlay.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation?.();closeRecordModal();return;}
      if(e.key!=='Tab')return;
      const focusables=[close,textarea,done],first=focusables[0],last=focusables[focusables.length-1];
      if(e.shiftKey&&e.target===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&e.target===last){e.preventDefault();first.focus();}
    });
    void injectionTextWithinBudget(memory,ctx?.chat||[],cfg,[],recalled,
      value=>countTokens(ctx,value),usage).then(value=>{
      if(recordOverlay!==overlay||typeof document==='undefined')return;
      simulated=value;previewReady=true;refreshBreakdown();update();
    }).catch(()=>{
      if(recordOverlay!==overlay||typeof document==='undefined')return;
      previewReady=false;
      stats.token.textContent='统计失败';
      budgetLabel.textContent='当前分词器统计失败；未能确认实际发送 Token。';
      skippedLabel.textContent='本轮预算筛选未能完成，请检查酒馆分词器。';
    });
    close.focus?.();
  }
  function render(){
    if(!active)return;
    vectorStatusField=null;
    clearSaveToast();closeRecordModal(false);
    body.replaceChildren();nav.replaceChildren();dirtyEditor=false;
    for(const [name,label,icon] of NAV){
      const item=button('',()=>{
        if(page===name||!confirmLeaveSettings())return;
        settingsDraft=null;settingsReadDirty=()=>false;
        page=name;notice='';render();body.scrollTop=0;
      },'sm-nav-item'+(page===name?' is-current':''));
      item.append(svg(icon),el('span','',label));item.setAttribute('aria-current',page===name?'page':'false');nav.append(item);
    }
    if(page==='summaries')renderSummary();
    else if(page==='items')renderCollection('items','物品','重要物件和持有状态');
    else if(page==='scenes')renderCollection('scenes','场景','地点与环境记录');
    else if(page==='characters')renderCollection('characters','角色','人物档案及关系变化');
    else if(page==='plans')renderCollection('plans','计划','未完成任务、约定与剧情伏笔');
    else if(page==='settings')renderSettings();
    if(notice)showNotice(notice);
  }
  return {open,updateVectorStatus,showFailures(){
    page='summaries';pendingView.expanded='failed';pendingView.all=false;open(true);
  },resetChatView(){
    timelineLimit=50;chapterLimit=40;timelineQuery='';dirtyEditor=false;
    pendingView.expanded='failed';pendingView.all=false;pendingView.limit=40;
  },refresh(force=false){
    // Preserve drafts and editing dialogs during async queue updates.
    if(active&&page!=='settings'&&(force||(!recordOverlay&&!dirtyEditor)))render();
  },report:showNotice};
}
