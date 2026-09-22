import { id,PremiumError } from './premium-service.js';
export const OPEN_CASE_STATES=['WAITING_PAYMENT','WAITING_VERIFICATION','CONFIRMED'];
export const CLOSED_CASE_STATES=['COMPLETED','REJECTED','CANCELLED','EXPIRED'];
export function createPaymentCaseLifecycle(db,{clock=()=>Date.now()}={}){
 const now=()=>new Date(clock()).toISOString();
 const expire=db.transaction(()=>{const at=now();return db.prepare("UPDATE payment_cases SET status='EXPIRED',updated_at=? WHERE status='WAITING_PAYMENT' AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+1 day')<=?").run(at,at).changes;});
 return {
  expire:()=>expire.immediate(),
  cancel:db.transaction((caseId,userId)=>{
   const c=db.prepare('SELECT * FROM payment_cases WHERE id=? AND telegram_user_id=?').get(id(caseId),id(userId));
   if(!c)throw new PremiumError('Case not found',404);
   if(c.status==='CANCELLED')return {status:'CANCELLED'};
   if(c.status!=='WAITING_PAYMENT')throw new PremiumError('Case cannot be cancelled',409);
   const at=now();
   if(Date.parse(c.created_at)+86400000<=Date.parse(at)){db.prepare("UPDATE payment_cases SET status='EXPIRED',updated_at=? WHERE id=?").run(at,c.id);return {status:'EXPIRED'};}
   db.prepare("UPDATE payment_cases SET status='CANCELLED',updated_at=? WHERE id=?").run(at,c.id);return {status:'CANCELLED'};
  }).immediate,
  progress(caseId,userId){const c=db.prepare('SELECT * FROM payment_cases_latest WHERE id=? AND telegram_user_id=?').get(id(caseId),id(userId));if(!c)throw new PremiumError('Case not found',404);return {status:c.status,step:c.status==='WAITING_PAYMENT'?(c.latest_proof_submission_id?'WAITING_LAST_FOUR':'WAITING_SCREENSHOT'):c.status==='WAITING_VERIFICATION'?'ADMIN_REVIEW':c.status==='CONFIRMED'?'ACTIVATION_PENDING':c.status==='NEEDS_CUSTOMER_ACTION'?'LEGACY_REVIEW':'CLOSED'};}
 };
}
