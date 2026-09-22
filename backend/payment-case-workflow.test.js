import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaymentBotService } from './payment-bot-api.js';
import { createPaymentCaseAdapter } from './payment-case-adapter.js';
import Database from 'better-sqlite3';
import { migratePremium } from './premium-migration.js';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
import { migratePaymentCases } from './payment-case-migration.js';
import { migratePaymentCaseAdapter } from './payment-case-adapter-migration.js';
import { migratePaymentCaseAdmin } from './payment-case-admin-migration.js';
import { migratePaymentCaseConversation } from './payment-case-conversation-migration.js';
import { migratePaymentCaseWorkflow } from './payment-case-workflow-migration.js';
import { createPaymentCaseLifecycle } from './payment-case-lifecycle.js';
import { createPaymentCaseAdminService } from './payment-case-admin.js';
import { createPaymentCaseConversationService } from './payment-case-conversation.js';
import { createPremiumService } from './premium-service.js';
const stamp='2026-01-01T00:00:00.000Z';
function fixture(t,upgrade=true,filename=':memory:'){
 const db=new Database(filename);t.after(()=>{if(db.open)db.close();});db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY); INSERT INTO movies VALUES(1); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY); INSERT INTO series_episodes VALUES(2)');
 for(const migrate of [migratePremium,migratePremiumLedgerV3,migratePaymentCases,migratePaymentCaseAdapter,migratePaymentCaseAdmin,migratePaymentCaseConversation])migrate(db);
 if(upgrade)migratePaymentCaseWorkflow(db);
 let ms=Date.parse(stamp),next=100;const clock=()=>ms,premium=createPremiumService(db,{clock});
 const add=(uid=++next)=>{premium.upsertUser({telegram_user_id:uid});const at=new Date(ms).toISOString();return Number(db.prepare("INSERT INTO payment_cases(telegram_user_id,plan,plan_days,amount_mmk,payment_method,payment_account_reference,created_at,updated_at) VALUES(?,'MONTH_1',30,2000,'KBZPAY','fake',?,?)").run(uid,at,at).lastInsertRowid);};
 const submit=c=>{const at=new Date(ms).toISOString();db.prepare("INSERT INTO payment_case_submissions(case_id,proof_file_id,transaction_last_four,created_at) VALUES(?,'fake-proof','1234',?)").run(c,at);db.prepare("UPDATE payment_cases SET status='WAITING_VERIFICATION',submitted_at=?,updated_at=? WHERE id=?").run(at,at,c);};
 return {db,add,submit,clock,premium,admin:createPaymentCaseAdminService(db,{clock}),life:createPaymentCaseLifecycle(db,{clock}),conversation:createPaymentCaseConversationService(db,{clock}),advance:n=>ms+=n,verify:()=>({plan:'MONTH_1',amount_mmk:2000,payment_method:'KBZPAY',payment_at:new Date(ms).toISOString()})};
}
test('workflow migration preserves legacy rows, histories, foreign keys and repeat',t=>{
 const f=fixture(t,false),c=f.add();f.submit(c);// old row created directly to test preserved compatibility
 f.db.prepare("UPDATE payment_cases SET status='NEEDS_CUSTOMER_ACTION' WHERE id=?").run(c);
 f.db.prepare("INSERT INTO payment_case_admin_actions(case_id,action,message,reason_category,admin_identifier,created_at) VALUES(?,'REJECT','Legacy cancellation','CUSTOMER_CANCELLED','Legacy',?)").run(c,stamp);
 const before=f.db.prepare('SELECT * FROM payment_cases').all(),actions=f.db.prepare('SELECT * FROM payment_case_admin_actions').all();
 migratePaymentCaseWorkflow(f.db);migratePaymentCaseWorkflow(f.db);
 assert.deepEqual(f.db.prepare('SELECT * FROM payment_cases').all(),before);assert.deepEqual(f.db.prepare('SELECT * FROM payment_case_admin_actions').all(),actions);assert.deepEqual(f.db.pragma('foreign_key_check'),[]);assert.equal(f.db.pragma('foreign_keys',{simple:true}),1);
 assert.equal(f.db.prepare('SELECT id FROM movies').get().id,1);assert.equal(f.admin.list({status:'OPEN'}).total,0);assert.equal(f.admin.list({status:'ALL'}).total,1);assert.throws(()=>f.admin.needsCustomerAction(c,{message:'x'},'Admin'),/retired/);
});
test('migration refuses conflicting open legacy history without changes',t=>{
 const f=fixture(t,false);f.add(101);f.add(101);const before=f.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();assert.throws(()=>migratePaymentCaseWorkflow(f.db),/Conflicting/);assert.deepEqual(f.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(),before);assert.equal(f.db.pragma('foreign_keys',{simple:true}),1);
});
test('cancellation, deterministic 24h expiry, immutable closed cases and persisted progress',t=>{
 const f=fixture(t),a=f.add(101),b=f.add(102);assert.equal(f.life.progress(a,101).step,'WAITING_SCREENSHOT');
 f.db.prepare("INSERT INTO payment_case_submissions(case_id,proof_file_id,created_at) VALUES(?,'proof',?)").run(a,stamp);assert.equal(createPaymentCaseLifecycle(f.db,{clock:f.clock}).progress(a,101).step,'WAITING_LAST_FOUR');
 assert.equal(f.life.cancel(a,101).status,'CANCELLED');assert.equal(f.life.cancel(a,101).status,'CANCELLED');assert.throws(()=>f.life.cancel(b,101));
 f.advance(86400000-1);assert.equal(f.life.expire(),0);f.advance(1);assert.equal(f.life.expire(),1);assert.equal(f.life.expire(),0);
 for(const [c,uid] of [[a,101],[b,102]]){
  assert.throws(()=>f.db.prepare("UPDATE payment_cases SET status='WAITING_PAYMENT' WHERE id=?").run(c));
  assert.throws(()=>f.db.prepare("INSERT INTO payment_case_submissions(case_id,proof_file_id,created_at) VALUES(?,'late',?)").run(c,new Date(f.clock()).toISOString()));
  assert.throws(()=>f.conversation.appendCustomerMessage(c,{message_type:'TEXT',text:'late',telegram_chat_id:String(uid),telegram_message_id:1},{telegramUserId:uid}));
  assert.throws(()=>f.admin.confirm(c,f.verify(),'Admin'));assert.throws(()=>f.admin.reject(c,{reason_category:'OTHER',message:'late'},'Admin'));
  f.add(uid);
 }
 assert.equal(f.admin.list({status:'OPEN'}).total,2);
});
test('manual verification without reference stays confirmed; activation once with NULL reference',t=>{
 const f=fixture(t),c=f.add();f.submit(c);assert.throws(()=>f.admin.needsCustomerAction(c,{message:'clarify'},'Admin'));
 f.conversation.prepareAdminMessage(c,{text:'Clarification only'},{adminIdentifier:'Admin'});assert.equal(f.admin.details(c).status,'WAITING_VERIFICATION');
 assert.equal(f.admin.confirm(c,f.verify(),'Admin').status,'CONFIRMED');assert.equal(f.admin.confirm(c,f.verify(),'Admin').status,'CONFIRMED');assert.equal(f.db.prepare('SELECT count(*) n FROM payments').get().n,0);
 f.db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON premium_membership_effects BEGIN SELECT RAISE(ABORT,'failure'); END");assert.equal(f.admin.retry(c,{},'Admin').status,'CONFIRMED');assert.equal(f.db.prepare('SELECT count(*) n FROM payments').get().n,0);f.db.exec('DROP TRIGGER injected_failure');
 assert.equal(f.admin.retry(c,{},'Admin').status,'COMPLETED');assert.equal(f.admin.confirm(c,f.verify(),'Admin').status,'COMPLETED');assert.throws(()=>f.admin.retry(c,{},'Admin'));
 assert.equal(f.db.prepare('SELECT count(*) n FROM premium_membership_effects').get().n,1);assert.equal(f.db.prepare('SELECT transaction_reference FROM payments').get().transaction_reference,null);
 f.premium.upsertUser({telegram_user_id:999});const pending=f.premium.request({telegram_user_id:999,plan:'MONTH_1',payment_method:'KBZPAY'});assert.throws(()=>f.premium.confirm(pending.id,{transaction_reference:null,payment_at:stamp},'Admin')); // legacy confirmation still requires its reference
});
test('one-open constraint, approved rejection reasons, duplicate proof warning not decision',t=>{
 const f=fixture(t),a=f.add(101),b=f.add(102);assert.throws(()=>f.add(101));f.submit(a);f.submit(b);
 assert.equal(f.admin.details(a).possible_duplicate_cases[0].id,b);assert.equal(f.admin.details(a).status,'WAITING_VERIFICATION');
 const dto=JSON.stringify(f.admin.details(a));assert(!/proof_file_id|proof_chat_id|proof_message_id/.test(dto));
 assert.throws(()=>f.admin.reject(a,{reason_category:'CUSTOMER_CANCELLED',message:'cancel'},'Admin'));
 assert.throws(()=>f.admin.reject(a,{reason_category:'OTHER',message:''},'Admin'));
 assert.equal(f.admin.reject(a,{reason_category:'OTHER',message:'Manual verification failed'},'Admin').status,'REJECTED');f.add(101);
 assert.equal(f.admin.confirm(b,f.verify(),'Admin').status,'CONFIRMED');assert.throws(()=>f.admin.reject(b,{reason_category:'OTHER',message:'wrong'},'Admin'));
});

