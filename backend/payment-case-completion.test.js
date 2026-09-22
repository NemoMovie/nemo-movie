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
function fixture(t){
 const db=new Database(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY)');
 for(const f of [migratePremium,migratePremiumLedgerV3,migratePaymentCases,migratePaymentCaseAdapter,migratePaymentCaseAdmin,migratePaymentCaseConversation,migratePaymentCaseWorkflow,migratePaymentBotIntake,migratePaymentCaseCompletion])f(db);
 let time=Date.parse('2026-01-01T00:00:00.000Z'),seq=0;const clock=()=>time;
 const premium=createPremiumService(db,{clock});premium.upsertUser({telegram_user_id:101});const service=createPaymentBotIntake(db,{clock});
 const act=(kind,data={})=>service.act(kind,{telegram_user_id:101,operation_key:'cb:'+ ++seq,...data});
 const select=()=>act('select',{plan:'MONTH_1',payment_method:'KBZPAY',after_case_id:service.state({telegram_user_id:101}).case?.id??0}).case;
 const message=(c,extra={},n=++seq)=>{seq=Math.max(seq,n);return service.act('message',{telegram_user_id:101,operation_key:`msg:101:${n}`,case_id:c.id,chat_id:'101',message_id:n,message_date:Math.floor(clock()/1000),kind:'TEXT',text:'0007',...extra});};
 const photo=(c,n)=>message(c,{kind:'PHOTO',text:undefined,file_id:'fake_file_'+(n??seq),file_unique_id:'fake_unique_'+(n??seq)},n);
 return {db,clock,premium,service,act,select,message,photo,advance:ms=>time+=ms};
}

function setup(t){const f=fixture(t),c=f.select();f.photo(c);f.message(c);f.advance(1000);const admin=createPaymentCaseAdminService(f.db,{clock:f.clock});const input={plan:'MONTH_1',amount_mmk:2000,payment_method:'KBZPAY',payment_at:new Date(f.clock()-1000).toISOString()};return {...f,c,admin,input};}
const notifications=f=>f.db.prepare('SELECT n.*,m.text_content FROM payment_case_notifications n JOIN payment_case_messages m ON m.id=n.message_id ORDER BY m.id').all();
const member=f=>f.db.prepare('SELECT * FROM premium_memberships WHERE telegram_user_id=101').get();
const count=(f,table)=>f.db.prepare('SELECT count(*) n FROM '+table).get().n;

