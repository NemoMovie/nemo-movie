'use strict';
function createClient({baseUrl,secret,fetchImpl=fetch}){
 const url=new URL(baseUrl);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Invalid backend configuration');
 if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('HTTPS required');
 if(typeof secret!=='string'||!secret.trim())throw new Error('Missing backend configuration');
 return async(path,body)=>{
  if(!/^\/(users(?:\/[1-9]\d*\/status)?|plans(?:\/[A-Z0-9_]+)?|cases|deliveries\/(?:claim|[1-9]\d*\/(?:sent|failed))|flow\/(?:state|select|method|cancel|message))$/.test(path))throw new Error('Invalid operation');
  const r=await fetchImpl(url.origin+'/api/internal/payment-bot'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!r.ok){const error=new Error('Payment API request failed');error.status=r.status;throw error;}return r.json();
 };
}
module.exports={createClient};
