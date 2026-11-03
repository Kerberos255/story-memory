import {defaultSettings,entityNameKey,formatStoryTime,messageFingerprint,userFingerprint,pendingFloors,automaticFloorIndices,deriveState,injectionText,validChapters} from './core.js';
import {DEFAULT_SUMMARY_PROMPT,DEFAULT_CHAPTER_PROMPT,DEFAULT_RESUMMARY2_PROMPT,DEFAULT_OVERVIEW_PROMPT,effectiveSummaryPrompt,parseExtraBody,parseExcluded,parseHeaderLines} from './api.js';

const NAV=[['summaries','摘要','book'],['items','物品','package'],['scenes','场景','pin'],['characters','角色','users'],['settings','设置','sliders']];
const ICONS={
  book:['M4 19.5A2.5 2.5 0 0 1 6.5 17H20','M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z','M8 7h8','M8 11h6'],
  package:['m12 3 9 5-9 5-9-5 9-5Z','M3 8v8l9 5 9-5V8','M12 13v8'],
  pin:['M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z','M12 10h.01'],
  users:['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2','M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z','M22 21v-2a4 4 0 0 0-3-3.87','M16 3.13a4 4 0 0 1 0 7.75'],
  sliders:['M4 7h16','M4 17h16','M9 4v6','M15 14v6'],
  moon:['M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z'],
  sun:['M12 2v2','M12 20v2','M4.93 4.93l1.42 1.42','m17.65 17.65 1.42 1.42','M2 12h2','M20 12h2','m6.35 17.65-1.42 1.42','m19.07 4.93-1.42 1.42','M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'],
  x:['M18 6 6 18','M6 6l12 12'],
  chevron:['m6 9 6 6 6-6'],
  plus:['M12 5v14','M5 12h14'],
  arrow:['M7 17 17 7','M8 7h9v9']
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
  let active=false,page='summaries',notice='',settingsOpen=new Set();
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
  const showNotice=(message)=>{
    notice=String(message||'');
    if(!active)return;
    const old=body.querySelector('.sm-notice');if(old)old.remove();
    if(notice){const toast=el('div','sm-notice',notice);body.prepend(toast);}
  };
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
      render();close.focus();
    }else{
      closeRecordModal(false);
      active=false;if(dialog.open)dialog.close();
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
        time=field('故事时间',formatStoryTime(entry.time||''),'text');
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
      head.append(headingCopy,svg('chevron'));
      details.append(head,el('p','sm-record-text',value.description||'暂无详情'));
      if(detailFactory)details.append(detailFactory(entry));
      if(type){
        const actions=el('div','sm-record-actions');
        const edit=button('编辑',()=>openRecordModal(entry,type,'edit',edit),'sm-btn sm-record-edit-button');
        const remove=button('删除',()=>openRecordModal(entry,type,'delete',remove),'sm-btn sm-record-delete-button');
        edit.setAttribute('aria-label','编辑摘要');
        remove.setAttribute('aria-label','删除摘要');
        actions.append(edit,remove);details.append(actions);
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
    const ctx=api.context(),mem=api.memory(),pending=pendingFloors(mem,ctx?.chat||[]);
    const cfg=api.settings(),ready=automaticFloorIndices(mem,ctx?.chat||[],cfg.summary?.delayFloors??3);
    const deferred=new Set(pending.filter(index=>!ready.includes(index)));
    const action=button(api.queue.busy?'正在整理':'批量补摘',()=>api.queue.enqueueMissing(80),'sm-btn sm-btn-primary');
    action.disabled=Boolean(api.queue.busy);
    title('剧情摘要','时间线、章节与重要事件',action);
    const metrics=el('div','sm-metrics');
    for(const [count,label] of [[Object.keys(mem.leaves).length,'已摘要'],[ready.length,'可自动整理'],[deferred.size,'延迟中'],[validChapters(mem,ctx?.chat||[]).length,'已压缩']]){
      const item=el('div','sm-metric');item.append(el('span','sm-metric-number',count),el('span','sm-metric-label',label));metrics.append(item);
    }
    body.append(metrics);
    if(pending.length){
      const pendingBox=el('section','sm-pending-box'),heading=el('div','sm-pending-heading');
      heading.append(el('strong','', '待整理楼层'),el('span','sm-pending-count',pending.length+' 楼'));
      if(deferred.size)heading.append(el('span','sm-muted-note','其中 '+deferred.size+' 楼暂缓自动摘要'));
      const strip=el('div','sm-pills');
      for(const i of pending.slice(-24)){
        const pill=button('#'+i,()=>api.queue.enqueue([i]),'sm-pill'+(deferred.has(i)?' is-deferred':''));
        pill.title=deferred.has(i)?'延迟窗口内，点击仍可手动补摘':'点击手动补摘';
        strip.append(pill);
      }
      pendingBox.append(heading,strip);body.append(pendingBox);
    }
    const valid=validChapters(mem,ctx?.chat||[]);
    recordCards('分层剧情回顾',valid.slice().reverse(),c=>({title:'L'+c.level+' · '+(c.level===1?'阶段总结':c.level===2?'二次总结':'高层总结'),subtitle:c.children.length+' 段剧情',description:c.summary}),'chapter');
    const state=deriveState(mem,ctx?.chat||[]);
    recordCards('剧情时间线',state.timeline.slice(-50).reverse(),e=>({title:'#'+e.sourceIndex+(e.time?' · '+formatStoryTime(e.time):''),subtitle:e.location||'',description:e.summary}),'floor');
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
    const panel=el('div','sm-entity-merge');
    if(entries.length>1){
      const caption=el('div','sm-entity-hint','若另一条记录确实是同一实体，可以合并称呼；不会改写原始摘要。');
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
      controls.append(picker,merge);panel.append(caption,controls);
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
      panel.append(aliasBox);
    }
    return panel;
  }
  function renderCollection(kind,heading,caption){
    const ctx=api.context(),mem=api.memory(),state=deriveState(mem,ctx?.chat||[]);
    title(heading,caption);
    const entries=(state[kind]||[]).filter(x=>!x.manual);
    const rules=Object.entries(mem.entityAliases?.[kind]||{});
    recordCards('当前'+heading,entries,x=>({title:x.name,description:[
      x.description,x.location&&'位置：'+x.location,x.owner&&'归属：'+x.owner,
      x.relationship&&'关系：'+x.relationship,x.status,x.quantity!==undefined&&'数量：'+x.quantity
    ].filter(Boolean).join(' · ')}),null,x=>entityMergeControl(kind,x,entries,
      rules.filter(([,rule])=>entityNameKey(rule.to)===entityNameKey(x.name))
        .map(([,rule])=>rule)));

    const aliases=Object.values(mem.entityAliases?.[kind]||{});
    if(entries.length>=2||aliases.length){
      const panel=el('details','sm-manual sm-entity-merge');
      const heading=el('summary','sm-manual-head');
      const label=el('span','sm-manual-title');
      label.append(el('span','','合并同一实体的不同称呼'));
      heading.append(label,svg('chevron'));
      const inside=el('div','sm-manual-content');
      inside.append(el('p','sm-help','只有确定是同一个物品、场景或角色时才合并；不删除原始摘要，可撤销合并。'));
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
        },'sm-btn sm-btn-primary'));
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
    manualList(kind,mem.manual[kind]);
    if(!entries.length&&!mem.manual[kind].length)emptyState('package','暂无'+heading+'记录','从剧情提取后会显示在这里，也可以手动添加。');
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
  function renderSettings(){
    const cfg=api.settings();
    title('设置','管理摘要渠道、记忆整理和召回方式');
    const box=el('section','sm-settings'),main=el('div','sm-setting-global');
    const enabled=switchRow('启用记忆引擎',cfg.enabled,'控制记忆整理、注入与检索');
    main.append(enabled.wrapper);box.append(main);

    const modeWrap=el('label','sm-field'),modeLabel=el('span','sm-field-label','摘要使用的 API');
    const mode=el('select','sm-input sm-select');
    for(const [value,caption] of [['main','跟随主 API'],['custom','独立副 API']]){
      const option=el('option','',caption);option.value=value;mode.append(option);
    }
    mode.value=cfg.api.mode==='custom'?'custom':'main';
    modeWrap.append(modeLabel,mode);
    const modeTip=el('p','sm-help','使用酒馆当前连接和模型生成摘要。');
    const apiUrl=field('API 地址',cfg.api.url,'url');
    const credentialLabel = 'API 密钥';
    const credentialInput = field(credentialLabel, '', 'password');
    credentialInput.input.value = cfg.api.key || '';
    credentialInput.input.autocomplete='new-password';
    const modelWrap=el('div','sm-field'),modelLabel=el('span','sm-field-label','模型');
    const modelLine=el('div','sm-model-line'),modelInput=el('input','sm-input');
    modelInput.type='text';modelInput.value=cfg.api.model||'';modelInput.placeholder='填写模型 ID 或刷新获取';
    const modelPicker=el('select','sm-input sm-select');
    modelPicker.hidden=true;modelPicker.setAttribute('aria-label','选择摘要模型');
    const refreshModels=button('↻',async()=>{
      refreshModels.disabled=true;refreshModels.title='正在获取模型列表';
      try{
        const found=await api.fetchSummaryModels({
          url:apiUrl.input.value,key:credentialInput.input.value,
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
    const max=field('最大输出 Tokens',cfg.api.maxTokens,'number','上限 65536；具体可用上限以所选模型为准。');
    max.input.max='65536';max.input.min='256';
    const customFields=el('div','sm-form-stack');
    customFields.append(apiUrl.wrapper,credentialInput.wrapper,modelWrap,grid(temp.wrapper,max.wrapper));
    const updateMode=()=>{const custom=mode.value==='custom';customFields.hidden=!custom;modeTip.hidden=custom;};
    mode.addEventListener('change',updateMode);updateMode();

    const extra=el('details','sm-advanced sm-extra');
    const extraHead=el('summary','sm-advanced-title'),extraLabel=el('span','','附加参数');
    extraHead.append(extraLabel,svg('chevron'));
    const extraContent=el('div','sm-advanced-content');
    const included=textArea(Object.keys(cfg.api.include||{}).length?JSON.stringify(cfg.api.include,null,2):'',4,'prefix: true');
    const excluded=textArea((cfg.api.exclude||[]).join('\n'),3,'frequency_penalty\npresence_penalty');
    const headerLines=Object.entries(cfg.api.headers||{}).map(([k,v])=>k+': '+v).join('\n');
    const headers=textArea(headerLines,3,'x-opencode-session: sillytavern');
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

    // Keep settings compact: one auto-summary panel and one three-column compression strip.
    const auto=switchRow('自动摘要',cfg.autoSummary,'只处理已离开延迟窗口的楼层');
    const hide=switchRow('摘要完成后自动隐藏',cfg.summary.autoHide??true,
      '仅隐藏确认已摘要的旧楼层，原文仍可恢复');
    const recent=field('保留正文',cfg.summary.keepRecent,'number');
    const delay=field('延迟摘要',cfg.summary.delayFloors??3,'number');
    recent.input.min='0';recent.input.max='50';delay.input.min='0';delay.input.max='50';
    recent.input.setAttribute('aria-label','保留正文（AI 楼层）');
    delay.input.setAttribute('aria-label','延迟摘要（AI 楼层）');
    const autoPanel=el('section','sm-summary-panel');
    const autoHead=el('div','sm-summary-head');
    autoHead.append(el('strong','','自动整理'),el('small','','控制整理时机与正文保留'));
    const autoGrid=el('div','sm-summary-control-grid');
    for(const [entry,description] of [
      [delay,'最近 AI 楼层暂不摘要'],[recent,'始终保留在上下文']
    ]){
      const card=el('div','sm-summary-number-card');
      const label=el('div','sm-summary-number-copy');
      label.append(el('strong','',entry===delay?'延迟摘要':'保留正文'),el('small','',description));
      const inputWrap=el('div','sm-summary-input'),unit=el('span','sm-summary-unit','楼');
      inputWrap.append(entry.input,unit);card.append(label,inputWrap);
      autoGrid.append(card);
    }
    const hideNote=el('p','sm-summary-note','仅排除已成功摘要、离开保护窗口的旧楼层。');
    autoPanel.append(autoHead,auto.wrapper,autoGrid,hide.wrapper,hideNote);

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
      control.append(input,el('span','','条'));
      lower.append(control);
      panel.append(heading,lower);
      return {panel,input};
    }
    const leafBatch=levelSetting('L1','阶段总结','合并楼层摘要',cfg.summary.leafBatchThreshold??cfg.summary.chapterEvery??12);
    const second=levelSetting('L2','二次总结','融合多个阶段',cfg.summary.resummaryThreshold??6);
    const higher=levelSetting('L3+','高层总结','浓缩长期主线',cfg.summary.higherResummaryThreshold??3);
    const leafKeep=field('最近 L0 摘要暂不合并',cfg.summary.leafKeepRecent??3,'number');
    leafKeep.input.min='0';leafKeep.input.max='50';
    const compression=el('section','sm-summary-panel');
    const compHead=el('div','sm-summary-head');
    compHead.append(el('strong','','分层压缩'),el('small','','逐级融合旧摘要，保留原始记忆'));
    const pipeline=el('div','sm-level-path');
    for(const token of ['L0 楼层摘要','→','L1 阶段总结','→','L2 二次总结','→','L3+ 长期记忆']){
      pipeline.append(el('span',token.includes('→')?'sm-level-arrow':'',token));
    }
    const levelStrip=el('div','sm-level-strip');
    levelStrip.append(leafBatch.panel,second.panel,higher.panel);
    const keepRow=el('div','sm-level-keep');
    keepRow.append(el('span','','最近 L0 摘要暂不合并'));
    const keepControl=el('label','sm-level-input');
    keepControl.setAttribute('aria-label','最近 L0 摘要暂不合并');
    keepControl.append(leafKeep.input,el('span','','条'));
    keepRow.append(keepControl);
    compression.append(compHead,pipeline,levelStrip,keepRow);

    const sourceLimit=field('单次正文上限（字符）',cfg.summary.maxInputChars,'number');
    const retries=field('网络失败重试次数',cfg.summary.retry,'number');
    const advanced=el('details','sm-summary-advanced'),advancedHead=el('summary','sm-summary-advanced-head');
    const advancedCopy=el('span','sm-summary-advanced-copy');
    advancedCopy.append(el('strong','','高级选项'),el('small','','正文限制、网络重试'));
    advancedHead.append(advancedCopy,svg('chevron'));
    const advancedBody=el('div','sm-summary-advanced-body');
    advancedBody.append(grid(sourceLimit.wrapper,retries.wrapper));
    advanced.append(advancedHead,advancedBody);
    box.append(accordion('summary','摘要设置','自动整理、延迟摘要、楼层隐藏与分层压缩',[
      autoPanel,compression,advanced
    ]));

    const flags=[['summary','剧情摘要'],['inventory','物品状态'],
      ['scenes','场景地点'],['characters','人物档案'],['vector','向量召回']]
      .map(([key,label])=>[key,switchRow(label,cfg.injection[key])]);
    const flagGroup=el('div','sm-switch-grid');
    flagGroup.append(...flags.map(([,x])=>x.wrapper));
    const budget=field('注入预算（估算 Tokens）',cfg.injection.budget,'number');
    box.append(accordion('inject','注入设置','控制发送给主模型的记忆类型',[
      flagGroup,budget.wrapper,
      button('查看注入预览',()=>{page='preview';render();},'sm-btn')
    ]));

    const vector=switchRow('启用向量检索',cfg.vector.enabled);
    const vectorUrl=field('Embedding API 地址',cfg.vector.url||'https://api.siliconflow.cn/v1','url');
    const vectorKey=field('Embedding API 密钥',cfg.vector.key||'','password',
      '独立于酒馆主 API 和酒馆的 SiliconFlow 密钥；保存在本插件设置，请保护配置备份。');
    vectorKey.input.autocomplete='new-password';
    const vectorModel=field('Embedding 模型',cfg.vector.model);
    const topK=field('召回数量 Top-K',cfg.vector.topK,'number');
    const threshold=field('相似度阈值',cfg.vector.threshold,'number');
    const vectorHelp=el('p','sm-help','直接向 Embedding 接口发送请求，不更改酒馆密钥。服务商需允许浏览器跨域（CORS）；索引缓存在当前浏览器，换电脑可重新建立。');
    const vectorActions=el('div','sm-row-actions');
    vectorActions.append(button('更新当前聊天索引',async()=>{
      showNotice('正在更新向量索引…');
      try{const count=await api.indexNow();showNotice('已更新 '+count+' 条记忆');}
      catch(e){showNotice(e?.message||'索引失败，请检查 API 与跨域设置');}
    },'sm-btn'));
    box.append(accordion('vector','向量记忆','独立 Embedding API 与相关剧情召回',[
      vector.wrapper,vectorUrl.wrapper,vectorKey.wrapper,vectorModel.wrapper,
      grid(topK.wrapper,threshold.wrapper),vectorHelp,vectorActions
    ]));


    const promptConfigs=[
      {key:'summaryFull',name:'楼层摘要与状态提取',desc:'同时整理摘要、物品、场景、角色与计划',def:DEFAULT_SUMMARY_PROMPT,initial:effectiveSummaryPrompt(cfg)},
      {key:'chapter',name:'首次总结（L1）',desc:'将楼层摘要整理为章节',def:DEFAULT_CHAPTER_PROMPT,initial:cfg.prompts.chapter||DEFAULT_CHAPTER_PROMPT},
      {key:'resummary2',name:'二次总结（L2）',desc:'进一步融合多条首次总结',def:DEFAULT_RESUMMARY2_PROMPT,initial:cfg.prompts.resummary2||DEFAULT_RESUMMARY2_PROMPT},
      {key:'overview',name:'高层总结（L3+）',desc:'持续压缩旧剧情，保留长期主线',def:DEFAULT_OVERVIEW_PROMPT,initial:cfg.prompts.overview||DEFAULT_OVERVIEW_PROMPT}
    ];
    const promptEditors=new Map(),promptSections=[];
    for(const spec of promptConfigs){
      const group=el('details','sm-prompt-group'),head=el('summary','sm-prompt-head');
      const label=el('span','sm-prompt-title');
      label.append(el('strong','',spec.name),el('small','',spec.desc));
      head.append(label,svg('chevron'));
      const promptArea=textArea(spec.initial,11);
      promptArea.classList?.add('sm-prompt-textarea');
      const toolbar=el('div','sm-prompt-toolbar');
      toolbar.append(el('small','sm-help','编辑后点击页面底部「保存设置」生效'));
      toolbar.append(button('恢复默认',()=>{promptArea.value=spec.def;},'sm-btn'));
      const content=el('div','sm-prompt-content');content.append(promptArea,toolbar);
      group.append(head,content);promptSections.push(group);
      promptEditors.set(spec.key,promptArea);
    }
    box.append(accordion('prompts','自定义提示词','查看完整默认提示词、修改或恢复默认',promptSections));

    const saveBar=el('div','sm-settings-save'),save=button('保存设置',()=>{
      try{
        const next=structuredClone(cfg);
        next.enabled=enabled.input.checked;next.autoSummary=auto.input.checked;
        next.api.mode=mode.value==='main'?'main':'custom';
        next.api.url=apiUrl.input.value.trim();next.api.key=credentialInput.input.value.trim();
        next.api.model=modelInput.value.trim();
        next.api.temperature=Math.max(0,Math.min(2,Number(temp.input.value)||0));
        next.api.maxTokens=Math.max(256,Math.min(65536,Number(max.input.value)||8192));
        next.api.include=parseExtraBody(included.value);
        next.api.exclude=parseExcluded(excluded.value);
        next.api.headers=parseHeaderLines(headers.value);
        next.summary.keepRecent=Math.max(0,Math.min(50,Number(recent.input.value)||0));
        next.summary.delayFloors=Math.max(0,Math.min(50,Number(delay.input.value)||0));
        next.summary.autoHide=hide.input.checked;
        next.summary.leafBatchThreshold=Math.max(0,Math.min(100,Number(leafBatch.input.value)||0));
        next.summary.leafKeepRecent=Math.max(0,Math.min(50,Number(leafKeep.input.value)||0));
        next.summary.resummaryThreshold=Math.max(0,Math.min(100,Number(second.input.value)||0));
        next.summary.higherResummaryThreshold=Math.max(0,Math.min(100,Number(higher.input.value)||0));
        delete next.summary.chapterEvery;
        next.summary.maxInputChars=Math.max(2000,Math.min(30000,Number(sourceLimit.input.value)||16000));
        next.summary.retry=Math.max(0,Math.min(2,Number(retries.input.value)||0));
        next.injection.budget=Number(budget.input.value)||4500;
        for(const [key,value] of flags)next.injection[key]=value.input.checked;
        next.vector.enabled=vector.input.checked;
        next.vector.url=vectorUrl.input.value.trim();
        next.vector.key=vectorKey.input.value.trim();
        next.vector.model=vectorModel.input.value.trim();
        next.vector.topK=Math.max(1,Math.min(10,Number(topK.input.value)||5));
        next.vector.threshold=Math.max(0,Math.min(1,Number(threshold.input.value)||0));
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
        api.saveSettings(next);showNotice('设置已保存');
      }catch(e){showNotice('保存失败：'+e.message);}
    },'sm-btn sm-btn-primary');
    const reset=button('恢复默认',()=>{
      const ask=window.confirm(
        '要恢复默认设置吗？\n\n会重置摘要、注入、向量检索参数和自定义提示词。\n保留 API 地址与密钥、摘要 API 模型及附加参数。Embedding 模型将恢复 BAAI/bge-m3。\n已生成的剧情记忆不会删除。'
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
        api.saveSettings(defaults);
        render();
        showNotice('已恢复默认设置（保留 API 连接信息）');
      }catch(e){showNotice('恢复失败：'+e.message);}
    },'sm-btn');
    reset.setAttribute('data-testid','reset-settings');
    saveBar.append(reset,save);box.append(saveBar);body.append(box);
  }
  function renderPreview(){
    const ctx=api.context(),result=injectionText(api.memory(),ctx?.chat||[],api.settings());
    title('注入预览','查看下一轮对话将使用的记忆内容');
    const textarea=textArea(result||'当前没有需要注入的记忆。',13);textarea.readOnly=true;
    body.append(textarea,el('p','sm-help','约 '+Math.ceil(result.length/3)+' Tokens；向量记忆在生成时单独检索。'));
  }
  function render(){
    if(!active)return;
    closeRecordModal(false);
    body.replaceChildren();nav.replaceChildren();
    for(const [name,label,icon] of NAV){
      const item=button('',()=>{if(page===name)return;page=name;notice='';render();body.scrollTop=0;},'sm-nav-item'+(page===name?' is-current':''));
      item.append(svg(icon),el('span','',label));item.setAttribute('aria-current',page===name?'page':'false');nav.append(item);
    }
    if(page==='summaries')renderSummary();
    else if(page==='items')renderCollection('items','物品','重要物件和持有状态');
    else if(page==='scenes')renderCollection('scenes','场景','地点与环境记录');
    else if(page==='characters')renderCollection('characters','角色','人物档案及关系变化');
    else if(page==='settings')renderSettings();
    else renderPreview();
    if(notice)showNotice(notice);
  }
  return {open,refresh(){
    // Refreshing while editing settings would discard unsaved form input.
    if(active&&page!=='settings')render();
  },report:showNotice};
}
