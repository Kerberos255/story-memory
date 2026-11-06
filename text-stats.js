// Host tokenizer for Token estimates, Unicode code-point count for characters.
// No third-party tokenizer or network request is introduced by this extension.
export function characterCount(text){return Array.from(String(text||'')).length;}
export async function countTokens(ctx,text){
  const value=String(text||'');
  if(!value)return {tokens:0,estimated:false};
  const fallback=()=>({tokens:Math.ceil(value.length/3),estimated:true});
  if(typeof ctx?.getTokenCountAsync!=='function')return fallback();
  let timeout;
  try{
    const count=await Promise.race([
      Promise.resolve().then(()=>ctx.getTokenCountAsync(value)),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('tokenizer timeout')),2500);})
    ]);
    return Number.isFinite(count)&&count>0?{tokens:Math.ceil(count),estimated:false}:fallback();
  }catch{return fallback();}
  finally{if(timeout!==undefined)clearTimeout(timeout);}
}
