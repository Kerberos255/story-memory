import {pendingFloors,automaticFloorIndices,leafValid,taskForFloor} from './core.js';

const element=(tag,cls,text)=>{
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  if(text!==undefined)node.textContent=String(text);
  return node;
};
const button=(text,onClick,cls='sm-btn')=>{
  const b=element('button',cls,text);b.type='button';b.addEventListener('click',onClick);return b;
};
const ERRORS={
  network_error:'网络连接失败',timeout:'API 请求超时',interrupted:'上次整理任务被中断',
  upstream_http_400:'请求参数错误',upstream_http_401:'API 认证失败',
  upstream_http_403:'API 拒绝访问',upstream_http_404:'API 地址或模型不存在',
  upstream_http_429:'请求频率受限',invalid_json:'摘要返回格式不正确'
};
export function describeTaskError(task){
  const code=String(task?.code||'');
  if(ERRORS[code])return ERRORS[code];
  if(/^upstream_http_5\d\d$/.test(code))return 'API 服务暂时不可用';
  return code?'错误代码：'+code:'未记录错误原因';
}
export function pendingGroups(memory,chat,config){
  const pending=pendingFloors(memory,chat);
  const eligible=new Set(automaticFloorIndices({...memory,tasks:{}},chat,config.summary?.delayFloors??3));
  const groups={failed:[],cooldown:[],running:[],ready:[],delay:[]};
  for(const i of pending){
    const task=taskForFloor(memory,chat,i);
    if(task?.status==='failed')groups.failed.push(i);
    else if(task?.status==='cooldown')groups.cooldown.push(i);
    else if(task?.status==='running')groups.running.push(i);
    else if(!eligible.has(i))groups.delay.push(i);
    else groups.ready.push(i);
  }
  return {groups,pending,complete:chat.reduce((n,_,i)=>n+(leafValid(memory,chat,i)?1:0),0)};
}
export function createPendingPanel({memory,chat,config,queue,state,summary,rerender,notice}){
  const {groups,pending,complete}=summary||pendingGroups(memory,chat,config);
  const total=complete+pending.length;
  const panel=element('section','sm-progress-panel');
  panel.setAttribute('data-testid','summary-progress');
  const head=element('div','sm-progress-heading'),left=element('div','sm-progress-heading-left');
  left.append(element('strong','','整理进度'),
    element('span','sm-progress-caption',config.autoSummary?'自动整理已开启':'自动整理已关闭'));
  head.append(left);
  if(queue?.busy)head.append(element('span','sm-progress-active','正在整理'));
  panel.append(head);
  if(!total){panel.append(element('p','sm-progress-complete','当前还没有需要整理的剧情楼层。'));return panel;}
  const overview=element('div','sm-progress-overview'),numbers=element('div','sm-progress-numbers');
  const caption=element('div','sm-progress-number-copy');
  caption.append(element('small','','当前剧情整理进度'),element('strong','',complete+' / '+total+' 楼'));
  const percent=Math.round(complete/total*100);
  numbers.append(caption,element('strong','sm-progress-percent',percent+'%'));
  const track=element('div','sm-progress-track'),fill=element('div','sm-progress-fill');
  fill.style.width=percent+'%';
  track.setAttribute('role','progressbar');track.setAttribute('aria-label','剧情整理完成比例');
  track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(percent));
  track.append(fill);
  const counts=element('div','sm-progress-totals');
  counts.append(element('span','',complete+' 楼已完成'),element('span','',pending.length+' 楼待处理'));
  overview.append(numbers,track,counts);panel.append(overview);
  if(!pending.length){
    panel.append(element('p','sm-progress-complete','所有有效剧情楼层均已整理完成。'));
    return panel;
  }
  const sectionHeading=element('div','sm-progress-section-heading');
  sectionHeading.append(element('strong','','待处理任务'),element('span','', '按状态分类 · 异常优先'));
  panel.append(sectionHeading);
  const groupInfo={
    failed:{title:'需要关注',sub:'自动处理已停止，请检查原因'},
    cooldown:{title:'等待自动重试',sub:'临时故障，冷却后自动恢复'},
    running:{title:'正在整理',sub:'摘要任务执行中'},
    ready:{title:'等待整理',sub:'可自动处理，也能手动补摘'},
    delay:{title:'延迟保护',sub:'最近的剧情暂缓自动整理'}
  };
  const groupList=element('div','sm-progress-groups');
  const ordered=['failed','cooldown','running','ready','delay'].filter(x=>groups[x].length);
  if(state.expanded&&!ordered.includes(state.expanded))state.expanded=ordered[0]||'';
  const enqueue=(indices)=>{
    queue?.enqueue(indices);
    notice?.(indices.length===1?'已将 #'+indices[0]+' 加入整理队列':'已将 '+indices.length+' 楼加入整理队列');
  };
  for(const kind of ordered){
    const indices=groups[kind],info=groupInfo[kind];
    const card=element('div','sm-progress-group'+(kind==='failed'?' is-failed':''));
    const heading=button('',()=>{state.expanded=state.expanded===kind?'':kind;rerender();},'sm-progress-group-head');
    heading.setAttribute('aria-expanded',String(state.expanded===kind));
    const dot=element('span','sm-progress-dot is-'+kind),copy=element('span','sm-progress-group-copy');
    copy.append(element('strong','',info.title),element('small','',info.sub));
    heading.append(dot,copy,element('span','sm-progress-group-count',indices.length+' 楼'),
      element('span','sm-progress-chevron',state.expanded===kind?'⌃':'⌄'));
    card.append(heading);
    if(state.expanded===kind){
      const details=element('div','sm-progress-details');
      if(['failed','cooldown','running'].includes(kind)){
        for(const i of indices.slice(0,24)){
          const task=taskForFloor(memory,chat,i)||{};
          const row=element('div','sm-progress-task'),text=element('div','sm-progress-task-copy');
          text.append(element('strong','', '#'+i+' · '+(kind==='failed'?'整理失败':kind==='cooldown'?'等待恢复':'正在处理')),
            element('small','',describeTaskError(task)));
          if(kind==='cooldown'&&Number(task.nextRetryAt)>0)
            text.append(element('small','', '预计 '+new Date(task.nextRetryAt).toLocaleTimeString('zh-CN')+' 后重试'));
          if(kind==='failed')
            text.append(element('small','', '已尝试 '+(task.attempts||1)+' 次 · '+
              (task.updatedAt?new Date(task.updatedAt).toLocaleString('zh-CN'):'时间未知')));
          row.append(text);
          if(kind!=='running')row.append(button(kind==='failed'?'重新整理':'立即重试',
            ()=>enqueue([i]),'sm-btn sm-btn-sm'+(kind==='failed'?' sm-btn-primary':'')));
          details.append(row);
        }
      }else{
        const grid=element('div','sm-progress-floor-grid');
        for(const i of indices.slice(0,24)){
          const item=button('#'+i,()=>enqueue([i]),'sm-progress-floor');
          item.title=kind==='delay'?'手动补摘（自动延迟保护仍生效）':'单楼补摘';
          grid.append(item);
        }
        details.append(grid);
        if(kind==='ready')details.append(button('整理这 '+indices.length+' 楼',
          ()=>enqueue(indices),'sm-btn sm-btn-sm'));
      }
      if(indices.length>24)details.append(button('在全部楼层中查看其余 '+(indices.length-24)+' 楼',()=>{
        state.all=true;state.limit=Math.max(state.limit,40);rerender();
      },'sm-btn sm-btn-text'));
      card.append(details);
    }
    groupList.append(card);
  }
  panel.append(groupList);
  const expand=button((state.all?'收起':'查看全部')+' '+pending.length+' 个待整理楼层',
    ()=>{state.all=!state.all;state.limit=40;rerender();},'sm-progress-expand');
  expand.setAttribute('aria-expanded',String(state.all));panel.append(expand);
  if(state.all){
    const all=element('div','sm-progress-all'),grid=element('div','sm-progress-floor-grid');
    const prioritized=ordered.flatMap(kind=>groups[kind].map(index=>({kind,index})));
    for(const {kind,index} of prioritized.slice(0,state.limit)){
      const item=button('#'+index,()=>enqueue([index]),'sm-progress-floor is-'+kind);
      item.title=groupInfo[kind].title+' · 点击整理';grid.append(item);
    }
    all.append(grid);
    if(prioritized.length>state.limit)all.append(button('加载更多楼层',()=>{
      state.limit+=40;rerender();
    },'sm-btn sm-btn-text'));
    panel.append(all);
  }
  return panel;
}
