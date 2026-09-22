import { migratePaymentCaseDelivery } from './payment-case-delivery-migration.js';
import { createPaymentCaseDelivery,DELIVERY_LEASE_MS,DELIVERY_RETRY_MS } from './payment-case-delivery.js';
import { createDeliveryWorker } from '../payment-bot/delivery-worker.js';
import { createFakeTransport } from '../payment-bot/fake-transport.js';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { migratePaymentCaseCompletion } from './payment-case-completion-migration.js';
import { createPaymentCaseAdapter } from './payment-case-adapter.js';
import { formatMMT } from './payment-case-notifications.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratePremium } from './premium-migration.js';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
import { migratePaymentCases } from './payment-case-migration.js';
import { migratePaymentCaseAdapter } from './payment-case-adapter-migration.js';
import { migratePaymentCaseAdmin } from './payment-case-admin-migration.js';
import { migratePaymentCaseConversation } from './payment-case-conversation-migration.js';
import { migratePaymentCaseWorkflow } from './payment-case-workflow-migration.js';
import { migratePaymentBotIntake } from './payment-bot-intake-migration.js';
import { createPaymentBotIntake } from './payment-bot-intake.js';
import { createPremiumService } from './premium-service.js';
import { createPaymentCaseAdminService } from './payment-case-admin.js';
import { createPaymentCaseConversationService } from './payment-case-conversation.js';
import { createFlow,messages } from '../payment-bot/flow.js';
function fixture(t,stage4=true){
 const db=new Database(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY)');
 for(const f of [migratePremium,migratePremiumLedgerV3,migratePaymentCases,migratePaymentCaseAdapter,migratePaymentCaseAdmin,migratePaymentCaseConversation,migratePaymentCaseWorkflow,migratePaymentBotIntake,migratePaymentCaseCompletion,migratePaymentCaseDelivery])if(stage4||f!==migratePaymentCaseDelivery)f(db);
 let time=Date.parse('2026-01-01T00:00:00.000Z'),seq=0;const clock=()=>time;
 const premium=createPremiumService(db,{clock});premium.upsertUser({telegram_user_id:101});const service=createPaymentBotIntake(db,{clock});
 const act=(kind,data={})=>service.act(kind,{telegram_user_id:101,operation_key:'cb:'+ ++seq,...data});
 const select=()=>act('select',{plan:'MONTH_1',payment_method:'KBZPAY',after_case_id:service.state({telegram_user_id:101}).case?.id??0}).case;
 const message=(c,extra={},n=++seq)=>{seq=Math.max(seq,n);return service.act('message',{telegram_user_id:101,operation_key:`msg:101:${n}`,case_id:c.id,chat_id:'101',message_id:n,message_date:Math.floor(clock()/1000),kind:'TEXT',text:'0007',...extra});};
 const photo=(c,n)=>message(c,{kind:'PHOTO',text:undefined,file_id:'fake_file_'+(n??seq),file_unique_id:'fake_unique_'+(n??seq)},n);
 return {db,clock,premium,service,act,select,message,photo,advance:ms=>time+=ms};
}

function setup(t,stage4=true){const f=fixture(t,stage4),c=f.select();f.photo(c);f.message(c);f.advance(1000);const admin=createPaymentCaseAdminService(f.db,{clock:f.clock});const input={plan:'MONTH_1',amount_mmk:2000,payment_method:'KBZPAY',payment_at:new Date(f.clock()-1000).toISOString()};return {...f,c,admin,input};}
const notifications=f=>f.db.prepare('SELECT n.*,m.text_content FROM payment_case_notifications n JOIN payment_case_messages m ON m.id=n.message_id ORDER BY m.id').all();
const member=f=>f.db.prepare('SELECT * FROM premium_memberships WHERE telegram_user_id=101').get();
const count=(f,table)=>f.db.prepare('SELECT count(*) n FROM '+table).get().n;


function worker(f,outcomes=[]){const delivery=createPaymentCaseDelivery(f.db,{clock:f.clock}),transport=createFakeTransport({outcomes});const api=async(p,b)=>{if(p==='/deliveries/claim')return delivery.claim(b);const [, ,id,action]=p.split('/');return delivery.acknowledge(id,b,action==='sent'?'SENT':'FAILED');};return {delivery,transport,worker:createDeliveryWorker({api,transport}),api};}
const states=f=>f.db.prepare('SELECT * FROM payment_case_deliveries ORDER BY message_id').all();
function adminMessage(f,c=f.c.id,text='Synthetic Admin clarification'){return createPaymentCaseConversationService(f.db,{clock:f.clock}).prepareAdminMessage(c,{text},{adminIdentifier:'Admin'});}
function other(f){f.premium.upsertUser({telegram_user_id:202});const at=new Date(f.clock()).toISOString();return Number(f.db.prepare("INSERT INTO payment_cases(telegram_user_id,plan,plan_days,amount_mmk,payment_method,payment_account_reference,created_at,updated_at) VALUES(202,'MONTH_1',30,2000,'KBZPAY','fake',?,?)").run(at,at).lastInsertRowid);}

