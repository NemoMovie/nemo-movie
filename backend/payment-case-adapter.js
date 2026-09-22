import { membershipLedger,replayMembership } from './premium-ledger.js';
import { randomInt } from 'node:crypto';
import { createPremiumService, PLANS, PremiumError, id } from './premium-service.js';
const DAY=86400000;
class CompletionReviewError extends Error {}
const fail=(message,status=409)=>{throw new PremiumError(message,status);};
function text(v){if(typeof v!=='string'||!v.trim()||v.trim().length>150||/[\x00-\x1f]/.test(v))fail('Invalid verification text',400);return v.trim();}
function iso(v){if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)fail('Invalid verification time',400);return v;}

// Internal only. Caller must derive adminIdentity from authenticated server context.
// No route, secret loading, database opening or membership calculation lives here.
export function createPaymentCaseAdapter(db,{clock=()=>Date.now(),random=randomInt,hooks=null}={}) {
 db.pragma('foreign_keys = ON');
 const get=caseId=>{const c=db.prepare('SELECT * FROM payment_cases WHERE id=?').get(caseId);if(!c)fail('Payment case not found',404);return c;};
 const verification=caseId=>db.prepare('SELECT * FROM payment_case_verifications WHERE case_id=?').get(caseId);
 function checkInput(data,manual=false){
  const keys=['transaction_reference','payment_at','plan','amount_mmk','payment_method'];
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!keys.includes(k))||keys.filter(k=>k!=='transaction_reference'||!manual).some(k=>!Object.hasOwn(data,k)))fail('Invalid verification fields',400);
  const reference=manual&&data.transaction_reference===undefined?null:text(data.transaction_reference);
  if(reference!==null&&reference.length<5)fail('Full reference must not be last-four',400);
  return {...data,transaction_reference:reference,payment_at:iso(data.payment_at)};
 }
 function matches(c,data){
  if(!Object.hasOwn(PLANS,c.plan)||PLANS[c.plan][0]!==c.plan_days||PLANS[c.plan][1]!==c.amount_mmk||data.plan!==c.plan||data.amount_mmk!==c.amount_mmk||data.payment_method!==c.payment_method)fail('Verified purchase does not match case');
 }
 const verify=db.transaction((caseId,data,admin)=>{
  const c=get(caseId);matches(c,data);
  if(['CONFIRMED','COMPLETED'].includes(c.status)){
   const v=verification(caseId);
   if(!v||v.transaction_reference!==data.transaction_reference||v.payment_at!==data.payment_at)fail('Verification cannot be changed');
   if(c.status==='CONFIRMED')hooks?.confirmed(c);return;
  }
  if(c.status!=='WAITING_VERIFICATION')fail('Case is not awaiting verification');
  const latest=db.prepare('SELECT * FROM payment_cases_latest WHERE id=?').get(caseId);
  if(!latest.latest_proof_submission_id||!latest.transaction_last_four||!c.submitted_at)fail('Complete evidence required');
  const now=iso(new Date(clock()).toISOString());
  if(data.payment_at>now||c.updated_at>now)fail('Verification time is invalid');
  if(db.prepare("SELECT 1 FROM payments WHERE status='CONFIRMED' AND payment_method=? AND transaction_reference=?").get(c.payment_method,data.transaction_reference)||db.prepare('SELECT 1 FROM payment_case_verifications WHERE payment_method=? AND transaction_reference=?').get(c.payment_method,data.transaction_reference))fail('Transaction reference already verified');
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let code;
  for(let attempt=0;attempt<100;attempt++){
   let candidate='NM-';for(let n=0;n<6;n++)candidate+=alphabet[random(alphabet.length)];
   if(!db.prepare('SELECT 1 FROM payments WHERE payment_request_code=?').get(candidate)&&!db.prepare('SELECT 1 FROM payment_case_verifications WHERE internal_request_code=?').get(candidate)){code=candidate;break;}
  }
  if(!code)fail('Internal payment allocation unavailable',503);
  db.prepare('INSERT INTO payment_case_verifications(case_id,transaction_reference,payment_method,payment_at,confirmed_at,admin_identifier,internal_request_code) VALUES(?,?,?,?,?,?,?)').run(caseId,data.transaction_reference,c.payment_method,data.payment_at,now,admin,code);
  db.prepare("UPDATE payment_cases SET status='CONFIRMED',confirmed_at=?,confirmed_by=?,updated_at=? WHERE id=?").run(now,admin,now,caseId);
  hooks?.confirmed(get(caseId));
 });
 const complete=db.transaction(caseId=>{
  const c=get(caseId);const v=verification(caseId);
  if(!v)fail('Durable verification missing');
  if(c.status==='COMPLETED')return {case_id:caseId,status:c.status,payment_id:c.payment_id};
  if(c.status!=='CONFIRMED')fail('Case is not confirmed');
  hooks?.confirmed(c);
  const existing=db.prepare('SELECT * FROM payments WHERE payment_request_code=?').get(v.internal_request_code);
  if(existing){
   const expected={telegram_user_id:c.telegram_user_id,plan:c.plan,plan_days:c.plan_days,amount_mmk:c.amount_mmk,payment_method:c.payment_method,transaction_reference:v.transaction_reference,payment_at:v.payment_at,confirmed_at:v.confirmed_at,confirmed_by:v.admin_identifier,status:'CONFIRMED'};
   if(Object.entries(expected).some(([key,value])=>existing[key]!==value))throw new CompletionReviewError();
   const events=membershipLedger(db,c.telegram_user_id),effect=events.find(e=>e.payment_id===existing.id),state=replayMembership(events),stored=db.prepare('SELECT * FROM premium_memberships WHERE telegram_user_id=?').get(c.telegram_user_id);
   if(!effect||effect.effective_at!==v.confirmed_at||!state||!stored||state.start_at!==stored.start_at||state.expires_at!==stored.expires_at)throw new CompletionReviewError();
   const at=iso(new Date(clock()).toISOString());
   db.prepare("UPDATE payment_cases SET status='COMPLETED',payment_id=?,completed_at=?,updated_at=? WHERE id=?").run(existing.id,at,at,caseId);
   hooks?.completed(get(caseId));return {case_id:caseId,status:'COMPLETED',payment_id:existing.id};
  }
  // Never append a backdated grant after later ledger activity. Such a delayed
  // case requires explicit reconciliation, not an invented historical baseline.
  if(db.prepare('SELECT 1 FROM premium_membership_effects WHERE telegram_user_id=? AND (effective_at>? OR created_at>?)').get(c.telegram_user_id,v.confirmed_at,v.confirmed_at))throw new CompletionReviewError();
  // Use the durable confirmation instant even on a later retry. The existing
  // engine owns all activation/renewal, replay, audit and duplicate-reference logic.
  const expires=iso(new Date(Date.parse(v.confirmed_at)+DAY).toISOString());
  const result=db.prepare(`INSERT INTO payments(telegram_user_id,payment_request_code,payment_method,amount_mmk,plan,plan_days,status,created_at,request_expires_at) VALUES(?,?,?,?,?,?,'PENDING',?,?)`).run(c.telegram_user_id,v.internal_request_code,c.payment_method,c.amount_mmk,c.plan,c.plan_days,v.confirmed_at,expires);
  const paymentId=Number(result.lastInsertRowid);
  const premium=createPremiumService(db,{clock:()=>Date.parse(v.confirmed_at)});
  if(v.transaction_reference===null)premium.confirmVerifiedCase(paymentId,caseId,v.payment_at,v.admin_identifier);
  else premium.confirm(paymentId,{transaction_reference:v.transaction_reference,payment_at:v.payment_at},v.admin_identifier);
  const now=iso(new Date(clock()).toISOString());
  db.prepare("UPDATE payment_cases SET status='COMPLETED',payment_id=?,completed_at=?,updated_at=? WHERE id=?").run(paymentId,now,now,caseId);
  hooks?.completed(get(caseId));
  return {case_id:caseId,status:'COMPLETED',payment_id:paymentId};
 });
 function attemptCompletion(caseId){
  try{return complete.immediate(caseId);}catch(error){
   const review=error instanceof CompletionReviewError;
   hooks?.failed(get(caseId),review?'MANUAL_RECONCILIATION_REQUIRED':'COMPLETION_FAILED');
   return {case_id:caseId,status:'CONFIRMED',completion_pending:true,
    completion_error:review?'MANUAL_RECONCILIATION_REQUIRED':'COMPLETION_FAILED',
    message:review?'Later membership activity requires manual reconciliation.':'Membership completion failed; retry or Admin review required.'};
  }
 }
 return {confirmManualCase(caseId,data,adminIdentity){
  if(db.inTransaction)fail('Case confirmation requires independent transactions');
  caseId=id(caseId);verify.immediate(caseId,checkInput(data,true),text(adminIdentity));
  return attemptCompletion(caseId);
 },verifyPaymentCase(caseId,data,adminIdentity){
  if(db.inTransaction)fail('Case verification requires independent transaction');
  caseId=id(caseId);verify.immediate(caseId,checkInput(data,true),text(adminIdentity));
  return {case_id:caseId,status:get(caseId).status};
 },confirmPaymentCase(caseId,data,adminIdentity){
  if(db.inTransaction)fail('Case confirmation requires independent transactions');
  caseId=id(caseId);data=checkInput(data);const admin=text(adminIdentity);
  verify.immediate(caseId,data,admin);
  return attemptCompletion(caseId);
 },retryPaymentCase(caseId,adminIdentity){
  if(db.inTransaction)fail('Case retry requires independent transactions');
  caseId=id(caseId);text(adminIdentity);
  if(!['CONFIRMED','COMPLETED'].includes(get(caseId).status))fail('Only confirmed cases can retry activation');
  return attemptCompletion(caseId);
 }};
}
