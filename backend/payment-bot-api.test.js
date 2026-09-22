import { migratePaymentCaseDelivery } from './payment-case-delivery-migration.js';
import { createPaymentCaseConversationService } from './payment-case-conversation.js';
import { migratePaymentCaseCompletion } from './payment-case-completion-migration.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import { migratePaymentBotIntake } from './payment-bot-intake-migration.js';
import { migratePremium } from './premium-migration.js';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
import { migratePaymentCases } from './payment-case-migration.js';
import { migratePaymentCaseAdapter } from './payment-case-adapter-migration.js';
import { migratePaymentCaseWorkflow } from './payment-case-workflow-migration.js';
import { migratePaymentCaseConversation } from './payment-case-conversation-migration.js';
import { migratePaymentCaseAdmin } from './payment-case-admin-migration.js';
import { createPaymentCaseAdminService } from './payment-case-admin.js';
import { createPremiumService,PLANS } from './premium-service.js';
import { createPaymentBotService,registerPaymentBotRoutes } from './payment-bot-api.js';
function fixture(t){const db=new Database(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY)');migratePremium(db);migratePremiumLedgerV3(db);migratePaymentCases(db);migratePaymentCaseAdapter(db);migratePaymentCaseAdmin(db);migratePaymentCaseConversation(db);migratePaymentCaseWorkflow(db);migratePaymentBotIntake(db);return {db,service:createPaymentBotService(db)};}
test('dedicated authenticated HTTP routes: auth, bounds, minimal projection',async t=>{
 const {db}=fixture(t),app=express(),env={PAYMENT_BOT_API_SECRET:'synthetic-secret'};app.use(express.json({limit:'8kb'}));registerPaymentBotRoutes(app,db,env);app.use((e,r,s,n)=>s.status(500).json({message:'Internal error'}));
 const listener=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>listener.close(resolve)));assert.notEqual(listener.address().port,3000);
 const call=async(path,body,secret='synthetic-secret')=>{const r=await fetch(`http://127.0.0.1:${listener.address().port}/api/internal/payment-bot`+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(secret?{Authorization:'Bearer '+secret}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(r.headers.get('cache-control'),'no-store');return {status:r.status,data:await r.json()};};
 for(const secret of ['', 'wrong']){assert.equal((await call('/plans',undefined,secret)).status,401);assert.equal((await call('/notifications',undefined,secret)).status,401);}
 assert.equal((await call('/notifications')).status,503);migratePaymentCaseCompletion(db);migratePaymentCaseDelivery(db);
 assert.deepEqual((await call('/notifications')).data,{notifications:[]});
 delete env.PAYMENT_BOT_API_SECRET;assert.equal((await call('/plans')).status,503);env.PAYMENT_BOT_API_SECRET='synthetic-secret';
 assert.equal((await call('/users',{telegram_user_id:101,username:'fake'})).status,200);
 assert.equal((await call('/users/101/status')).data.status,'NON_PREMIUM');
 assert.equal((await call('/users/0/status')).status,400);
 assert.equal((await call('/users',{telegram_user_id:0})).status,400);
 assert.equal((await call('/users',{telegram_user_id:101,first_name:'x'.repeat(5000)})).status,413);
 assert.equal((await call('/users',{telegram_user_id:101,first_name:[]})).status,400);
 const plans=(await call('/plans')).data.plans;assert.equal(plans.length,4);
 for(const p of plans){assert.deepEqual([p.plan_days,p.amount_mmk],PLANS[p.plan]);assert.deepEqual((await call('/plans/'+p.plan)).data.methods,['KBZPAY','WAVE_MONEY','AYA_PAY']);}
 assert.equal((await call('/plans/BAD')).status,400);
 const input={telegram_user_id:101,plan:'MONTH_1',payment_method:'KBZPAY'};
 for(const bad of [{...input,plan:'BAD'},{...input,payment_method:'BAD'},{...input,amount_mmk:1},{...input,plan_days:1}])assert.equal((await call('/cases',bad)).status,400);
 const r=await call('/cases',input);assert.equal(r.status,200);assert.deepEqual(Object.keys(r.data).sort(),['plan','label','plan_days','amount_mmk','payment_method','status','payment_account','instructions_live'].sort());assert.equal(r.data.status,'WAITING_PAYMENT');assert.equal(r.data.payment_account,'PAYMENT_ACCOUNT_NOT_CONFIGURED');assert.equal(r.data.instructions_live,false);
 assert(!/secret|request_code|telegram_chat|telegram_message|telegram_file|confirmed_by/.test(JSON.stringify(r.data)));
 await Promise.all(Array.from({length:10},()=>call('/cases',input)));assert.equal(db.prepare('SELECT count(*) n FROM payment_cases').get().n,1);
 assert.equal((await call('/cases',{...input,plan:'MONTH_3'})).status,409);
 for(const path of ['/flow/state','/flow/select','/flow/method','/flow/cancel','/flow/message'])for(const secret of ['', 'wrong'])assert.equal((await call(path,{},secret)).status,401);
 assert.equal((await call('/flow/state',{telegram_user_id:101})).data.case.status,'WAITING_PAYMENT');
 const cid=(await call('/flow/state',{telegram_user_id:101})).data.case.id;
 assert.equal((await call('/flow/method',{telegram_user_id:101,operation_key:'cb:http',case_id:cid,payment_method:'AYA_PAY'})).data.case.payment_method,'AYA_PAY');
 assert.equal((await call('/flow/method',{telegram_user_id:999,operation_key:'cb:wrong-owner',case_id:cid,payment_method:'KBZPAY'})).status,404);
 const message=createPaymentCaseConversationService(db).prepareAdminMessage(cid,{text:'Synthetic clarification'},{adminIdentifier:'Admin'});
 for(const path of ['/deliveries/claim','/deliveries/'+message.id+'/sent','/deliveries/'+message.id+'/failed'])for(const secret of ['', 'wrong'])assert.equal((await call(path,{},secret)).status,401);
 assert.equal((await call('/deliveries/claim',{extra:1})).status,400);
 const delivery=(await call('/deliveries/claim',{})).data.delivery;assert.equal(delivery.message_id,message.id);assert.equal(delivery.telegram_user_id,101);assert(!/proof_|internal_request_code|secret/.test(JSON.stringify(delivery)));
 assert.equal((await call('/deliveries/claim',{})).data.delivery,null);
 assert.equal((await call('/deliveries/0/sent',{claim_token:delivery.claim_token})).status,400);
 assert.equal((await call('/deliveries/'+message.id+'/sent',{claim_token:'0'.repeat(64)})).status,409);
 const ack={claim_token:delivery.claim_token};assert.equal((await call('/deliveries/'+message.id+'/sent',ack)).data.state,'SENT');assert.equal((await call('/deliveries/'+message.id+'/sent',ack)).data.state,'SENT');assert.equal((await call('/deliveries/'+message.id+'/failed',ack)).data.state,'SENT');
 assert.equal((await call('/flow/cancel',{telegram_user_id:101,operation_key:'cb:cancel-http',case_id:cid})).data.case.status,'CANCELLED');
 for(const table of ['payments','premium_memberships','premium_membership_effects','payment_case_submissions'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});
test('identity refresh, membership status, methods and closed case history',t=>{
 const {db,service:s}=fixture(t);s.identity({telegram_user_id:101,username:'old'});s.identity({telegram_user_id:101,username:'new'});assert.equal(db.prepare('SELECT username FROM telegram_users').get().username,'new');
 const premium=createPremiumService(db),admin=createPaymentCaseAdminService(db);
 for(const [i,method] of ['KBZPAY','WAVE_MONEY','AYA_PAY'].entries()){const uid=201+i;s.identity({telegram_user_id:uid});assert.equal(s.create({telegram_user_id:uid,plan:'YEAR_1',payment_method:method}).amount_mmk,17000);}
 const input={telegram_user_id:101,plan:'MONTH_1',payment_method:'KBZPAY'};s.create(input);let c=db.prepare('SELECT * FROM payment_cases WHERE telegram_user_id=101').get();
 db.prepare("INSERT INTO payment_case_submissions(case_id,proof_file_id,transaction_last_four,created_at) VALUES(?,'fake','1234',?)").run(c.id,c.created_at);db.prepare("UPDATE payment_cases SET status='WAITING_VERIFICATION',submitted_at=? WHERE id=?").run(c.created_at,c.id);admin.reject(c.id,{message:'Synthetic only',reason_category:'OTHER'},'Fixture');const rejected=db.prepare('SELECT * FROM payment_cases WHERE id=?').get(c.id);s.create(input);assert.deepEqual(db.prepare('SELECT * FROM payment_cases WHERE id=?').get(c.id),rejected);
 c=db.prepare('SELECT * FROM payment_cases WHERE telegram_user_id=101 ORDER BY id DESC').get();const at=new Date().toISOString();db.prepare('INSERT INTO payment_case_submissions(case_id,proof_file_id,transaction_last_four,created_at) VALUES(?,?,?,?)').run(c.id,'fake','1234',at);db.prepare("UPDATE payment_cases SET status='WAITING_VERIFICATION',submitted_at=?,updated_at=? WHERE id=?").run(at,at,c.id);
 assert.throws(()=>s.create(input),/resolved/);
 admin.confirm(c.id,{transaction_reference:'SYNTHETIC-REF',payment_at:at,plan:'MONTH_1',amount_mmk:2000,payment_method:'KBZPAY'},'Fixture');admin.retry(c.id,{},'Fixture');const completed=db.prepare('SELECT * FROM payment_cases WHERE id=?').get(c.id);assert.equal(completed.status,'COMPLETED');assert.equal(s.status(101).status,'ACTIVE');assert.equal(s.create(input).status,'WAITING_PAYMENT');assert.deepEqual(db.prepare('SELECT * FROM payment_cases WHERE id=?').get(c.id),completed);
 // Once the synthetic membership expires, closed history permits a new attempt.
 db.prepare('UPDATE premium_memberships SET start_at=?,expires_at=? WHERE telegram_user_id=101').run('2020-01-01T00:00:00.000Z','2020-02-01T00:00:00.000Z');
 assert.equal(s.create(input).status,'WAITING_PAYMENT');assert.deepEqual(db.prepare('SELECT * FROM payment_cases WHERE id=?').get(c.id),completed);
 // Synthetic expired member independent of immutable completed history.
 s.identity({telegram_user_id:999});db.prepare('INSERT INTO premium_memberships(telegram_user_id,start_at,expires_at,created_at,updated_at) VALUES(?,?,?,?,?)').run(999,'2020-01-01T00:00:00.000Z','2020-02-01T00:00:00.000Z',at,at);assert.equal(s.status(999).status,'EXPIRED');assert.equal(s.create({...input,telegram_user_id:999}).status,'WAITING_PAYMENT');
});

test('backend rejects cross-purpose fields and transaction failure leaves no case',t=>{
 const {db,service:s}=fixture(t);s.identity({telegram_user_id:101});const input={telegram_user_id:101,plan:'MONTH_1',payment_method:'KBZPAY'};
 for(const extra of [{status:'CONFIRMED'},{proof_file_id:'fake'},{transaction_last_four:'1234'},{payment_account:'real'}])assert.throws(()=>s.create({...input,...extra}),/Invalid request/);
 db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON payment_cases BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END");assert.throws(()=>s.create(input));assert.equal(db.prepare('SELECT count(*) n FROM payment_cases').get().n,0);
});
