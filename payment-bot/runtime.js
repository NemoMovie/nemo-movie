'use strict';
const {createFlow}=require('./flow');
const {createDeliveryWorker}=require('./delivery-worker');
function createRuntime({api,telegram,transport=telegram,log=()=>{},intervalMs=2000}){
 if(!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>60000)throw new Error('Invalid polling interval');
 const flow=createFlow({api,send:telegram.sendFlow}),worker=createDeliveryWorker({api,transport});
 let offset=0,started=false,stopping=false,stopPromise,pollBusy=false,deliveryBusy=false,tasks=[];
 const controller=new AbortController(),wake=new Set();
 const pause=()=>new Promise(resolve=>{const done=()=>{clearTimeout(timer);wake.delete(done);resolve();};const timer=setTimeout(done,intervalMs);wake.add(done);});
 async function processUpdates(){
  if(stopping||pollBusy)return;pollBusy=true;
  try{
   const updates=await telegram.getUpdates(offset,controller.signal);
   for(const update of [...updates].sort((a,b)=>a.update_id-b.update_id)){
    if(stopping)break;if(update.update_id<offset)continue;
    const query=update.callback_query;
    if(query){try{await telegram.answerCallbackQuery(query.id);}catch{log('Payment Bot callback acknowledgement failed.');}}
    if(await flow.handle(update)===false)break;
    offset=update.update_id+1;
   }
  }catch{if(!stopping)log('Payment Bot polling iteration failed.');}finally{pollBusy=false;}
 }
 async function processDelivery(){if(stopping||deliveryBusy)return;deliveryBusy=true;try{const result=await worker.processOne();if(result.status!=='IDLE')log('Payment Bot delivery iteration: '+result.status);}catch{log('Payment Bot delivery iteration failed.');}finally{deliveryBusy=false;}}
 async function loop(fn){while(!stopping){await fn();if(!stopping)await pause();}}
 return {
  processUpdates,processDelivery,get offset(){return offset;},
  start(){if(started||stopping)throw new Error('Payment Bot runtime already started or stopped');started=true;log('Payment Bot started.');tasks=[loop(processUpdates),loop(processDelivery)];},
  stop(){if(stopPromise)return stopPromise;stopping=true;log('Payment Bot shutdown started.');controller.abort();for(const done of [...wake])done();stopPromise=Promise.allSettled(tasks).then(()=>{log('Payment Bot shutdown completed.');});return stopPromise;},
  installSignals(source=process){const handler=()=>{void this.stop();};source.on('SIGINT',handler);source.on('SIGTERM',handler);return ()=>{source.removeListener('SIGINT',handler);source.removeListener('SIGTERM',handler);};}
 };
}
module.exports={createRuntime};