test('ordered Stage 3 notifications delivered by fake transport; SENT terminal and duplicate ack safe',async t=>{
 const f=setup(t);f.admin.confirm(f.c.id,f.input,'Admin');const w=worker(f);
 const claim=w.delivery.claim({}).delivery;assert.equal(claim.text,notifications(f)[0].text_content);assert.deepEqual(Object.keys(claim).sort(),['message_id','claim_token','lease_expires_at','telegram_user_id','text','actions'].sort());
 assert.equal(w.delivery.claim({}).delivery,null);w.delivery.acknowledge(claim.message_id,{claim_token:claim.claim_token},'SENT');
 assert.equal(w.delivery.acknowledge(claim.message_id,{claim_token:claim.claim_token},'SENT').state,'SENT');assert.equal(w.delivery.acknowledge(claim.message_id,{claim_token:claim.claim_token},'FAILED').state,'SENT');
 assert.equal((await w.worker.processOne()).status,'SENT');assert.equal((await w.worker.processOne()).status,'IDLE');assert(states(f).every(d=>d.state==='SENT'));assert(notifications(f).every(n=>n.delivery_state==='SENT'));assert.equal(f.admin.details(f.c.id).status,'COMPLETED');
});
test('failure/backoff/retry preserves logical identity, business state and permits another customer',async t=>{
 const f=setup(t),a=adminMessage(f);adminMessage(f,other(f));const w=worker(f,['fail']);
 assert.equal((await w.worker.processOne()).status,'FAILED');assert.equal(states(f)[0].error_category,'TRANSPORT_FAILED');assert.equal((await w.worker.processOne()).status,'SENT');assert.equal((await w.worker.processOne()).status,'IDLE');
 f.advance(DELIVERY_RETRY_MS);const restarted=worker(f);assert.equal((await restarted.worker.processOne()).status,'SENT');assert.equal(states(f)[0].message_id,a.id);assert.equal(states(f)[0].attempt_count,2);assert.equal(f.admin.details(f.c.id).status,'WAITING_VERIFICATION');assert.equal(count(f,'premium_membership_effects'),0);
 const dto=createPaymentCaseConversationService(f.db).listMessages(f.c.id).messages.at(-1);assert.equal(dto.delivery_state,'SENT');assert(!/claim_token|lease_token|telegram_user_id|telegram_chat_id/.test(JSON.stringify(dto)));
});
test('crashed claims expire, stale acknowledgements refused, retries bounded',async t=>{
 const f=setup(t);adminMessage(f);const w=worker(f),a=w.delivery.claim({}).delivery;f.advance(DELIVERY_LEASE_MS);const b=w.delivery.claim({}).delivery;assert.equal(a.message_id,b.message_id);assert.notEqual(a.claim_token,b.claim_token);assert.throws(()=>w.delivery.acknowledge(a.message_id,{claim_token:a.claim_token},'SENT'));
 w.delivery.acknowledge(b.message_id,{claim_token:b.claim_token},'FAILED');
 for(let i=0;i<3;i++){f.advance(DELIVERY_RETRY_MS);const c=w.delivery.claim({}).delivery;w.delivery.acknowledge(c.message_id,{claim_token:c.claim_token},'FAILED');}
 f.advance(DELIVERY_RETRY_MS);assert.equal(w.delivery.claim({}).delivery,null);assert.equal(states(f)[0].attempt_count,5);assert.equal(states(f)[0].state,'FAILED');
});
test('lost SENT acknowledgement is uncertain and does not immediately resend or mark failed',async t=>{
 const f=setup(t);adminMessage(f);const w=worker(f);let fail=true;const api=async(p,b)=>{if(p.endsWith('/sent')&&fail){fail=false;throw new Error('Synthetic response lost');}return w.api(p,b);};
 const instance=createDeliveryWorker({api,transport:w.transport});assert.equal((await instance.processOne()).status,'ACK_UNCERTAIN');assert.equal((await instance.processOne()).status,'IDLE');assert.equal(w.transport.sent.length,1);
 f.advance(DELIVERY_LEASE_MS);assert.equal((await worker(f).worker.processOne()).status,'SENT'); // documented at-least-once boundary
});
test('two SQLite connections share claims and reopen retains delivery state',t=>{
 const f=setup(t);adminMessage(f);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nemo-delivery-'));const filename=path.join(dir,'synthetic.db');fs.writeFileSync(filename,f.db.serialize());const a=new Database(filename),b=new Database(filename);
 t.after(()=>{if(a.open)a.close();if(b.open)b.close();assert.equal(path.dirname(dir),os.tmpdir());assert(path.basename(dir).startsWith('nemo-delivery-'));fs.rmSync(dir,{recursive:true,force:true});});
 const sa=createPaymentCaseDelivery(a,{clock:f.clock}),sb=createPaymentCaseDelivery(b,{clock:f.clock});const claim=sa.claim({}).delivery;assert.equal(sb.claim({}).delivery,null);a.close();sb.acknowledge(claim.message_id,{claim_token:claim.claim_token},'SENT');b.close();const reopened=new Database(filename);try{assert.equal(createPaymentCaseDelivery(reopened,{clock:f.clock}).claim({}).delivery,null);migratePaymentCaseDelivery(reopened);}finally{reopened.close();}
});
for(const reason of ['PAYMENT_NOT_FOUND','INCORRECT_PAYMENT_DETAILS','PAYMENT_PROOF_ALREADY_USED','INCORRECT_AMOUNT','INVALID_OR_UNCLEAR_PROOF','OTHER'])test('fake rejection delivery '+reason,async t=>{
 const f=setup(t);f.admin.reject(f.c.id,{reason_category:reason,message:'Synthetic note'},'Admin');const w=worker(f);assert.equal((await w.worker.processOne()).status,'SENT');const payload=w.transport.sent[0];assert.equal(payload.actions.length,1);assert.equal(payload.actions[0].callback_data,'plans:'+f.c.id);assert(!payload.actions[0].callback_data.includes('101'));assert.equal(f.admin.details(f.c.id).status,'REJECTED');
});
for(const active of [false,true])test('fake completed notification '+(active?'early renewal':'expired activation'),async t=>{
 const f=setup(t),old=f.clock()-60*86400000,p=createPremiumService(f.db,{clock:()=>old});const r=p.request({telegram_user_id:101,plan:active?'MONTH_3':'MONTH_1',payment_method:'AYA_PAY'});p.confirm(r.id,{transaction_reference:'SYNTHETIC-PREVIOUS',payment_at:new Date(old).toISOString()},'Admin');f.admin.confirm(f.c.id,f.input,'Admin');const before=member(f),w=worker(f,['fail']);await w.worker.processOne();assert.deepEqual(member(f),before);assert.equal(f.admin.details(f.c.id).status,'COMPLETED');f.advance(DELIVERY_RETRY_MS);await w.worker.processBatch();assert.equal(w.transport.sent.length,2);assert.equal(w.transport.sent[1].text.includes('စတင်သည့်အချိန်'),!active);
});
test('migration backfills prepared messages, is idempotent, preserves closed/payment history',t=>{
 const f=setup(t,false);adminMessage(f);const before=f.db.prepare('SELECT * FROM payment_cases').all();migratePaymentCaseDelivery(f.db);migratePaymentCaseDelivery(f.db);assert.equal(states(f).length,1);assert.deepEqual(f.db.prepare('SELECT * FROM payment_cases').all(),before);assert.throws(()=>f.db.exec('DELETE FROM payment_case_deliveries'));
});

