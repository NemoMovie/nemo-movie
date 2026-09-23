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
function fixture(t,env={}){
 const db=new Database(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY)');
 for(const f of [migratePremium,migratePremiumLedgerV3,migratePaymentCases,migratePaymentCaseAdapter,migratePaymentCaseAdmin,migratePaymentCaseConversation,migratePaymentCaseWorkflow,migratePaymentBotIntake])f(db);
 let time=Date.parse('2026-01-01T00:00:00.000Z'),seq=0;const clock=()=>time;
 const premium=createPremiumService(db,{clock});premium.upsertUser({telegram_user_id:101});const service=createPaymentBotIntake(db,{clock,env});
 const act=(kind,data={})=>service.act(kind,{telegram_user_id:101,operation_key:'cb:'+ ++seq,...data});
 const select=()=>act('select',{plan:'MONTH_1',payment_method:'KBZPAY',after_case_id:service.state({telegram_user_id:101}).case?.id??0}).case;
 const message=(c,extra={},n=++seq)=>{seq=Math.max(seq,n);return service.act('message',{telegram_user_id:101,operation_key:`msg:101:${n}`,case_id:c.id,chat_id:'101',message_id:n,message_date:Math.floor(clock()/1000),kind:'TEXT',text:'0007',...extra});};
 const photo=(c,n)=>message(c,{kind:'PHOTO',text:undefined,file_id:'fake_file_'+(n??seq),file_unique_id:'fake_unique_'+(n??seq)},n);
 return {db,clock,premium,service,act,select,message,photo,advance:ms=>time+=ms};
}
test('intake migration idempotent; same-case audited method change; general mutation blocked',t=>{
 const f=fixture(t),c=f.select();migratePaymentBotIntake(f.db);
 const before=f.db.prepare('SELECT * FROM payment_cases').get();assert.throws(()=>f.db.exec("UPDATE payment_cases SET payment_method='AYA_PAY'"));
 const input={case_id:c.id,payment_method:'WAVE_MONEY',operation_key:'cb:method'};
 f.act('method',input);f.act('method',input);
 const after=f.db.prepare('SELECT * FROM payment_cases').get();for(const k of ['id','telegram_user_id','plan','plan_days','amount_mmk','created_at'])assert.equal(after[k],before[k]);assert.equal(after.payment_method,'WAVE_MONEY');assert.equal(after.payment_account_reference,'DEV:WAVE_MONEY:v1');
 assert.equal(f.db.prepare('SELECT count(*) n FROM payment_case_method_changes').get().n,1);
 for(const sql of ['DELETE FROM payment_case_method_changes','UPDATE payment_case_method_changes SET new_method=old_method','INSERT OR REPLACE INTO payment_case_method_changes SELECT * FROM payment_case_method_changes'])assert.throws(()=>f.db.exec(sql));
 f.photo(c);assert.throws(()=>f.act('method',{case_id:c.id,payment_method:'AYA_PAY'}));
 assert.throws(()=>f.db.prepare('INSERT INTO payment_case_method_changes(case_id,telegram_user_id,old_method,new_method,old_account,new_account,created_at) VALUES(?,101,?,?,?,?,?)').run(c.id,'WAVE_MONEY','AYA_PAY','DEV:WAVE_MONEY:v1','DEV:AYA_PAY:v1',new Date(f.clock()).toISOString()));
});
test('replacement screenshot, exact digits, immutable history and duplicate receipts',t=>{
 const f=fixture(t),c=f.select();assert.equal(f.message(c,{text:'hello'}).outcome,'SCREENSHOT_REQUIRED');
 const p=f.photo(c,10);assert.equal(p.case.step,'WAITING_LAST_FOUR');f.photo(c,10);assert.equal(f.db.prepare('SELECT count(*) n FROM payment_case_submissions').get().n,1);
 f.photo(c,11);assert.equal(f.db.prepare('SELECT count(*) n FROM payment_case_submissions').get().n,2);assert.equal(f.db.prepare('SELECT latest_proof_submission_id FROM payment_cases_latest').get().latest_proof_submission_id,2);
 for(const text of ['123','12345','12A4','abcd','1 234',' 1234','1234 ','၁၂၃၄'])assert.equal(f.message(c,{text}).outcome,'INVALID_LAST_FOUR');
 assert.equal(f.message(c,{kind:'OTHER',text:undefined}).outcome,'INVALID_LAST_FOUR');
 assert.equal(f.message(c,{},99).case.status,'WAITING_VERIFICATION');f.message(c,{},99);assert.equal(f.message(c,{},100).outcome,'UNDER_REVIEW');
 assert.equal(f.db.prepare('SELECT count(*) n FROM payment_case_submissions').get().n,3);assert.equal(f.db.prepare('SELECT transaction_last_four FROM payment_cases_latest').get().transaction_last_four,'0007');
 f.message(c,{text:'<img src=x onerror=alert(1)>'});assert.equal(f.service.state({telegram_user_id:101}).case.status,'WAITING_VERIFICATION');
 assert.equal(f.db.prepare('SELECT count(*) n FROM payments').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM premium_membership_effects').get().n,0);
 const dto=JSON.stringify(createPaymentCaseAdminService(f.db,{clock:f.clock}).details(c.id));assert(!/fake_file|fake_unique|proof_chat_id|telegram_message_id/.test(dto));
 assert(createPaymentCaseConversationService(f.db).listMessages(c.id).messages.some(m=>m.text_content?.startsWith('<img')));
});
test('cancel, expire, retry, stale callbacks and progress from a new service instance',t=>{
 const f=fixture(t),c=f.select();const input={case_id:c.id,operation_key:'cb:cancel'};f.act('cancel',input);f.act('cancel',input);assert.equal(f.service.state({telegram_user_id:101}).case.status,'CANCELLED');
 assert.throws(()=>f.act('method',{case_id:c.id,payment_method:'WAVE_MONEY'}));assert.equal(f.photo(c).outcome,'CLOSED');
 const next=f.select();assert.notEqual(next.id,c.id);assert.equal(createPaymentBotIntake(f.db,{clock:f.clock}).state({telegram_user_id:101}).case.step,'WAITING_SCREENSHOT');f.photo(next);assert.equal(createPaymentBotIntake(f.db,{clock:f.clock}).state({telegram_user_id:101}).case.step,'WAITING_LAST_FOUR');
 f.advance(86400000);assert.equal(f.service.state({telegram_user_id:101}).case.status,'EXPIRED');assert.equal(f.photo(next).outcome,'CLOSED');assert.throws(()=>f.act('method',{case_id:next.id,payment_method:'WAVE_MONEY'}));
 assert.throws(()=>f.act('select',{plan:'MONTH_1',payment_method:'KBZPAY',after_case_id:0}));assert.notEqual(f.select().id,next.id);
});
for(const state of ['WAITING_VERIFICATION','CONFIRMED','COMPLETED','REJECTED'])test('method changes blocked in '+state,t=>{
 const f=fixture(t),c=f.select();f.photo(c);f.message(c);const admin=createPaymentCaseAdminService(f.db,{clock:f.clock});
 if(['CONFIRMED','COMPLETED'].includes(state))admin.confirm(c.id,{plan:'MONTH_1',amount_mmk:2000,payment_method:'KBZPAY',payment_at:new Date(f.clock()).toISOString()},'Admin');
 if(state==='COMPLETED')admin.retry(c.id,{},'Admin');if(state==='REJECTED')admin.reject(c.id,{reason_category:'OTHER',message:'Synthetic reason'},'Admin');
 assert.throws(()=>f.act('method',{case_id:c.id,payment_method:'WAVE_MONEY'}));
 if(['CONFIRMED','WAITING_VERIFICATION'].includes(state))assert.throws(()=>f.select());
});
test('Burmese flow with real isolated service: start, selections, photos, digits, restart',async t=>{
 const f=fixture(t),sent=[],calls=[];const api=async(p,b)=>{calls.push(p);if(p==='/users')return f.premium.upsertUser(b);if(p==='/flow/state')return f.service.state(b);if(p.startsWith('/flow/'))return f.service.act(p.slice(6),b);if(p==='/plans')return {plans:[{plan:'MONTH_1',amount_mmk:2000},{plan:'MONTH_3',amount_mmk:5000},{plan:'MONTH_6',amount_mmk:9000},{plan:'YEAR_1',amount_mmk:17000}]};return {plan:'MONTH_1',amount_mmk:2000,methods:['KBZPAY','WAVE_MONEY','AYA_PAY']};};
 const make=()=>createFlow({api,send:async(...args)=>sent.push(args)});let flow=make(),n=0;const msg=(extra={})=>({message:{chat:{id:101,type:'private'},from:{id:101,first_name:'Fake'},message_id:++n,date:Math.floor(f.clock()/1000),...extra}});const cb=(data,key)=>({callback_query:{id:key,from:{id:101},message:msg().message,data}});
 await flow.handle(msg({text:'/start upgrade_999'}));assert.equal(calls.length,0);
 await flow.handle(msg({text:'/start upgrade'}));assert.equal(sent.at(-1)[1],messages.plans);assert.equal(sent.at(-1)[2].inline_keyboard.length,4);
 await flow.handle(cb('plan:MONTH_1:0','p'));assert.equal(f.db.prepare('SELECT count(*) n FROM payment_cases').get().n,0);
 await flow.handle(cb('method:MONTH_1:KBZPAY:0','m'));await flow.handle(cb('method:MONTH_1:KBZPAY:0','m'));assert.equal(f.db.prepare('SELECT count(*) n FROM payment_cases').get().n,1);assert(sent.at(-1)[1].includes(messages.development));
 await flow.handle(msg({text:'1234'}));assert.equal(sent.at(-1)[1],messages.screenshot);
 await flow.handle(msg({photo:[{file_id:'photo_a',file_unique_id:'unique_a'}]}));assert.equal(sent.at(-1)[1],messages.photo);
 flow=make();await flow.handle(msg({text:'/start'}));assert.equal(sent.at(-1)[1],messages.photo);
 await flow.handle(msg({photo:[{file_id:'photo_b',file_unique_id:'unique_b'}]}));assert.equal(sent.at(-1)[1],messages.photo);
 await flow.handle(msg({sticker:{file_id:'not_processed'}}));assert.equal(sent.at(-1)[1],messages.invalid);
 const digits=msg({text:'0007'});await flow.handle(digits);await flow.handle(digits);assert.equal(sent.at(-1)[1],messages.submitted);
 await flow.handle(msg({text:'/start'}));assert.equal(sent.at(-1)[1],messages.review);
});

test('photo transaction rolls back on conversation failure; no binary or fabricated reference',t=>{
 const f=fixture(t),c=f.select();
 f.db.exec("CREATE TRIGGER synthetic_message_failure BEFORE INSERT ON payment_case_messages BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END");
 assert.throws(()=>f.photo(c));assert.equal(f.db.prepare('SELECT count(*) n FROM payment_case_submissions').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM payment_bot_operations').get().n,1);
 f.db.exec('DROP TRIGGER synthetic_message_failure');
 assert.throws(()=>f.message(c,{kind:'PHOTO',file_id:'fake',binary:'not allowed'}));
 f.photo(c);f.message(c,{text:'0000'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM payments').get().n,0);
 assert.equal(f.db.prepare('SELECT transaction_last_four FROM payment_cases_latest').get().transaction_last_four,'0000');
});

test('unexpired method audit rejects proof history and expired direct changes',t=>{
 const f=fixture(t),c=f.select();f.advance(86400000);
 assert.throws(()=>f.db.prepare('INSERT INTO payment_case_method_changes(case_id,telegram_user_id,old_method,new_method,old_account,new_account,created_at) VALUES(?,101,?,?,?,?,?)').run(c.id,'KBZPAY','AYA_PAY','DEV:KBZPAY:v1','DEV:AYA_PAY:v1',new Date(f.clock()).toISOString()));
 assert.equal(f.service.state({telegram_user_id:101}).case.status,'EXPIRED');
 const next=f.select();createPaymentCaseConversationService(f.db,{clock:f.clock}).appendCustomerMessage(next.id,{message_type:'PHOTO',telegram_file_id:'synthetic_unlinked',telegram_chat_id:'101',telegram_message_id:999},{telegramUserId:101});
 assert.throws(()=>f.act('method',{case_id:next.id,payment_method:'AYA_PAY'}));
 assert.equal(f.db.prepare('SELECT count(*) n FROM payment_case_method_changes').get().n,0);
});

for(const method of ['KBZPAY','WAVE_MONEY','AYA_PAY'])test('configured '+method+' instructions and stored reference',t=>{
 const f=fixture(t,{[method+'_ACCOUNT']:' synthetic-account ',[method+'_ACCOUNT_NAME']:' Synthetic Name '});
 const c=f.act('select',{plan:'MONTH_1',payment_method:method,after_case_id:0}).case;
 assert.equal(c.payment_account,'synthetic-account');assert.equal(c.payment_account_name,'Synthetic Name');assert.equal(c.instructions_live,true);
 assert.equal(f.db.prepare('SELECT payment_account_reference FROM payment_cases').get().payment_account_reference,'LIVE:'+method+':v1');
 assert.equal(f.service.state({telegram_user_id:101}).case.instructions_live,true);
});
test('method change stores resolved live reference and partial configuration falls back',t=>{
 const f=fixture(t,{WAVE_MONEY_ACCOUNT:'synthetic-wave',WAVE_MONEY_ACCOUNT_NAME:'Synthetic Wave',AYA_PAY_ACCOUNT:'synthetic-partial'}),c=f.select();
 assert.equal(c.instructions_live,false);
 const changed=f.act('method',{case_id:c.id,payment_method:'WAVE_MONEY'}).case;
 assert.equal(changed.payment_account,'synthetic-wave');assert.equal(changed.payment_account_name,'Synthetic Wave');assert.equal(changed.instructions_live,true);
 assert.equal(f.db.prepare('SELECT new_account FROM payment_case_method_changes').get().new_account,'LIVE:WAVE_MONEY:v1');
 const fallback=f.act('method',{case_id:c.id,payment_method:'AYA_PAY'}).case;
 assert.equal(fallback.instructions_live,false);assert.equal(fallback.payment_account,'PAYMENT_ACCOUNT_NOT_CONFIGURED');assert.equal(fallback.payment_account_name,'PAYMENT_ACCOUNT_NOT_CONFIGURED');
 assert.equal(f.db.prepare('SELECT payment_account_reference FROM payment_cases').get().payment_account_reference,'DEV:AYA_PAY:v1');
});
