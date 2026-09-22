import { randomBytes } from 'node:crypto';
import { PremiumError,id } from './premium-service.js';
export const DELIVERY_LEASE_MS=120000,DELIVERY_RETRY_MS=60000,DELIVERY_MAX_ATTEMPTS=5;
const fail=(m,status=400)=>{throw new PremiumError(m,status);};
const fields=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('Invalid delivery request');};
export function createPaymentCaseDelivery(db,{clock=()=>Date.now()}={}){
 const now=()=>new Date(clock()).toISOString();
 const ready=()=>{if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_case_deliveries'").get())fail('Delivery unavailable',503);};
 const claim=db.transaction(()=>{
  const at=now();
  // Recover crashed leases. Counts include crashed attempts; retries are bounded.
  db.prepare("UPDATE payment_case_deliveries SET state='FAILED',lease_expires_at=NULL,retry_at=?,error_category='LEASE_EXPIRED' WHERE state<>'SENT' AND lease_expires_at<=?").run(at,at);
  const row=db.prepare(`SELECT d.message_id,m.telegram_user_id,m.text_content,n.action,n.case_id
   FROM payment_case_deliveries d JOIN payment_case_messages m ON m.id=d.message_id LEFT JOIN payment_case_notifications n ON n.message_id=m.id
   WHERE d.state<>'SENT' AND d.lease_expires_at IS NULL AND d.attempt_count<? AND (d.retry_at IS NULL OR d.retry_at<=?)
   AND NOT EXISTS(SELECT 1 FROM payment_case_deliveries older JOIN payment_case_messages om ON om.id=older.message_id
     WHERE om.telegram_user_id=m.telegram_user_id AND older.state<>'SENT' AND (om.created_at<m.created_at OR om.created_at=m.created_at AND om.id<m.id))
   ORDER BY m.created_at,m.id LIMIT 1`).get(DELIVERY_MAX_ATTEMPTS,at);
  if(!row)return {delivery:null};
  const token=randomBytes(32).toString('hex'),expires=new Date(clock()+DELIVERY_LEASE_MS).toISOString();
  db.prepare('UPDATE payment_case_deliveries SET lease_token=?,lease_expires_at=?,attempt_count=attempt_count+1,attempted_at=? WHERE message_id=?').run(token,expires,at,row.message_id);
  return {delivery:{message_id:row.message_id,claim_token:token,lease_expires_at:expires,telegram_user_id:row.telegram_user_id,text:row.text_content,
   actions:row.action==='RESELECT'?[{text:'🔄 ရွေးချယ်မှု ပြန်လည်ပြုလုပ်ပါ',callback_data:'plans:'+row.case_id}]:[]}};
 });
 const ack=db.transaction((messageId,input,state)=>{
  const d=db.prepare('SELECT * FROM payment_case_deliveries WHERE message_id=?').get(messageId);if(!d)fail('Delivery not found',404);
  if(d.lease_token!==input.claim_token)fail('Stale delivery claim',409);
  if(d.state==='SENT')return {state:'SENT'};
  if(d.lease_expires_at===null){if(state==='FAILED'&&d.state==='FAILED')return {state:'FAILED'};fail('Delivery is not claimed',409);}
  const at=now();
  db.prepare('UPDATE payment_case_deliveries SET state=?,lease_expires_at=NULL,retry_at=?,sent_at=?,error_category=? WHERE message_id=?').run(state,state==='FAILED'?new Date(clock()+DELIVERY_RETRY_MS).toISOString():null,state==='SENT'?at:null,state==='FAILED'?'TRANSPORT_FAILED':null,messageId);
  return {state};
 });
 return {
  claim(input){ready();fields(input,[]);return claim.immediate();},
  acknowledge(messageId,input,state){ready();fields(input,['claim_token']);if(!['SENT','FAILED'].includes(state)||typeof input.claim_token!=='string'||!/^[a-f0-9]{64}$/.test(input.claim_token))fail('Invalid delivery acknowledgement');return ack.immediate(id(messageId),input,state);}
 };
}