test('successful send with lost acknowledgement response remains SENT after worker restart',async t=>{
 const f=setup(t);f.admin.confirm(f.c.id,f.input,'Admin');const w=worker(f);let lose=true;
 const api=async(p,b)=>{const result=await w.api(p,b);if(p.endsWith('/sent')&&lose){lose=false;throw new Error('Synthetic lost response');}return result;};
 const first=createDeliveryWorker({api,transport:w.transport});assert.equal((await first.processOne()).status,'ACK_UNCERTAIN');assert.equal(states(f)[0].state,'SENT');
 assert.equal((await createDeliveryWorker({api:w.api,transport:w.transport}).processOne()).status,'SENT');assert.equal(w.transport.sent.length,2);assert.equal(w.transport.sent[0].text,notifications(f)[0].text_content);assert.equal(w.transport.sent[1].text,notifications(f)[1].text_content);
});
test('delayed transport holds durable lease while another worker sees no same-customer work',async t=>{
 const f=setup(t);adminMessage(f);let release;const waiting=new Promise(resolve=>release=resolve);const w=worker(f,[()=>waiting]);
 const running=w.worker.processOne();await new Promise(resolve=>setImmediate(resolve));assert.equal((await worker(f).worker.processOne()).status,'IDLE');release();assert.equal((await running).status,'SENT');assert.equal(w.transport.sent.length,1);
});
