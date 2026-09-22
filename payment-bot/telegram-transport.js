'use strict';
class TelegramTransportError extends Error {
 constructor(category,retryAfter){super('Telegram operation failed: '+category);this.category=category;if(retryAfter)this.retryAfter=retryAfter;}
}
const callback=/^(?:premium_reselect|plans:\d+|plan:(?:MONTH_[136]|YEAR_1):\d+|method:(?:MONTH_[136]|YEAR_1):(?:KBZPAY|WAVE_MONEY|AYA_PAY):\d+|(?:methods|cancel):[1-9]\d*|change:[1-9]\d*:(?:KBZPAY|WAVE_MONEY|AYA_PAY))$/;
function createTelegramTransport({token,fetchImpl=fetch}){
 if(typeof token!=='string'||!token.trim()||!/^[A-Za-z0-9_:-]+$/.test(token))throw new Error('PAYMENT_BOT_TOKEN is required or invalid');
 async function request(method,body,signal){
  let response,data;
  try{response=await fetchImpl('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000)});}
  catch{throw new TelegramTransportError('NETWORK_FAILURE');}
  try{data=await response.json();}catch{throw new TelegramTransportError('MALFORMED_RESPONSE');}
  if(!response.ok||data?.ok!==true){const code=data?.error_code??response.status;const retry=data?.parameters?.retry_after;throw new TelegramTransportError(code===429?'RATE_LIMIT':code===403?'RECIPIENT_UNAVAILABLE':'API_REJECTION',typeof retry==='number'&&Number.isInteger(retry)&&retry>0&&retry<=3600?retry:undefined);}
  return data.result;
 }
 function keyboard(rows){if(!Array.isArray(rows)||rows.length>20||rows.some(row=>!Array.isArray(row)||row.length>8||row.some(b=>typeof b.text!=='string'||!b.text||b.text.length>100||typeof b.callback_data!=='string'||Buffer.byteLength(b.callback_data)>64||!callback.test(b.callback_data))))throw new TelegramTransportError('INVALID_ACTION');return {inline_keyboard:rows.map(row=>row.map(b=>({text:b.text,callback_data:b.callback_data})))};}
 async function sendFlow(chat,text,markup){
  if(!Number.isSafeInteger(chat)||chat<=0||typeof text!=='string'||!text||text.length>4096)throw new TelegramTransportError('INVALID_MESSAGE');
  const result=await request('sendMessage',{chat_id:chat,text,...(markup?{reply_markup:keyboard(markup.inline_keyboard)}:{})});
  if(!Number.isSafeInteger(result?.message_id)||result.message_id<=0)throw new TelegramTransportError('MALFORMED_RESPONSE');return {ok:true};
 }
 return {
  sendFlow,
  sendMessage:({telegramUserId,text,actions=[]})=>sendFlow(telegramUserId,text,actions.length?{inline_keyboard:actions.map(a=>[a])}:undefined),
  async answerCallbackQuery(id){if(typeof id!=='string'||!id||id.length>200)throw new TelegramTransportError('INVALID_CALLBACK');if(await request('answerCallbackQuery',{callback_query_id:id})!==true)throw new TelegramTransportError('MALFORMED_RESPONSE');},
  async getUpdates(offset,signal){if(!Number.isSafeInteger(offset)||offset<0)throw new TelegramTransportError('INVALID_OFFSET');const result=await request('getUpdates',{offset,limit:50,timeout:20,allowed_updates:['message','callback_query']},signal);if(!Array.isArray(result)||result.some(u=>!Number.isSafeInteger(u?.update_id)||u.update_id<0||u.update_id>=Number.MAX_SAFE_INTEGER))throw new TelegramTransportError('MALFORMED_RESPONSE');return result;}
 };
}
module.exports={createTelegramTransport,TelegramTransportError};
