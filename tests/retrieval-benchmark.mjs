// Synthetic browser-side memory search benchmark. Does not read real chat data.
import {selectHistory,historyEvidence,searchIndex} from '../retrieval-local.js';
import {messageFingerprint,freshMemory} from '../core.js';

for(const count of [1000,10000,50000]){
  const chat=[],memory=freshMemory();
  for(let i=0;i<count;i++){
    const msg={is_user:false,mes:i%97===0?'主角收起那枚蓝宝石戒指，记起和艾琳的约定。':'主角从城堡走到森林，遇见其他居民。',swipe_id:0};
    chat.push(msg);
    memory.leaves[i]={id:'floor:'+i,sourceIndex:i,fingerprint:messageFingerprint(msg),
      summary:i%97===0?'蓝宝石戒指和艾琳的约定':'城堡与森林的普通探索',
      delta:{items:[],scenes:[],characters:[],plans:[]}};
  }
  const ctx={chat,chatMetadata:{story_memory_v1:memory},getCurrentChatId:()=> 'benchmark-'+count};
  const start=performance.now(),index=searchIndex(ctx,memory),indexed=performance.now();
  const hits=selectHistory(ctx,memory,'记得那枚蓝宝石戒指吗',[],5),found=performance.now();
  const detail=historyEvidence(ctx,memory,hits,'蓝宝石戒指',3),expanded=performance.now();
  const last=performance.now();
  for(let j=0;j<12;j++)selectHistory(ctx,memory,'蓝宝石戒指',[],5);
  const avg=(performance.now()-last)/12;
  console.log(JSON.stringify({floors:count,indexMs:Math.round(indexed-start),searchMs:Math.round((found-indexed)*100)/100,
    sourceMs:Math.round((expanded-found)*100)/100,cachedSearchMs:Math.round(avg*100)/100,
    hits:hits.length,sources:detail.length,heapMB:Math.round(process.memoryUsage().heapUsed/1048576)}));
}
