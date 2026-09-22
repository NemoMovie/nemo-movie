import { migratePaymentCaseWorkflow } from './payment-case-workflow-migration.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratePremium } from './premium-migration.js';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
import { migratePaymentCases } from './payment-case-migration.js';
import { migratePaymentCaseAdapter } from './payment-case-adapter-migration.js';
import { migratePaymentCaseAdmin } from './payment-case-admin-migration.js';
import { createPaymentCaseAdminService } from './payment-case-admin.js';
import { createPremiumService } from './premium-service.js';
import { migratePaymentCaseConversation } from './payment-case-conversation-migration.js';
import { createPaymentCaseConversationService } from './payment-case-conversation.js';
const stamp='2026-01-01T00:00:00.000Z',customer={telegramUserId:101},admin={adminIdentifier:'SyntheticAdmin'};
function fixture(t){
 const db=new Database(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY); INSERT INTO movies VALUES(1); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY); INSERT INTO series_episodes VALUES(2);');
 migratePremium(db);migratePremiumLedgerV3(db);migratePaymentCases(db);migratePaymentCaseAdapter(db);migratePaymentCaseAdmin(db);migratePaymentCaseConversation(db);
 createPremiumService(db,{clock:()=>Date.parse(stamp)}).upsertUser({telegram_user_id:101,username:'fake'});
 let clock=Date.parse(stamp),telegramMessage=1;const service=createPaymentCaseConversationService(db,{clock:()=>clock});
 const add=()=>Number(db.prepare(`INSERT INTO payment_cases(telegram_user_id,plan,plan_days,amount_mmk,payment_method,payment_account_reference,created_at,updated_at) VALUES(101,'MONTH_1',30,2000,'KBZPAY','fake-account',?,?)`).run(stamp,stamp).lastInsertRowid);
 const text=(content='I already paid.')=>({message_type:'TEXT',text:content,telegram_chat_id:'101',telegram_message_id:telegramMessage++});
 const photo=()=>({message_type:'PHOTO',telegram_chat_id:'101',telegram_message_id:telegramMessage++,telegram_file_id:'fake_file',telegram_file_unique_id:'fake_unique'});
 return {db,service,add,text,photo,advance:()=>clock+=1000};
}
test('fresh/idempotent additive migration preserves existing schema, data and actions',t=>{
 const f=fixture(t);const c=f.add();f.service.prepareAdminMessage(c,{text:'Please clarify'},admin);
 const snapshot=()=>f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();const before=snapshot();migratePaymentCaseConversation(f.db);migratePaymentCaseConversation(f.db);assert.deepEqual(snapshot(),before);
 assert.equal(f.db.prepare('SELECT id FROM movies').get().id,1);assert.equal(f.db.prepare('SELECT id FROM series_episodes').get().id,2);assert.equal(f.service.listMessages(c).messages.length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM payment_case_admin_actions').get().n,0);
});
test('TEXT, PHOTO, Admin preparation, SYSTEM and safe representation',t=>{
 const f=fixture(t),c=f.add();const a=f.service.appendCustomerMessage(c,f.text(),customer);const p=f.service.appendCustomerMessage(c,{...f.photo(),text:'Screenshot caption'},customer);const m=f.service.prepareAdminMessage(c,{text:'Please send clearer proof.'},admin);const sys=f.service.appendSystemMessage(c,{text:'Synthetic system note'});
 assert.equal(a.sender_type,'CUSTOMER');assert.equal(p.has_photo,true);assert.equal(m.initial_delivery_state,'PENDING_SEND');assert.equal(m.admin_identifier,'SyntheticAdmin');assert.equal(sys.message_type,'SYSTEM');assert.equal(sys.initial_delivery_state,'NOT_APPLICABLE');
 const browser=JSON.stringify(f.service.listMessages(c));assert(!/telegram_file|telegram_chat|telegram_message|fake_file|fake_unique|BOT_TOKEN|SECRET/.test(browser));assert(!browser.includes('SENT'));
 assert.equal(f.service.getInternalMessage(c,p.id).telegram_file_id,'fake_file');
 assert.equal(f.db.prepare("SELECT count(*) n FROM payment_case_messages WHERE typeof(text_content)='blob' OR typeof(telegram_file_id)='blob'").get().n,0);
});
test('chronological bounded keyset read, equal timestamp IDs and case isolation',t=>{
 const f=fixture(t),c=f.add(),other=f.add();const ids=[];
 for(let n=0;n<6;n++){if(n===3)f.advance();ids.push(f.service.appendCustomerMessage(c,f.text('Message '+n),customer).id);}
 f.service.appendCustomerMessage(other,f.text('Other case'),customer);
 const first=f.service.listMessages(c,{limit:3});assert.deepEqual(first.messages.map(m=>m.id),ids.slice(0,3));assert.equal(first.next_after_id,ids[2]);
 const second=f.service.listMessages(c,{limit:3,after_id:first.next_after_id});assert.deepEqual(second.messages.map(m=>m.id),ids.slice(3));assert.equal(second.next_after_id,null);
 assert.throws(()=>f.service.listMessages(other,{after_id:ids[0]}));assert.throws(()=>f.service.getInternalMessage(other,ids[0]));assert.throws(()=>f.service.listMessages(c,{limit:101}));assert.throws(()=>f.service.listMessages(c,{limit:0}));assert.equal(f.service.listMessages(other).messages.length,1);
});
test('invalid identity, body, type and text are rejected',t=>{
 const f=fixture(t),c=f.add();assert.throws(()=>f.service.appendCustomerMessage(c,f.text(),{telegramUserId:202}));assert.throws(()=>f.service.appendCustomerMessage(999,f.text(),customer));
 for(const patch of [{message_type:'VIDEO'},{text:''},{text:null},{text:Buffer.from('binary')},{text:'x'.repeat(4097)},{BOT_TOKEN:'fake-secret'},{admin_identifier:'forged'},{telegram_chat_id:'https://invalid'},{telegram_message_id:0},{telegram_message_id:1.5}])assert.throws(()=>f.service.appendCustomerMessage(c,{...f.text(),...patch},customer));
 assert.throws(()=>f.service.prepareAdminMessage(c,{text:'Hi',admin_identifier:'forged'},admin));assert.throws(()=>f.service.prepareAdminMessage(c,{text:'Hi'},{}));assert.throws(()=>f.service.prepareAdminMessage(c,{text:'Hi',delivery_state:'SENT'},admin));assert.equal(f.service.listMessages(c).messages.length,0);
});
test('invalid photo metadata and binary/token-bearing URLs rejected',t=>{
 const f=fixture(t),c=f.add();for(const patch of [{telegram_file_id:undefined},{telegram_file_id:''},{telegram_file_id:Buffer.from('image')},{telegram_file_id:'https://api.telegram.org/file/botFAKE/file.jpg'},{telegram_file_unique_id:'bad:token'},{text:null}])assert.throws(()=>f.service.appendCustomerMessage(c,{...f.photo(),...patch},customer));
 assert.equal(f.service.listMessages(c).messages.length,0);
});
test('UPDATE, DELETE and OR REPLACE blocked; duplicate Telegram update not duplicated',t=>{
 const f=fixture(t),c=f.add(),input=f.text();f.service.appendCustomerMessage(c,input,customer);
 assert.throws(()=>f.service.appendCustomerMessage(c,input,customer));
 for(const sql of ['UPDATE payment_case_messages SET text_content=\'changed\'','DELETE FROM payment_case_messages','INSERT OR REPLACE INTO payment_case_messages SELECT * FROM payment_case_messages'])assert.throws(()=>f.db.exec(sql));assert.equal(f.service.listMessages(c).messages.length,1);
});
for(const state of ['COMPLETED','REJECTED'])test(state+' refuses customer/Admin append but retains history',t=>{
 const f=fixture(t),c=f.add();f.service.appendCustomerMessage(c,f.text(),customer);f.service.prepareAdminMessage(c,{text:'Recorded before closure'},admin);
 migratePaymentCaseWorkflow(f.db);
 const cases=createPaymentCaseAdminService(f.db,{clock:()=>Date.parse(stamp)});
 f.db.prepare("INSERT INTO payment_case_submissions(case_id,transaction_last_four,proof_file_id,created_at) VALUES(?,'1234','fake_file',?)").run(c,stamp);f.db.prepare("UPDATE payment_cases SET status='WAITING_VERIFICATION',submitted_at=? WHERE id=?").run(stamp,c);
 if(state==='REJECTED')cases.reject(c,{message:'Synthetic rejection',reason_category:'OTHER'},'Admin');
 else{assert.equal(cases.confirm(c,{payment_at:stamp,plan:'MONTH_1',amount_mmk:2000,payment_method:'KBZPAY'},'Admin').status,'CONFIRMED');assert.equal(cases.retry(c,{},'Admin').status,'COMPLETED');}

 assert.throws(()=>f.service.appendCustomerMessage(c,f.text(),customer));assert.throws(()=>f.service.prepareAdminMessage(c,{text:'Too late'},admin));assert.equal(f.service.listMessages(c).messages.length,2);
 f.service.appendSystemMessage(c,{text:'Internal synthetic closure note'});assert.equal(f.service.listMessages(c).messages.length,3);
 // Database also rejects direct bypass of the service.
 assert.throws(()=>f.db.prepare("INSERT INTO payment_case_messages(payment_case_id,telegram_user_id,sender_type,message_type,text_content,initial_delivery_state,admin_identifier,created_at) VALUES(?,101,'ADMIN','TEXT','bypass','PENDING_SEND','Admin',?)").run(c,stamp));
});
test('safe proof linkage, separate append-only link, cross-case rejection and rollback',t=>{
 const f=fixture(t),c=f.add(),other=f.add();const evidence=(caseId,file='fake_file')=>Number(f.db.prepare('INSERT INTO payment_case_submissions(case_id,proof_file_id,created_at) VALUES(?,?,?)').run(caseId,file,stamp).lastInsertRowid);
 const e=evidence(c);const photo=f.service.appendCustomerMessage(c,f.photo(),customer);f.service.linkEvidence(c,photo.id,e);assert.equal(f.service.listMessages(c).messages[0].evidence_id,e);
 for(const sql of ['DELETE FROM payment_case_message_evidence','UPDATE payment_case_message_evidence SET evidence_id=evidence_id','INSERT OR REPLACE INTO payment_case_message_evidence SELECT * FROM payment_case_message_evidence'])assert.throws(()=>f.db.exec(sql));
 const before=f.service.listMessages(c).messages.length;assert.throws(()=>f.service.appendCustomerMessage(c,{...f.photo(),evidence_id:evidence(other)},customer));assert.equal(f.service.listMessages(c).messages.length,before);
 assert.throws(()=>f.service.appendCustomerMessage(c,{...f.photo(),evidence_id:evidence(c,'different_file')},customer));
 const p=f.service.appendCustomerMessage(c,{...f.photo(),evidence_id:evidence(c)},customer);assert(p.evidence_id);
});
test('direct invalid SQL shapes/identity/SENT rejected, migration mismatch rollback',t=>{
 const f=fixture(t),c=f.add();const insert=f.db.prepare("INSERT INTO payment_case_messages(payment_case_id,telegram_user_id,sender_type,message_type,text_content,admin_identifier,initial_delivery_state,created_at) VALUES(?,?,'ADMIN',?,'text','Admin',?,?)");
 for(const [uid,type,state] of [[202,'TEXT','PENDING_SEND'],[101,'VIDEO','PENDING_SEND'],[101,'TEXT','SENT']])assert.throws(()=>insert.run(c,uid,type,state,stamp));
 f.db.exec('DROP INDEX payment_case_messages_order; DROP TRIGGER payment_case_messages_no_delete; CREATE TRIGGER payment_case_messages_no_delete BEFORE DELETE ON payment_case_messages BEGIN SELECT 1; END;');assert.throws(()=>migratePaymentCaseConversation(f.db),/Unexpected/);assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_case_messages_order'").get(),undefined);
});
test('missing foundation and nested migration fail without creating conversation tables',t=>{
 const db=new Database(':memory:');t.after(()=>db.close());assert.throws(()=>migratePaymentCaseConversation(db));assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_case_messages'").get(),undefined);db.transaction(()=>assert.throws(()=>migratePaymentCaseConversation(db),/own transaction/))();
});