test('confirm automatically completes exactly once; durable ordered notifications and immutable audit',t=>{
 const f=setup(t);migratePaymentCaseCompletion(f.db);const at=new Date(f.clock()).toISOString();
 let r=f.admin.confirm(f.c.id,f.input,'Admin');assert.equal(r.status,'COMPLETED');assert.equal(member(f).start_at,at);assert.equal(member(f).expires_at,new Date(f.clock()+30*86400000).toISOString());
 assert.equal(count(f,'payment_case_verifications'),1);assert.equal(count(f,'premium_membership_effects'),1);
 const rows=notifications(f);assert.deepEqual(rows.map(n=>n.event),['CONFIRMED','COMPLETED']);assert(rows.every(n=>n.delivery_state==='PENDING_SEND'));assert.match(rows[0].text_content,/ခဏစောင့်/);assert.match(rows[1].text_content,/06:30:01/);
 const before=member(f);r=f.admin.confirm(f.c.id,f.input,'Admin');assert.equal(r.status,'COMPLETED');assert.deepEqual(member(f),before);assert.equal(notifications(f).length,2);
 assert.throws(()=>f.admin.retry(f.c.id,{},'Admin'));assert.throws(()=>f.admin.reject(f.c.id,{reason_category:'OTHER',message:'No'},'Admin'));
 for(const table of ['payment_case_verifications','payment_case_activation_attempts','payment_case_notifications'])assert.throws(()=>f.db.exec('DELETE FROM '+table));
 assert.throws(()=>f.db.exec("UPDATE payment_case_notifications SET event='REJECTED'"));
 assert(!/fake_file|fake_unique|internal_request_code/.test(JSON.stringify(r)));
 assert.equal(createPaymentCaseConversationService(f.db).listMessages(f.c.id).messages.at(-1).delivery_state,'PENDING_SEND');
});
for(const active of [true,false])test(active?'early renewal preserves remaining time':'expired activation starts at confirmation time',t=>{
 const f=setup(t),old=f.clock()-60*86400000,p=createPremiumService(f.db,{clock:()=>old});
 const request=p.request({telegram_user_id:101,plan:active?'MONTH_3':'MONTH_1',payment_method:'AYA_PAY'});p.confirm(request.id,{transaction_reference:'SYNTHETIC-OLD',payment_at:new Date(old).toISOString()},'Admin');
 const before=member(f);f.admin.confirm(f.c.id,f.input,'Admin');const after=member(f);
 assert.equal(after.start_at,active?before.start_at:new Date(f.clock()).toISOString());
 assert.equal(after.expires_at,new Date((active?Date.parse(before.expires_at):f.clock())+30*86400000).toISOString());
 assert.equal(notifications(f).at(-1).text_content.includes('စတင်သည့်အချိန်'),!active);
});
test('failed activation persists CONFIRMED and safe failure; retry same case after new service',t=>{
 const f=setup(t);f.db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON premium_membership_effects BEGIN SELECT RAISE(ABORT,'SECRET-PATH'); END");
 const r=f.admin.confirm(f.c.id,f.input,'Admin');assert.equal(r.status,'CONFIRMED');assert.equal(r.completion_error,'COMPLETION_FAILED');assert(!JSON.stringify(r).includes('SECRET-PATH'));assert.equal(count(f,'payments'),0);assert.deepEqual(notifications(f).map(n=>n.event),['CONFIRMED']);
 assert.equal(r.activation_attempts.at(-1).outcome,'COMPLETION_FAILED');assert.throws(()=>f.admin.reject(f.c.id,{reason_category:'OTHER',message:'No'},'Admin'));
 f.db.exec('DROP TRIGGER synthetic_fail');f.advance(10000);const again=createPaymentCaseAdminService(f.db,{clock:f.clock});assert.equal(again.retry(f.c.id,{},'Admin').status,'COMPLETED');assert.equal(member(f).start_at,r.confirmed_at);assert.throws(()=>again.retry(f.c.id,{},'Admin'));assert.equal(count(f,'premium_membership_effects'),1);assert.equal(count(f,'payment_case_verifications'),1);assert.equal(notifications(f).length,2);
});
test('already applied matching effect reconciles without second extension',t=>{
 const f=setup(t);createPaymentCaseAdapter(f.db,{clock:f.clock}).verifyPaymentCase(f.c.id,f.input,'Admin');
 const v=f.db.prepare('SELECT * FROM payment_case_verifications').get();
 const p=f.db.prepare("INSERT INTO payments(telegram_user_id,payment_request_code,payment_method,amount_mmk,plan,plan_days,status,created_at,request_expires_at) VALUES(101,?,'KBZPAY',2000,'MONTH_1',30,'PENDING',?,?)").run(v.internal_request_code,v.confirmed_at,new Date(Date.parse(v.confirmed_at)+86400000).toISOString());
 createPremiumService(f.db,{clock:()=>Date.parse(v.confirmed_at)}).confirmVerifiedCase(Number(p.lastInsertRowid),f.c.id,v.payment_at,'Admin');
 const before=member(f);assert.equal(f.admin.confirm(f.c.id,f.input,'Admin').status,'COMPLETED');assert.deepEqual(member(f),before);assert.equal(count(f,'premium_membership_effects'),1);assert.equal(notifications(f).length,2);
});
for(const reason of ['PAYMENT_NOT_FOUND','INCORRECT_PAYMENT_DETAILS','PAYMENT_PROOF_ALREADY_USED','INCORRECT_AMOUNT','INVALID_OR_UNCLEAR_PROOF','OTHER'])test('rejection '+reason+' is permanent, queued once, no grant',t=>{
 const f=setup(t),input={reason_category:reason,...(reason==='OTHER'?{message:'Synthetic clarification'}:{})};
 assert.equal(f.admin.reject(f.c.id,input,'Admin').status,'REJECTED');assert.equal(f.admin.reject(f.c.id,input,'Admin').status,'REJECTED');
 const rows=notifications(f);assert.equal(rows.length,1);assert.equal(rows[0].event,'REJECTED');assert.equal(rows[0].action,'RESELECT');assert.match(rows[0].text_content,/အတည်ပြု၍ မရပါ/);assert.equal(count(f,'payments'),0);assert.equal(count(f,'premium_membership_effects'),0);assert.equal(count(f,'payment_case_admin_actions'),1);
 assert.throws(()=>f.admin.confirm(f.c.id,f.input,'Admin'));assert.throws(()=>f.admin.retry(f.c.id,{},'Admin'));
});
test('validation, status restrictions, transactional outbox failure and MMT rollover',t=>{
 const f=setup(t);assert.throws(()=>f.admin.confirm(f.c.id,{...f.input,transaction_reference:'NOT-ALLOWED'},'Admin'));
 assert.throws(()=>f.admin.reject(f.c.id,{reason_category:'CUSTOMER_CANCELLED',message:'No'},'Admin'));assert.throws(()=>f.admin.reject(f.c.id,{reason_category:'OTHER'},'Admin'));
 f.db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON payment_case_notifications BEGIN SELECT RAISE(ABORT,'fail'); END");
 assert.throws(()=>f.admin.confirm(f.c.id,f.input,'Admin'));assert.equal(count(f,'payment_case_verifications'),0);assert.equal(count(f,'payment_case_notifications'),0);assert.equal(f.admin.details(f.c.id).status,'WAITING_VERIFICATION');
 assert.throws(()=>f.admin.reject(f.c.id,{reason_category:'OTHER',message:'No'},'Admin'));assert.equal(count(f,'payment_case_admin_actions'),0);
 assert.equal(formatMMT('2026-12-31T20:00:00.000Z'),'2027-01-01 02:30:00 MMT (UTC+06:30)');
});

test('completion-message failure rolls back grant, retains confirmed notification; restart snapshot preserves outbox',t=>{
 const f=setup(t);f.db.exec("CREATE TRIGGER synthetic_notification_fail BEFORE INSERT ON payment_case_notifications WHEN NEW.event='COMPLETED' BEGIN SELECT RAISE(ABORT,'fail'); END");
 assert.equal(f.admin.confirm(f.c.id,f.input,'Admin').status,'CONFIRMED');assert.equal(count(f,'premium_membership_effects'),0);assert.equal(count(f,'payments'),0);assert.deepEqual(notifications(f).map(n=>n.event),['CONFIRMED']);
 f.db.exec('DROP TRIGGER synthetic_notification_fail');f.admin.retry(f.c.id,{},'Admin');
 const reopened=new Database(f.db.serialize());t.after(()=>reopened.close());migratePaymentCaseCompletion(reopened);
 assert.equal(reopened.prepare('SELECT count(*) n FROM payment_case_notifications').get().n,2);
 assert.equal(createPaymentCaseAdminService(reopened,{clock:f.clock}).details(f.c.id).status,'COMPLETED');
});