test('migration preserves completed legacy payment, ledger, verification and conversation',t=>{
 const f=fixture(t,false),c=f.add(101);f.submit(c);f.conversation.appendCustomerMessage(c,{message_type:'TEXT',text:'Historical',telegram_chat_id:'101',telegram_message_id:1},{telegramUserId:101});
 createPaymentCaseAdapter(f.db,{clock:f.clock}).confirmPaymentCase(c,{...f.verify(),transaction_reference:'LEGACY-FULL-1234'},'LegacyAdmin');
 const tables=['payment_cases','payment_case_submissions','payment_case_verifications','payment_case_messages','payment_case_admin_actions','payments','premium_memberships','premium_membership_effects'];
 const before=tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all());migratePaymentCaseWorkflow(f.db);migratePaymentCaseWorkflow(f.db);assert.deepEqual(tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all()),before);
});
test('rebuild failure rolls back complete schema and rows and restores FK setting',t=>{
 const f=fixture(t,false);f.add();const before=f.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();const exec=f.db.exec.bind(f.db);
 f.db.exec=sql=>{if(sql.startsWith('CREATE UNIQUE INDEX payment_cases_one_open'))throw new Error('Synthetic publish failure');return exec(sql);};
 assert.throws(()=>migratePaymentCaseWorkflow(f.db),/Synthetic/);f.db.exec=exec;
 assert.deepEqual(f.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM payment_cases').get().n,1);assert.equal(f.db.pragma('foreign_keys',{simple:true}),1);
});
test('two connections and reopening retain one case and progress',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nemo-workflow-')),file=path.join(dir,'test.db');const f=fixture(t,true,file);
 t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert(path.basename(dir).startsWith('nemo-workflow-'));fs.rmSync(dir,{recursive:true,force:true});});
 f.premium.upsertUser({telegram_user_id:101});const input={telegram_user_id:101,plan:'MONTH_1',payment_method:'KBZPAY'};
 const other=new Database(file,{timeout:1});try{
  f.db.exec('BEGIN IMMEDIATE');assert.throws(()=>createPaymentBotService(other).create(input),/locked/);f.db.exec('ROLLBACK');
  createPaymentBotService(f.db).create(input);createPaymentBotService(other).create(input);
  assert.equal(other.prepare('SELECT count(*) n FROM payment_cases').get().n,1);
 }finally{other.close();}
 f.db.close();const reopened=new Database(file);try{const c=reopened.prepare('SELECT id FROM payment_cases').get();assert.equal(createPaymentCaseLifecycle(reopened).progress(c.id,101).step,'WAITING_SCREENSHOT');}finally{reopened.close();}
});
