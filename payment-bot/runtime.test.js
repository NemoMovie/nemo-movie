'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes}=require('node:crypto'),{EventEmitter}=require('node:events');
const {createTelegramTransport}=require('./telegram-transport');const {createRuntime}=require('./runtime');const {configure}=require('./bot');const {createDeliveryWorker}=require('./delivery-worker');
const ephemeral=()=>randomBytes(24).toString('hex');
const ok=result=>({ok:true,status:200,json:async()=>({ok:true,result})});
test('explicit real config fails closed; development import/config requires no token or network',()=>{
 assert.equal(typeof require('./bot').start,'function');
 assert.throws(()=>configure({env:{PAYMENT_BOT_MODE:'real'}}),/PAYMENT_BOT_TOKEN/);
 assert.throws(()=>configure({env:{PAYMENT_BOT_MODE:'real',PAYMENT_BOT_TOKEN:ephemeral()}}),/PAYMENT_BOT_API_SECRET/);
 assert.throws(()=>configure({env:{PAYMENT_BOT_MODE:'real',PAYMENT_BOT_TOKEN:ephemeral(),PAYMENT_BOT_API_SECRET:ephemeral()}}),/PAYMENT_BOT_BACKEND_URL/);
 assert.throws(()=>configure({env:{PAYMENT_BOT_MODE:'bad'}}),/PAYMENT_BOT_MODE/);
 assert.throws(()=>configure({env:{}}),/injected synthetic/);
 const runtime=configure({env:{},api:async()=>({delivery:null}),fetchImpl:()=>{throw new Error('Network forbidden');}});assert.equal(runtime.offset,0);
});
test('real adapter request shape, keyboard allowlist, plain text and callback acknowledgement',async()=>{
 const token=ephemeral(),calls=[];const telegram=createTelegramTransport({token,fetchImpl:async(url,options)=>{calls.push({url,options});return ok(url.endsWith('answerCallbackQuery')?true:{message_id:1});}});
 await telegram.sendMessage({telegramUserId:101,text:'<b>Plain text</b>',actions:[{text:'Retry',callback_data:'plans:7'}]});
 const req=calls[0];assert.equal(req.url,'https://api.telegram.org/bot'+token+'/sendMessage');assert.equal(req.options.redirect,'error');assert.deepEqual(JSON.parse(req.options.body),{chat_id:101,text:'<b>Plain text</b>',reply_markup:{inline_keyboard:[[{text:'Retry',callback_data:'plans:7'}]]}});assert(!req.options.body.includes(token));assert(!req.options.headers.Authorization);
 await telegram.answerCallbackQuery('synthetic-query');assert.deepEqual(JSON.parse(calls[1].options.body),{callback_query_id:'synthetic-query'});
 await assert.rejects(telegram.sendMessage({telegramUserId:101,text:'x',actions:[{text:'bad',callback_data:'user:101:secret'}]}),/INVALID_ACTION/);
});
for(const kind of ['network','malformed','rate','recipient','reject'])test('transport sanitizes '+kind,async()=>{
 const token=ephemeral();const telegram=createTelegramTransport({token,fetchImpl:async()=>{if(kind==='network')throw new Error(token);if(kind==='malformed')return {ok:true,json:async()=>{throw new Error(token);}};return {ok:false,status:kind==='rate'?429:kind==='recipient'?403:400,json:async()=>({ok:false,error_code:kind==='rate'?429:kind==='recipient'?403:400,description:token,parameters:{retry_after:9}})};}});
 await assert.rejects(telegram.sendMessage({telegramUserId:101,text:'test'}),e=>{assert(!String(e.stack).includes(token));assert(!JSON.stringify(e).includes(token));if(kind==='rate'){assert.equal(e.category,'RATE_LIMIT');assert.equal(e.retryAfter,9);}return true;});
});
test('polling advances offsets, acknowledges callbacks and retries failed backend without discarding update',async()=>{
 const calls=[],acks=[],sends=[];let fail=true;const updates=[{update_id:5,message:{chat:{id:101,type:'private'},from:{id:101},text:'/start upgrade'}},{update_id:6,callback_query:{id:'fake-query',from:{id:101},message:{chat:{id:101,type:'private'}},data:'premium_reselect'}}];
 const telegram={getUpdates:async offset=>{calls.push(offset);return updates;},sendFlow:async(...a)=>sends.push(a),answerCallbackQuery:async id=>acks.push(id)};
 const api=async p=>{if(p==='/users'&&fail){fail=false;throw new Error('Private data');}if(p==='/flow/state')return {membership:{status:'NON_PREMIUM'},case:null};if(p==='/plans')return {plans:[{plan:'MONTH_1',amount_mmk:2000}]};return {};};
 const runtime=createRuntime({api,telegram,transport:{sendMessage:async()=>{}}});await runtime.processUpdates();assert.equal(runtime.offset,0);await runtime.processUpdates();assert.equal(runtime.offset,7);await runtime.processUpdates();assert.deepEqual(calls,[0,0,7]);assert.deepEqual(acks,['fake-query']);assert.equal(sends.at(-1)[2].inline_keyboard.length,1);
});
test('runtime loops start once; SIGTERM stops new work, aborts poll and drains in-flight delivery',async()=>{
 let release,entered;const active=new Promise(r=>entered=r),delivery=new Promise(r=>release=r);let claims=0;
 const telegram={getUpdates:(_,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve([]),{once:true})),sendFlow:async()=>{},answerCallbackQuery:async()=>{}};
 const runtime=createRuntime({telegram,transport:{sendMessage:async()=>{entered();await delivery;}},api:async p=>{if(p==='/deliveries/claim'){claims++;return {delivery:{message_id:1,telegram_user_id:101,text:'x',actions:[],claim_token:'a'.repeat(64)}};}return {state:'SENT'};}});
 const signals=new EventEmitter(),detach=runtime.installSignals(signals);runtime.start();await active;assert.throws(()=>runtime.start(),/already/);signals.emit('SIGTERM');let ended=false;const stop=runtime.stop().then(()=>ended=true);await new Promise(r=>setImmediate(r));assert.equal(ended,false);release();await stop;await runtime.processDelivery();assert.equal(claims,1);assert.throws(()=>runtime.start());detach();assert.equal(signals.listenerCount('SIGINT'),0);
});
test('outbound Stage 4 worker uses injected real adapter and acknowledges SENT or FAILED',async()=>{
 for(const success of [true,false]){const calls=[];const transport=createTelegramTransport({token:ephemeral(),fetchImpl:async()=>{if(!success)throw new Error('Sensitive network error');return ok({message_id:1});}});const api=async(p,b)=>{calls.push({p,b});return p.endsWith('/claim')?{delivery:{message_id:3,telegram_user_id:101,text:'Synthetic',actions:[],claim_token:'b'.repeat(64)}}:{state:success?'SENT':'FAILED'};};
 assert.equal((await createDeliveryWorker({api,transport}).processOne()).status,success?'SENT':'FAILED');assert.equal(calls[1].p,'/deliveries/3/'+(success?'sent':'failed'));assert.deepEqual(Object.keys(calls[1].b),['claim_token']);}
});
test('getUpdates builds bounded long polling request and validates malformed replies',async()=>{
 const bodies=[];const telegram=createTelegramTransport({token:ephemeral(),fetchImpl:async(_,o)=>{bodies.push(JSON.parse(o.body));return ok([]);}});assert.deepEqual(await telegram.getUpdates(19),[]);assert.deepEqual(bodies[0],{offset:19,limit:50,timeout:20,allowed_updates:['message','callback_query']});
 const bad=createTelegramTransport({token:ephemeral(),fetchImpl:async()=>ok([{update_id:-1}])});await assert.rejects(bad.getUpdates(0),/MALFORMED_RESPONSE/);
});
test('permanent rejected input advances; transient backend failure remains unacknowledged',async()=>{
 const {createClient}=require('./client');
 for(const status of [400,409,503]){
  const api=createClient({baseUrl:'http://127.0.0.1:3101',secret:ephemeral(),fetchImpl:async()=>({ok:false,status})});
  const telegram={getUpdates:async()=>[{update_id:12,message:{from:{id:101},chat:{id:101,type:'private'},text:'/start upgrade'}}],sendFlow:async()=>{}};
  const runtime=createRuntime({api,telegram,transport:{sendMessage:async()=>{}}});await runtime.processUpdates();assert.equal(runtime.offset,status===503?0:13);
 }
});
test('stale plan button does not poison polling; callback acknowledgement failure is contained',async()=>{
 const logs=[];const telegram={getUpdates:async()=>[{update_id:2,callback_query:{id:'synthetic',from:{id:101},message:{chat:{id:101,type:'private'}},data:'plans:99'}}],sendFlow:async()=>{},answerCallbackQuery:async()=>{throw new Error('Sensitive');}};
 const runtime=createRuntime({telegram,transport:{sendMessage:async()=>{}},log:s=>logs.push(s),api:async p=>p==='/flow/state'?{membership:{status:'NON_PREMIUM'},case:null}:{}});
 await runtime.processUpdates();assert.equal(runtime.offset,3);assert.deepEqual(logs,['Payment Bot callback acknowledgement failed.']);
});
test('SIGINT aborts idle polling; iteration failure does not disable subsequent work',async()=>{
 let polls=0;const telegram={getUpdates:async()=>{if(++polls===1)throw new Error('Private');return [];},sendFlow:async()=>{}};
 const runtime=createRuntime({telegram,transport:{sendMessage:async()=>{}},api:async()=>({delivery:null})});await runtime.processUpdates();await runtime.processUpdates();assert.equal(polls,2);
 const signals=new EventEmitter(),detach=runtime.installSignals(signals);runtime.start();signals.emit('SIGINT');await runtime.stop();detach();assert.equal(signals.listenerCount('SIGTERM'),0);
});
