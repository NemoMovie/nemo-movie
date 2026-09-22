import { PremiumError,id } from './premium-service.js';
const fail=(message,status=400)=>{throw new PremiumError(message,status);};
function fields(input,allowed){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))fail('Invalid conversation fields');}
function text(value,max=4096){if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))fail('Invalid conversation text');return value.trim();}
function file(value){if(typeof value!=='string'||! /^[A-Za-z0-9_-]{1,512}$/.test(value))fail('Invalid photo reference');return value;}
const projection=`m.id,m.payment_case_id,m.sender_type,m.message_type,m.text_content,m.admin_identifier,m.initial_delivery_state,m.created_at,m.telegram_file_id IS NOT NULL AS has_photo,l.evidence_id`;
export function createPaymentCaseConversationService(db,{clock=()=>Date.now()}={}){
 db.pragma('foreign_keys = ON');
 const now=()=>new Date(clock()).toISOString();
 const load=caseId=>{const c=db.prepare('SELECT id,telegram_user_id,status FROM payment_cases WHERE id=?').get(id(caseId));if(!c)fail('Payment case not found',404);return c;};
 const internal=(caseId,messageId)=>{const m=db.prepare('SELECT * FROM payment_case_messages WHERE payment_case_id=? AND id=?').get(id(caseId),id(messageId));if(!m)fail('Conversation message not found',404);return m;};
 const delivery=m=>{if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_case_deliveries'").get()){
  const d=db.prepare('SELECT state AS delivery_state,attempt_count,attempted_at,sent_at,error_category FROM payment_case_deliveries WHERE message_id=?').get(m.id);if(d)return {...m,...d};
 }if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_case_notifications'").get())return m;const n=db.prepare('SELECT delivery_state FROM payment_case_notifications WHERE message_id=?').get(m.id);return n?{...m,delivery_state:n.delivery_state}:m;};
 const dto=(caseId,messageId)=>{const m=db.prepare(`SELECT ${projection} FROM payment_case_messages m LEFT JOIN payment_case_message_evidence l ON l.message_id=m.id WHERE m.payment_case_id=? AND m.id=?`).get(caseId,messageId);return delivery({...m,has_photo:!!m.has_photo});};
 function link(caseId,messageId,evidenceId){internal(caseId,messageId);db.prepare('INSERT INTO payment_case_message_evidence(message_id,evidence_id,created_at) VALUES(?,?,?)').run(messageId,id(evidenceId),now());}
 const append=db.transaction((caseId,input,sender,actor)=>{
  const c=load(caseId);if(sender!=='SYSTEM'&&['COMPLETED','REJECTED','CANCELLED','EXPIRED'].includes(c.status))fail('Payment case conversation is closed',409);
  let content=null,chat=null,message=null,photo=null,unique=null,admin=null,type;
  if(sender==='CUSTOMER'){
   fields(actor,['telegramUserId']);if(id(actor.telegramUserId)!==c.telegram_user_id)fail('Customer does not match payment case',403);
   fields(input,['message_type','text','telegram_chat_id','telegram_message_id','telegram_file_id','telegram_file_unique_id','evidence_id']);type=input.message_type;
   if(!['TEXT','PHOTO'].includes(type))fail('Unsupported customer message type');
   if(typeof input.telegram_chat_id!=='string'||! /^-?[1-9]\d*$/.test(input.telegram_chat_id)||!Number.isSafeInteger(Number(input.telegram_chat_id)))fail('Invalid Telegram chat reference');
   chat=input.telegram_chat_id;message=id(input.telegram_message_id);
   if(type==='TEXT'){
    if(input.telegram_file_id!==undefined||input.telegram_file_unique_id!==undefined||input.evidence_id!==undefined)fail('TEXT cannot contain photo references');content=text(input.text);
   }else{photo=file(input.telegram_file_id);unique=input.telegram_file_unique_id===undefined?null:file(input.telegram_file_unique_id);content=input.text===undefined?null:text(input.text);}
  }else{
   fields(input,['text']);content=text(input.text);type=sender==='ADMIN'?'TEXT':'SYSTEM';
   if(sender==='ADMIN'){fields(actor,['adminIdentifier']);admin=text(actor.adminIdentifier,150);}
  }
  const result=db.prepare(`INSERT INTO payment_case_messages(payment_case_id,telegram_user_id,sender_type,message_type,text_content,telegram_chat_id,telegram_message_id,telegram_file_id,telegram_file_unique_id,admin_identifier,initial_delivery_state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.id,c.telegram_user_id,sender,type,content,chat,message,photo,unique,admin,sender==='ADMIN'?'PENDING_SEND':'NOT_APPLICABLE',now());
  const messageId=Number(result.lastInsertRowid);if(input.evidence_id!==undefined)link(c.id,messageId,input.evidence_id);
  return dto(c.id,messageId);
 });
 return {
  // Contexts must be supplied by a trusted authenticated integration, not copied
  // from arbitrary client input. These methods are not an authorization boundary.
  appendCustomerMessage:(caseId,input,telegramContext)=>append.immediate(id(caseId),input,'CUSTOMER',telegramContext),
  prepareAdminMessage:(caseId,input,adminContext)=>append.immediate(id(caseId),input,'ADMIN',adminContext),
  appendSystemMessage:(caseId,input)=>append.immediate(id(caseId),input,'SYSTEM',null),
  linkEvidence:db.transaction((caseId,messageId,evidenceId)=>{caseId=id(caseId);messageId=id(messageId);link(caseId,messageId,evidenceId);return dto(caseId,messageId);}).immediate,
  getInternalMessage(caseId,messageId){load(caseId);return internal(caseId,messageId);},
  listMessages(caseId,options={}){
   fields(options,['limit','after_id']);caseId=id(caseId);const limit=options.limit===undefined?50:id(options.limit);if(limit>100)fail('Invalid message limit');
   return db.transaction(()=>{
    load(caseId);const cursor=options.after_id===undefined?null:internal(caseId,options.after_id);
    const args=[caseId,...(cursor?[cursor.created_at,cursor.created_at,cursor.id]:[]),limit+1];
    const rows=db.prepare(`SELECT ${projection} FROM payment_case_messages m LEFT JOIN payment_case_message_evidence l ON l.message_id=m.id WHERE m.payment_case_id=? ${cursor?'AND (m.created_at>? OR (m.created_at=? AND m.id>?))':''} ORDER BY m.created_at,m.id LIMIT ?`).all(...args);
    const more=rows.length>limit;const messages=rows.slice(0,limit).map(m=>delivery({...m,has_photo:!!m.has_photo}));return {messages,next_after_id:more?messages.at(-1).id:null};
   })();
  }
 };
}
