import { completionEnabled,createCaseNotifications } from './payment-case-notifications.js';
import { PremiumError, id } from './premium-service.js';
import { createPaymentCaseAdapter } from './payment-case-adapter.js';
const STATES=['WAITING_PAYMENT','WAITING_VERIFICATION','NEEDS_CUSTOMER_ACTION','CONFIRMED','COMPLETED','REJECTED','CANCELLED','EXPIRED'];
const REASONS=['PAYMENT_NOT_FOUND','INCORRECT_PAYMENT_DETAILS','PAYMENT_PROOF_ALREADY_USED','INCORRECT_AMOUNT','INVALID_OR_UNCLEAR_PROOF','OTHER'];
const fail=(message,status=400)=>{throw new PremiumError(message,status);};
function body(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('Invalid request fields');}
function text(v,max=500){if(typeof v!=='string'||!v.trim()||v.trim().length>max||/[\x00-\x1f]/.test(v))fail('Invalid message or identity');return v.trim();}
const fields='c.id,c.telegram_user_id,u.username,u.first_name,u.last_name,c.plan,c.plan_days,c.amount_mmk,c.payment_method,c.status,c.created_at,c.updated_at,c.submitted_at,c.confirmed_at,c.completed_at,c.rejected_at,c.payment_id';
const flags=c=>({...c,activation_pending:c.status==='CONFIRMED'});
export function createPaymentCaseAdminService(db,{clock=()=>Date.now()}={}){
 function ready(){
  for(const name of ['payment_cases','payment_cases_latest','payment_case_submissions','payment_case_verifications','payment_case_admin_actions'])if(!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name))fail('Payment Case administration is not configured',503);
 }
 const load=caseId=>{const c=db.prepare('SELECT * FROM payment_cases WHERE id=?').get(id(caseId));if(!c)fail('Payment case not found',404);return c;};
 const detail=db.transaction(caseId=>{
  load(caseId);
  const c=db.prepare(`SELECT ${fields},c.payment_account_reference,c.confirmed_by,c.rejected_by,c.rejection_reason FROM payment_cases c JOIN telegram_users u USING(telegram_user_id) WHERE c.id=?`).get(caseId);
  const latest=db.prepare('SELECT transaction_last_four,latest_proof_submission_id FROM payment_cases_latest WHERE id=?').get(caseId);
  // Browser gets opaque evidence row IDs, never Telegram storage/file identifiers.
  const evidence=db.prepare('SELECT id,transaction_last_four,created_at,proof_file_id IS NOT NULL AS has_proof FROM payment_case_submissions WHERE case_id=? ORDER BY created_at,id').all(caseId).map(e=>({...e,has_proof:!!e.has_proof}));
  const verification=db.prepare('SELECT transaction_reference,payment_method,payment_at,confirmed_at,admin_identifier FROM payment_case_verifications WHERE case_id=?').get(caseId)??null;
  const actions=db.prepare('SELECT id,action,message,reason_category,admin_identifier,created_at FROM payment_case_admin_actions WHERE case_id=? ORDER BY created_at,id').all(caseId);
  const membership=db.prepare('SELECT start_at,expires_at FROM premium_memberships WHERE telegram_user_id=?').get(c.telegram_user_id)??null;
  const payment=c.payment_id===null?null:db.prepare('SELECT id,status,amount_mmk,plan,plan_days,payment_method,payment_at,confirmed_at FROM payments WHERE id=?').get(c.payment_id)??null;
  const possible_duplicate_cases=db.prepare(`SELECT DISTINCT other.case_id AS id,c.status FROM payment_case_submissions own JOIN payment_case_submissions other ON other.case_id<>own.case_id AND ((own.proof_file_unique_id IS NOT NULL AND own.proof_file_unique_id=other.proof_file_unique_id) OR (own.proof_file_id IS NOT NULL AND own.proof_file_id=other.proof_file_id) OR (own.proof_chat_id IS NOT NULL AND own.proof_chat_id=other.proof_chat_id AND own.proof_message_id=other.proof_message_id)) JOIN payment_cases c ON c.id=other.case_id WHERE own.case_id=? ORDER BY other.case_id`).all(caseId);
  const activation_attempts=completionEnabled(db)?db.prepare('SELECT id,outcome,admin_identifier,created_at FROM payment_case_activation_attempts WHERE case_id=? ORDER BY id').all(caseId):[];
  return {...flags(c),activation_attempts,...latest,evidence,verification,actions,membership,payment,possible_duplicate_cases};
 });
 const transition=db.transaction((caseId,input,admin,action)=>{
  const c=load(caseId);const now=new Date(clock()).toISOString();
  const stage3=completionEnabled(db);
  const message=text(stage3&&action==='REJECT'&&input.reason_category!=='OTHER'&&(input.message===undefined||input.message==='')?input.reason_category:input.message);admin=text(admin,150);
  if(stage3&&action==='REJECT'&&c.status==='REJECTED'){
   const original=db.prepare("SELECT * FROM payment_case_admin_actions WHERE case_id=? AND action='REJECT' ORDER BY id LIMIT 1").get(c.id);
   if(!original||original.reason_category!==input.reason_category||original.message!==message)fail('Rejection cannot be changed',409);
   return detail(c.id);
  }
  let status,category=null;
  if(action==='RETURN_TO_VERIFICATION'){
   if(c.status!=='NEEDS_CUSTOMER_ACTION')fail('Case must need customer action',409);
   const latest=db.prepare('SELECT * FROM payment_cases_latest WHERE id=?').get(c.id);
   if(!latest.latest_proof_submission_id||!latest.transaction_last_four)fail('Complete evidence required',409);status='WAITING_VERIFICATION';
  }else{
   if(c.status!=='WAITING_VERIFICATION')fail('Only cases awaiting verification can be rejected',409);
   if(!REASONS.includes(input.reason_category))fail('Invalid rejection category');category=input.reason_category;status='REJECTED';
  }
  db.prepare('INSERT INTO payment_case_admin_actions(case_id,action,message,reason_category,admin_identifier,created_at) VALUES(?,?,?,?,?,?)').run(c.id,action,message,category,admin,now);
  if(status==='REJECTED')db.prepare("UPDATE payment_cases SET status='REJECTED',rejected_at=?,rejected_by=?,rejection_reason=?,updated_at=? WHERE id=?").run(now,admin,message,now,c.id);
  else if(status==='WAITING_VERIFICATION')db.prepare("UPDATE payment_cases SET status='WAITING_VERIFICATION',submitted_at=?,updated_at=? WHERE id=?").run(now,now,c.id);
  else db.prepare('UPDATE payment_cases SET status=?,updated_at=? WHERE id=?').run(status,now,c.id);
  if(stage3&&status==='REJECTED')createCaseNotifications(db,{clock}).rejected(load(c.id),category,message);
  return detail(c.id);
 });
 function adapter(admin){
  if(!completionEnabled(db))return createPaymentCaseAdapter(db,{clock});
  const notifications=createCaseNotifications(db,{clock});
  return createPaymentCaseAdapter(db,{clock,hooks:{confirmed:notifications.confirmed,completed:c=>{notifications.completed(c);notifications.attempt(c,admin,'COMPLETED');},failed:(c,outcome)=>notifications.attempt(c,admin,outcome)}});
 }
 function result(caseId,operation){return {...detail(caseId),...(operation.completion_pending?{completion_pending:true,completion_error:operation.completion_error,message:operation.message}:{})};}
 return {
  list(q={}){
   ready();body(q,['page','limit','status','search','sort']);for(const value of Object.values(q))if(typeof value!=='string')fail('Invalid query');
   const page=q.page===undefined?1:id(q.page),limit=q.limit===undefined?24:id(q.limit),offset=(page-1)*limit;
   if(limit>100||!Number.isSafeInteger(offset))fail('Invalid pagination');
   if(q.status!==undefined&&!STATES.includes(q.status)&&!['OPEN','ALL'].includes(q.status))fail('Invalid case status');
   const sort=q.sort??'newest';if(!['newest','oldest'].includes(sort))fail('Invalid sort');
   const search=(q.search??'').trim();if(search.length>150)fail('Search too long');
   const pattern='%'+search.replace(/[!%_]/g,'!$&')+'%';
   // OPEN/ALL are list filters only, never persisted case states.
   const statuses=q.status==='OPEN'?['WAITING_PAYMENT','WAITING_VERIFICATION','CONFIRMED']:q.status&&q.status!=='ALL'?[q.status]:[];
   const where=`WHERE (CAST(c.telegram_user_id AS TEXT) LIKE ? ESCAPE '!' OR u.username LIKE ? ESCAPE '!')${statuses.length?` AND c.status IN (${statuses.map(()=>'?').join(',')})`:''}`;
   const args=[pattern,pattern,...statuses];
   return db.transaction(()=>{
    const from='FROM payment_cases c JOIN telegram_users u USING(telegram_user_id)';
    const total=db.prepare(`SELECT count(*) n ${from} ${where}`).get(...args).n;
    return {cases:db.prepare(`SELECT ${fields} ${from} ${where} ORDER BY c.id ${sort==='newest'?'DESC':'ASC'} LIMIT ? OFFSET ?`).all(...args,limit,offset).map(flags),total,page,limit,totalPages:Math.ceil(total/limit)};
   })();
  },
  details(caseId){ready();return detail(id(caseId));},
  needsCustomerAction(){fail('Need More Information workflow is retired; use conversation',410);},
  returnToVerification(caseId,input,admin){ready();body(input,['message']);return transition.immediate(id(caseId),input,admin,'RETURN_TO_VERIFICATION');},
  reject(caseId,input,admin){ready();body(input,['message','reason_category']);return transition.immediate(id(caseId),input,admin,'REJECT');},
  confirm(caseId,input,admin){ready();if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_cases_one_open'").get())fail('Workflow migration required',503);caseId=id(caseId);if(completionEnabled(db)){body(input,['payment_at','plan','amount_mmk','payment_method']);return result(caseId,adapter(text(admin,150)).confirmManualCase(caseId,input,admin));}return result(caseId,adapter(admin).verifyPaymentCase(caseId,input,admin));},
  retry(caseId,input,admin){ready();body(input,[]);caseId=id(caseId);if(load(caseId).status!=='CONFIRMED')fail('Only confirmed cases can activate',409);return result(caseId,adapter(text(admin,150)).retryPaymentCase(caseId,admin));}
 };
}
