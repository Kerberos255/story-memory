import {pendingFloors,deriveState,injectionText} from './core.js';
const NAV=[['summaries','摘要','▤'],['items','物品','◇'],['scenes','场景','⌁'],['characters','角色','♙'],['settings','设置','⚙']];
const node=(tag,cls,text)=>{
  const result=document.createElement(tag);if(cls)result.className=cls;
  if(text!==undefined)result.textContent=text;return result;
};
function button(label,action,cls='sm-button'){
  const b=node('button',cls,label);b.type='button';b.addEventListener('click',action);return b;
}
function field(labelText,value,type='text'){
  const wrapper=node('label','sm-field'),title=node('span','sm-field-label',labelText),input=node('input','sm-input');
  input.type=type;input.value=String(value??'');wrapper.append(title,input);return {wrapper,input};
}
function check(labelText,checked){
  const wrapper=node('label','sm-check'),input=node('input');input.type='checkbox';input.checked=Boolean(checked);
  wrapper.append(input,node('span','',labelText));return {wrapper,input};
}
export function mountUI(api){
  const host=node('div');host.id='story-memory-host';document.body.append(host);
  host.style.display='contents';
  const shadow=host.attachShadow({mode:'open'}),css=node('link');
  css.rel='stylesheet';css.href=new URL('./style.css',import.meta.url).href;shadow.append(css);
  const dialog=node('dialog','sm-dialog');
  dialog.setAttribute('aria-label','剧情记忆');
  shadow.append(dialog);
  const header=node('header','sm-header'),brand=node('div','sm-brand'),title=node('span','sm-title','剧情记忆'),sub=node('small','sm-caption','STORY MEMORY · PRIVATE');
  brand.append(node('span','sm-symbol','✦'),title,sub);
  const close=button('×',()=>open(false),'sm-close');close.setAttribute('aria-label','关闭弹窗');
  header.append(brand,close);
  const content=node('div','sm-layout'),nav=node('nav','sm-nav'),body=node('main','sm-main');
  content.append(nav,body);dialog.append(header,content);
  dialog.addEventListener('cancel',event=>{event.preventDefault();open(false);});
  dialog.addEventListener('click',event=>{
    // For backdrop clicks, dialog is the target but the pointer lies outside its box.
    if(event.target!==dialog)return;
    const rect=dialog.getBoundingClientRect();
    if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)open(false);
  });
  let page='summaries',active=false,status='';
  const report=message=>{status=String(message||'');render();};
  function open(value=true){
    if(value){
      if(!dialog.open){dialog.showModal();}
      active=true;render();close.focus();
    }else{
      active=false;
      if(dialog.open)dialog.close();
      // Releasing the page DOM keeps the idle footprint small.
      nav.replaceChildren();body.replaceChildren();
      api.onClose?.();
    }
  }
  function refresh(){if(active)render();}
  function top(headerText,caption){
    const row=node('div','sm-page-heading'),stack=node('div');
    stack.append(node('h2','sm-h2',headerText),node('p','sm-muted',caption));
    row.append(stack);body.append(row);return row;
  }
  function empty(message){body.append(node('p','sm-empty',message));}
  function addRows(title,entries,extract){
    if(!entries.length)return;
    body.append(node('h3','sm-section-title',title));
    for(const entry of entries){
      const details=node('details','sm-record'),summary=node('summary','sm-record-heading',extract(entry).title);
      details.append(summary,node('p','sm-record-text',extract(entry).description));body.append(details);
    }
  }
  function manualRows(kind,entries){
    if(!entries?.length)return;
    body.append(node('h3','sm-section-title','手动记录 · '+entries.length));
    for(const entry of entries){
      const card=node('details','sm-record'),head=node('summary','sm-record-heading',entry.text.slice(0,90));
      const textarea=node('textarea','sm-textarea');textarea.value=entry.text;textarea.rows=4;
      const actions=node('div','sm-actions');
      actions.append(button('保存修改',()=>{
        try{api.editManual(kind,entry.id,textarea.value);report('记录已更新');}catch(e){report(e.message);}
      }));
      actions.append(button('删除',()=>{
        if(!window.confirm('确定删除这条手动记录？'))return;
        try{api.removeManual(kind,entry.id);report('记录已删除');}catch(e){report(e.message);}
      }));
      card.append(head,textarea,actions);body.append(card);
    }
  }
  function manualBox(kind){
    const section=node('section','sm-compose'),label=node('h3','sm-section-title','手动输入／导入');
    const textarea=node('textarea','sm-textarea');textarea.rows=4;textarea.placeholder='输入要长期记住的信息，可直接粘贴旧剧情摘要……';
    const controls=node('div','sm-actions'),file=node('input');file.type='file';file.accept='.txt,.md,text/plain,text/markdown';file.className='sm-file';
    file.addEventListener('change',async()=>{const f=file.files?.[0];if(!f)return;if(f.size>12000){report('单条记忆限 12 KB，请分段导入');return;}textarea.value=await f.text();});
    controls.append(file,button('保存记录',()=>{try{api.addManual(kind,textarea.value);textarea.value='';report('已保存到当前聊天');}catch(e){report(e.message);}},'sm-primary'));
    section.append(label,textarea,controls);body.append(section);
  }
  function renderSummary(){
    const ctx=api.context(),mem=api.memory(),pending=pendingFloors(mem,ctx?.chat||[]);
    const heading=top('剧情摘要','保留事件、时间线与未解决的故事线。');
    heading.append(button(api.queue.busy?'整理中…':'批量补摘',()=>api.queue.enqueueMissing(80),'sm-primary'));
    const metrics=node('div','sm-metrics');
    for(const [number,label] of [[Object.keys(mem.leaves).length,'已摘要楼层'],[pending.length,'待整理楼层'],[mem.chapters.length,'章节总结']]){
      const box=node('div','sm-metric');box.append(node('b','',String(number)),node('small','',label));metrics.append(box);
    }
    body.append(metrics);
    if(pending.length){
      body.append(node('h3','sm-section-title','待整理 · '+pending.length+' 楼'));
      const strip=node('div','sm-pending');
      for(const index of pending.slice(-22)){
        strip.append(button('#'+index,()=>api.queue.enqueue([index]),'sm-pill'));
      }
      body.append(strip);
    }
    addRows('章节总结',mem.chapters,(entry)=>({title:'章节 · '+entry.children.length+' 楼',description:entry.summary}));
    const state=deriveState(mem,ctx?.chat||[]);
    addRows('楼层摘要',state.timeline.slice(-70).reverse(),entry=>({title:'#'+entry.sourceIndex+(entry.time?' · '+entry.time:''),description:entry.summary}));
    manualRows('summaries',mem.manual?.summaries||[]);
    if(!state.timeline.length&&!mem.manual.summaries.length)empty('还没有摘要。可以先手动输入，或配置副 API 后补摘。');
    manualBox('summaries');
  }
  function renderCollection(kind,title,caption){
    const ctx=api.context(),mem=api.memory(),derived=deriveState(mem,ctx?.chat||[]);
    top(title,caption);
    const entries=(derived[kind]||[]).filter(x=>!x.manual);
    addRows('当前记录 · '+entries.length,entries,x=>({title:x.name,description:x.manual?'手动记录':[
      x.description,x.location&&'位置：'+x.location,x.owner&&'归属：'+x.owner,
      x.relationship&&'关系：'+x.relationship,x.status,x.quantity!==undefined&&'数量：'+x.quantity
    ].filter(Boolean).join(' · ')}));
    if(!entries.length)empty('尚无'+title+'记录。');
    manualRows(kind,mem.manual?.[kind]||[]);
    manualBox(kind);
  }
  function renderSettings(){
    const settings=api.settings();
    const heading=top('插件设置','独立副 API、自动任务和主模型记忆注入。');
    heading.append(button('查看注入预览',()=>{page='preview';render();},'sm-button'));
    const settingsForm=node('div','sm-settings');
    const general=node('section','sm-panel');general.append(node('h3','sm-section-title','运行'));
    const enabled=check('启用记忆引擎',settings.enabled),auto=check('自动摘要新楼层',settings.autoSummary);
    const recent=field('最近正文保留楼数',settings.summary.keepRecent,'number');
    const chapter=field('每章合并摘要数',settings.summary.chapterEvery,'number');
    general.append(enabled.wrapper,auto.wrapper,recent.wrapper,chapter.wrapper);settingsForm.append(general);

    const channel=node('section','sm-panel');channel.append(node('h3','sm-section-title','副 API · OpenAI 兼容'));
    const apiUrl=field('API 地址',settings.api.url),model=field('模型 ID',settings.api.model);
    const temp=field('Temperature',settings.api.temperature,'number'),max=field('最大输出 Tokens',settings.api.maxTokens,'number');
    const excluded=field('排除参数（英文逗号分隔）',settings.api.exclude.join(', '));
    const headers=node('textarea','sm-textarea');headers.rows=3;headers.value=JSON.stringify(settings.api.headers||{},null,2);
    const included=node('textarea','sm-textarea');included.rows=3;included.value=JSON.stringify(settings.api.include||{},null,2);
    channel.append(apiUrl.wrapper,model.wrapper,node('p','sm-muted','密钥在酒馆 Custom API 中配置；额外请求标头由你自行填写，不会自动添加。'),temp.wrapper,max.wrapper,excluded.wrapper,
      node('span','sm-field-label','包含请求标头（JSON 对象，自行配置；不要填密钥）'),headers,
      node('span','sm-field-label','附加请求参数（JSON 对象）'),included);
    settingsForm.append(channel);

    const summary=node('section','sm-panel');summary.append(node('h3','sm-section-title','摘要与自定义提示词'));
    const sourceLimit=field('单次摘要最大正文字符',settings.summary.maxInputChars,'number');
    const retries=field('临时错误重试次数（0–2）',settings.summary.retry,'number');
    const summaryPrompt=node('textarea','sm-textarea');summaryPrompt.rows=4;summaryPrompt.placeholder='留空使用内置短提示词';summaryPrompt.value=settings.prompts.summary||'';
    const chapterPrompt=node('textarea','sm-textarea');chapterPrompt.rows=3;chapterPrompt.placeholder='留空使用内置章节总结提示词';chapterPrompt.value=settings.prompts.chapter||'';
    summary.append(sourceLimit.wrapper,retries.wrapper,node('span','sm-field-label','摘要附加指令'),summaryPrompt,node('span','sm-field-label','章节总结指令'),chapterPrompt);
    settingsForm.append(summary);

    const inject=node('section','sm-panel');inject.append(node('h3','sm-section-title','记忆注入'));
    const flags=[
      ['summary','剧情摘要'],['inventory','物品状态'],['scenes','场景地点'],['characters','角色档案'],['vector','向量召回']
    ].map(([key,label])=>[key,check(label,settings.injection[key])]);
    for(const [,c] of flags)inject.append(c.wrapper);
    const budget=field('注入预算（估算 Tokens）',settings.injection.budget,'number');inject.append(budget.wrapper);settingsForm.append(inject);

    const v=node('section','sm-panel');v.append(node('h3','sm-section-title','向量记忆 · 按需开启'));
    const vec=check('启用 Embedding 检索',settings.vector.enabled);
    const vModel=field('Embedding 模型',settings.vector.model);
    const topK=field('Top-K 召回数量',settings.vector.topK,'number');
    v.append(vec.wrapper,node('p','sm-muted','复用酒馆 /api/vector 服务端索引。服务商：硅基流动；API 密钥在酒馆自身配置。'),vModel.wrapper,topK.wrapper);
    v.append(button('建立／更新当前聊天索引',async()=>{report('正在索引…');try{const n=await api.indexNow();report('已索引 '+n+' 条记忆');}catch(e){report(e.message);}},'sm-button'));settingsForm.append(v);
    const save=button('保存设置',()=>{
      try{
        const obj=structuredClone(settings);
        const getJson=input=>{const data=JSON.parse(input.value||'{}');if(!data||typeof data!=='object'||Array.isArray(data))throw Error('JSON 必须是对象');return data;};
        obj.enabled=enabled.input.checked;obj.autoSummary=auto.input.checked;
        obj.summary.keepRecent=Math.max(0,Math.min(30,Number(recent.input.value)||0));
        obj.summary.chapterEvery=Math.max(3,Math.min(30,Number(chapter.input.value)||8));
        obj.summary.maxInputChars=Math.max(2000,Math.min(30000,Number(sourceLimit.input.value)||16000));
        obj.summary.retry=Math.max(0,Math.min(2,Number(retries.input.value)||0));
        obj.api.url=apiUrl.input.value.trim();obj.api.model=model.input.value.trim();delete obj.api.openCodeSession;
        delete obj.api.key;
        obj.api.temperature=Number(temp.input.value)||0;obj.api.maxTokens=Number(max.input.value)||4096;
        obj.api.exclude=excluded.input.value.split(',').map(x=>x.trim()).filter(Boolean);
        obj.api.headers=getJson(headers);obj.api.include=getJson(included);
        obj.prompts.summary=summaryPrompt.value;obj.prompts.chapter=chapterPrompt.value;
        for(const [k,c] of flags)obj.injection[k]=c.input.checked;
        obj.injection.budget=Number(budget.input.value)||4500;
        obj.vector.enabled=vec.input.checked;obj.vector.source='siliconflow';
        obj.vector.model=vModel.input.value.trim();delete obj.vector.key;delete obj.vector.url;
        obj.vector.topK=Math.max(1,Math.min(10,Number(topK.input.value)||5));
        api.saveSettings(obj);report('设置已保存');
      }catch(e){report('保存失败：'+e.message);}
    },'sm-primary sm-save');
    settingsForm.append(save);body.append(settingsForm);
  }
  function renderPreview(){
    const ctx=api.context(),text=injectionText(api.memory(),ctx?.chat||[],api.settings());
    top('注入预览','这部分内容将在生成时放入主对话系统提示词。');
    const textarea=node('textarea','sm-textarea sm-preview');textarea.readOnly=true;textarea.value=text||'当前没有需要注入的记忆。';
    body.append(textarea,node('p','sm-muted','大小估计：约 '+Math.ceil(text.length/3)+' tokens。向量召回是按生成时查询动态追加的。'));
  }
  function render(){
    if(!active)return;nav.replaceChildren();body.replaceChildren();
    for(const [key,label,icon] of NAV){
      const tab=button(icon+'  '+label,()=>{page=key;status='';render();},'sm-nav-item'+(page===key?' active':''));
      tab.setAttribute('aria-current',page===key?'page':'false');nav.append(tab);
    }
    const footer=node('div','sm-nav-footer','Story Memory · v0.1 开发版');nav.append(footer);
    if(page==='summaries')renderSummary();
    else if(page==='items')renderCollection('items','物品','数量、持有者与存放地，变更可追溯。');
    else if(page==='scenes')renderCollection('scenes','场景','地点、人物位置与环境记录。');
    else if(page==='characters')renderCollection('characters','角色','人物身份、关系、状态与重要背景。');
    else if(page==='settings')renderSettings();else renderPreview();
    if(status){const tip=node('div','sm-toast',status);body.prepend(tip);}
  }
  return {open,refresh,report};
}
