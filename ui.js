import {pendingFloors,automaticFloorIndices,deriveState,injectionText,validChapters} from './core.js';
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
  dialog.addEventListener('cancel',e=>{e.preventDefault();open(false);});
  dialog.addEventListener('click',e=>{
    if(e.target!==dialog)return;
    const rect=dialog.getBoundingClientRect();
    if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)open(false);
  });
  function open(value=true){
    if(value){
      active=true;if(!dialog.open)dialog.showModal();
      render();close.focus();
    }else{
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
  function recordCards(heading,entries,extract){
    if(!entries.length)return;
    body.append(sectionTitle(heading));
    const list=el('div','sm-record-list');
    for(const entry of entries){
      const value=extract(entry),details=el('details','sm-record');
      const head=el('summary','sm-record-head'),label=el('span','sm-record-label',value.title);
      head.append(label,svg('chevron'));
      details.append(head,el('p','sm-record-text',value.description||'暂无详情'));list.append(details);
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
    recordCards('分层剧情回顾',valid.slice().reverse(),c=>({title:'L'+c.level+' · '+(c.level===1?'首次总结':c.level===2?'二次总结':'高层总结')+' · '+c.children.length+' 段',description:c.summary}));
    const state=deriveState(mem,ctx?.chat||[]);
    recordCards('剧情时间线',state.timeline.slice(-50).reverse(),e=>({title:'#'+e.sourceIndex+(e.time?' · '+e.time:''),description:e.summary}));
    manualList('summaries',mem.manual.summaries);
    if(!state.timeline.length&&!mem.manual.summaries.length)emptyState('book','还没有剧情摘要','可以先添加记忆，或配置副 API 后整理楼层。');
    manualInput('summaries');
  }
  function renderCollection(kind,heading,caption){
    const ctx=api.context(),mem=api.memory(),state=deriveState(mem,ctx?.chat||[]);
    title(heading,caption);
    const entries=(state[kind]||[]).filter(x=>!x.manual);
    recordCards('当前'+heading,entries,x=>({title:x.name,description:[
      x.description,x.location&&'位置：'+x.location,x.owner&&'归属：'+x.owner,
      x.relationship&&'关系：'+x.relationship,x.status,x.quantity!==undefined&&'数量：'+x.quantity
    ].filter(Boolean).join(' · ')}));
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

    const recent=field('保留最近正文（AI 楼层）',cfg.summary.keepRecent,'number',
      '始终保留在主对话上下文中，不自动隐藏；按 AI 回复数计算，不含用户消息。');
    const delay=field('延迟自动摘要（AI 楼层）',cfg.summary.delayFloors??3,'number',
      '默认 3：最新 3 个 AI 楼层暂不自动摘要，生成第 4 楼时才处理更早的楼层。手动补摘不受此限制。');
    const auto=switchRow('自动摘要',cfg.autoSummary,'每次 AI 回复完成后，自动整理已离开延迟窗口的待摘要楼层。');
    const hide=switchRow('摘要成功后自动隐藏楼层',cfg.summary.autoHide??false,
      '仅隐藏摘要完整且有效、离开保护窗口的 AI 楼层及对应用户消息。关闭本选项不自动恢复已隐藏内容，可使用酒馆 /unhide 恢复。');
    const leafBatch=field('首次总结阈值（L0 → L1）',cfg.summary.leafBatchThreshold??cfg.summary.chapterEvery??12,'number');
    const leafKeep=field('L0 最近摘要不合并（条）',cfg.summary.leafKeepRecent??3,'number');
    const second=field('二次总结阈值（L1 → L2）',cfg.summary.resummaryThreshold??6,'number');
    const higher=field('高层总结阈值（L2+）',cfg.summary.higherResummaryThreshold??3,'number');
    const sourceLimit=field('单次正文上限（字符）',cfg.summary.maxInputChars,'number');
    const retries=field('网络失败重试次数',cfg.summary.retry,'number');
    const autoHint=el('p','sm-help','自动隐藏只在摘要成功后执行，不会删除聊天记录。最近保留数量与延迟数量以较大值为保护窗口；摘要失败或内容变更时不会隐藏。');
    box.append(accordion('summary','摘要设置','自动整理、延迟摘要、楼层隐藏与多级压缩',[
      sectionTitle('自动整理','控制何时摘要，以及哪些原文可以从模型上下文排除'),
      auto.wrapper,grid(delay.wrapper,recent.wrapper),hide.wrapper,autoHint,
      sectionTitle('分层压缩','只合并旧摘要，保留底层记忆；阈值填 0 可关闭对应层级'),
      grid(leafBatch.wrapper,leafKeep.wrapper),grid(second.wrapper,higher.wrapper),
      sectionTitle('质量与稳定','限制单次材料长度，避免无效请求和重复尝试'),
      grid(sourceLimit.wrapper,retries.wrapper)
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
    saveBar.append(save);box.append(saveBar);body.append(box);
  }
  function renderPreview(){
    const ctx=api.context(),result=injectionText(api.memory(),ctx?.chat||[],api.settings());
    title('注入预览','查看下一轮对话将使用的记忆内容');
    const textarea=textArea(result||'当前没有需要注入的记忆。',13);textarea.readOnly=true;
    body.append(textarea,el('p','sm-help','约 '+Math.ceil(result.length/3)+' Tokens；向量记忆在生成时单独检索。'));
  }
  function render(){
    if(!active)return;
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
