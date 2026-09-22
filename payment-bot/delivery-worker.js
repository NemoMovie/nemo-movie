'use strict';
// No polling or real Telegram implementation. A caller must inject a transport.
function createDeliveryWorker({api,transport}){
 if(typeof api!=='function'||typeof transport?.sendMessage!=='function')throw new Error('Delivery dependencies required');
 async function processOne(){
  let d;try{d=(await api('/deliveries/claim',{})).delivery;}catch{return {status:'API_UNAVAILABLE'};}
  if(d===null)return {status:'IDLE'};
  if(!d||!Number.isSafeInteger(d.message_id)||d.message_id<=0||!Number.isSafeInteger(d.telegram_user_id)||d.telegram_user_id<=0||typeof d.text!=='string'||!d.text||d.text.length>4096||! /^[a-f0-9]{64}$/.test(d.claim_token)||!Array.isArray(d.actions)||d.actions.length>1||d.actions.some(a=>typeof a.text!=='string'||!/^plans:[1-9]\d*$/.test(a.callback_data)))return {status:'INVALID_DELIVERY'};
  try{await transport.sendMessage({telegramUserId:d.telegram_user_id,text:d.text,actions:d.actions});}
  catch{
   try{await api('/deliveries/'+d.message_id+'/failed',{claim_token:d.claim_token});return {status:'FAILED'};}catch{return {status:'ACK_UNCERTAIN'};}
  }
  // A lost acknowledgement is not a transport failure. Never send again here.
  try{await api('/deliveries/'+d.message_id+'/sent',{claim_token:d.claim_token});return {status:'SENT'};}catch{return {status:'ACK_UNCERTAIN'};}
 }
 async function processBatch(limit=10){if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new Error('Invalid batch size');const results=[];for(let i=0;i<limit;i++){const r=await processOne();results.push(r);if(['IDLE','API_UNAVAILABLE','ACK_UNCERTAIN','INVALID_DELIVERY'].includes(r.status))break;}return results;}
 return {processOne,processBatch};
}
module.exports={createDeliveryWorker};
