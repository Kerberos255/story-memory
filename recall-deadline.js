// Pre-generation semantic recall has a strict wall-clock budget.
// Slow or uncooperative providers cannot indefinitely block roleplay.
export async function recallWithDeadline(run,timeoutMs=2500){
  const controller=new AbortController();
  const delay=Number.isFinite(timeoutMs)&&timeoutMs>=0?timeoutMs:2500;
  let timer=null;
  try{
    const result=await Promise.race([
      Promise.resolve().then(()=>run(controller.signal)),
      new Promise(resolve=>{
        timer=setTimeout(()=>{controller.abort();resolve([]);},delay);
      })
    ]);
    return Array.isArray(result)?result:[];
  }catch{
    return [];
  }finally{
    if(timer!==null)clearTimeout(timer);
    controller.abort();
  }
}
