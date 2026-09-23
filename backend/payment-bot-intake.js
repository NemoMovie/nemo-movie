import { createHash } from 'node:crypto';
import { PLANS,createPremiumService,PremiumError,id } from './premium-service.js';
import { createPaymentCaseLifecycle } from './payment-case-lifecycle.js';
import { createPaymentCaseConversationService } from './payment-case-conversation.js';
import { resolvePaymentAccounts } from './payment-bot-accounts.js';
const fail=(text,status=400)=>{throw new PremiumError(text,status);};
const closed=['COMPLETED','REJECTED','CANCELLED','EXPIRED'];
export function createPaymentBotIntake(db,{clock=()=>Date.now(),env=process.env}={}){
 const accounts=resolvePaymentAccounts(env);
 const lifecycle=createPaymentCaseLifecycle(db,{clock}),conversation=createPaymentCaseConversationService(db,{clock}),premium=createPremiumService(db,{clock});
 const now=()=>new Date(clock()).toISOString();
 function ready(){if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_bot_operations'").get())fail('Intake migration required',503);}
 function fields(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('Invalid request');}
 function owner(c,uid){if(!c||c.telegram_user_id!==uid)fail('Case not found',404);return c;}
 const load=(cid,uid)=>owner(db.prepare('SELECT * FROM payment_cases_latest WHERE id=?').get(id(cid)),uid);
 function latest(uid){return db.prepare("SELECT * FROM payment_cases_latest WHERE telegram_user_id=? ORDER BY CASE WHEN status IN ('WAITING_PAYMENT','WAITING_VERIFICATION','CONFIRMED','NEEDS_CUSTOMER_ACTION') THEN 0 ELSE 1 END,id DESC LIMIT 1").get(uid);}
 function hasProof(c){return Boolean(c.latest_proof_submission_id||db.prepare("SELECT 1 FROM payment_case_messages WHERE payment_case_id=? AND message_type='PHOTO' LIMIT 1").get(c.id));}
 function dto(c){if(!c)return null;return {id:c.id,status:c.status,plan:c.plan,plan_days:c.plan_days,amount_mmk:c.amount_mmk,payment_method:c.payment_method,step:c.status==='WAITING_PAYMENT'?(c.latest_proof_submission_id?'WAITING_LAST_FOUR':'WAITING_SCREENSHOT'):c.status==='WAITING_VERIFICATION'?'ADMIN_REVIEW':c.status==='CONFIRMED'?'ACTIVATION_PENDING':'CLOSED',expires_at:new Date(Date.parse(c.created_at)+86400000).toISOString(),can_change_method:c.status==='WAITING_PAYMENT'&&!hasProof(c),payment_account:accounts[c.payment_method].account,payment_account_name:accounts[c.payment_method].name,instructions_live:accounts[c.payment_method].live};}
 function method(value){if(typeof value!=='string'||!Object.hasOwn(accounts,value))fail('Invalid method');return accounts[value];}
 const operation=db.transaction((kind,input)=>{
  const uid=id(input.telegram_user_id),key=input.operation_key;
  if(typeof key!=='string'||! /^[A-Za-z0-9:_-]{1,150}$/.test(key))fail('Invalid operation key');
  const fingerprint=createHash('sha256').update(JSON.stringify([kind,Object.entries(input).sort(([a],[b])=>a.localeCompare(b))])).digest('hex');
  const prior=db.prepare('SELECT * FROM payment_bot_operations WHERE telegram_user_id=? AND operation_key=?').get(uid,key);
  if(prior){if(prior.fingerprint!==fingerprint)fail('Operation mismatch',409);return {case:dto(load(prior.case_id,uid)),outcome:prior.outcome};}
  let c,outcome;
  if(kind==='select'){
   if(typeof input.plan!=='string'||!Object.hasOwn(PLANS,input.plan))fail('Invalid plan');const account=method(input.payment_method);
   const current=latest(uid),boundary=input.after_case_id;if(!Number.isSafeInteger(boundary)||boundary<0)fail('Invalid selection');
   if(current&&!closed.includes(current.status)){
    if(current.status!=='WAITING_PAYMENT'||current.plan!==input.plan||current.payment_method!==input.payment_method)fail('Existing attempt must be resumed',409);c=current;
   }else{
    if((current?.id??0)!==boundary)fail('Stale selection',409);
    const at=now(),[days,amount]=PLANS[input.plan];
    const r=db.prepare("INSERT INTO payment_cases(telegram_user_id,plan,plan_days,amount_mmk,payment_method,payment_account_reference,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(uid,input.plan,days,amount,input.payment_method,account.reference,at,at);c=load(Number(r.lastInsertRowid),uid);
   }outcome='SELECTED';
  }else{
   c=load(input.case_id,uid);
   if(kind==='cancel'){const result=lifecycle.cancel(c.id,uid);outcome=result.status;}
   else if(kind==='method'){
    const account=method(input.payment_method);if(c.status!=='WAITING_PAYMENT'||hasProof(c))fail('Method cannot change after proof or review',409);
    if(c.payment_method!==input.payment_method)db.prepare('INSERT INTO payment_case_method_changes(case_id,telegram_user_id,old_method,new_method,old_account,new_account,created_at) VALUES(?,?,?,?,?,?,?)').run(c.id,uid,c.payment_method,input.payment_method,c.payment_account_reference,account.reference,now());outcome='METHOD_CHANGED';
   }else{
    if(!['PHOTO','TEXT','OTHER'].includes(input.kind))fail('Invalid message kind');
    if(input.kind==='TEXT'&&(typeof input.text!=='string'||input.text.length>4096))fail('Invalid message text');
    if(input.kind==='PHOTO'&&[input.file_id,...(input.file_unique_id===undefined?[]:[input.file_unique_id])].some(v=>typeof v!=='string'||! /^[A-Za-z0-9_-]{1,512}$/.test(v)))fail('Invalid photo metadata');
    const messageId=id(input.message_id);if(input.chat_id!==String(uid)||key!==`msg:${uid}:${messageId}`)fail('Invalid message identity');
    if(!Number.isSafeInteger(input.message_date)||input.message_date<0)fail('Invalid message date');
    // Old unprocessed Telegram updates cannot become proof for a later purchase.
    if(input.message_date<Math.floor(Date.parse(c.created_at)/1000))fail('Message predates attempt',409);
    if(closed.includes(c.status)||c.status==='CONFIRMED')outcome='CLOSED';
    else if(c.status==='WAITING_VERIFICATION'){
     if(input.kind==='TEXT'&&typeof input.text==='string'&&!/^[0-9]{4}$/.test(input.text)){
      conversation.appendCustomerMessage(c.id,{message_type:'TEXT',text:input.text,telegram_chat_id:input.chat_id,telegram_message_id:messageId},{telegramUserId:uid});outcome='CLARIFICATION';
     }else outcome='UNDER_REVIEW';
    }else if(c.status!=='WAITING_PAYMENT')fail('Legacy case requires review',409);
    else if(input.kind==='PHOTO'){
     const evidence=db.prepare('INSERT INTO payment_case_submissions(case_id,proof_file_id,proof_file_unique_id,proof_chat_id,proof_message_id,created_at) VALUES(?,?,?,?,?,?)').run(c.id,input.file_id,input.file_unique_id??null,input.chat_id,messageId,now());
     conversation.appendCustomerMessage(c.id,{message_type:'PHOTO',telegram_file_id:input.file_id,...(input.file_unique_id===undefined?{}:{telegram_file_unique_id:input.file_unique_id}),telegram_chat_id:input.chat_id,telegram_message_id:messageId,evidence_id:Number(evidence.lastInsertRowid)},{telegramUserId:uid});outcome='PHOTO_ACCEPTED';
    }else if(!c.latest_proof_submission_id)outcome='SCREENSHOT_REQUIRED';
    else if(input.kind!=='TEXT'||typeof input.text!=='string'||!/^[0-9]{4}$/.test(input.text))outcome='INVALID_LAST_FOUR';
    else{
     const at=now();db.prepare('INSERT INTO payment_case_submissions(case_id,transaction_last_four,created_at) VALUES(?,?,?)').run(c.id,input.text,at);
     conversation.appendCustomerMessage(c.id,{message_type:'TEXT',text:input.text,telegram_chat_id:input.chat_id,telegram_message_id:messageId},{telegramUserId:uid});
     db.prepare("UPDATE payment_cases SET status='WAITING_VERIFICATION',submitted_at=?,updated_at=? WHERE id=?").run(at,at,c.id);outcome='SUBMITTED';
    }
   }
  }
  db.prepare('INSERT INTO payment_bot_operations(telegram_user_id,operation_key,fingerprint,case_id,outcome) VALUES(?,?,?,?,?)').run(uid,key,fingerprint,c.id,outcome);
  return {case:dto(load(c.id,uid)),outcome};
 });
 return {
  state(input){fields(input,['telegram_user_id']);ready();const uid=id(input.telegram_user_id);lifecycle.expire();return {membership:premium.status(uid),case:dto(latest(uid))};},
  act(kind,input){const extra={select:['plan','payment_method','after_case_id'],method:['case_id','payment_method'],cancel:['case_id'],message:['case_id','kind','text','file_id','file_unique_id','chat_id','message_id','message_date']}[kind];if(!extra)fail('Invalid operation');fields(input,['telegram_user_id','operation_key',...extra]);ready();lifecycle.expire();return operation.immediate(kind,input);}
 };
}
