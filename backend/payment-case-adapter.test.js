import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migratePremium } from './premium-migration.js';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
import { migratePaymentCases } from './payment-case-migration.js';
import { migratePaymentCaseAdapter } from './payment-case-adapter-migration.js';
import { createPaymentCaseAdapter } from './payment-case-adapter.js';
import { createPremiumService } from './premium-service.js';
const DAY=86400000, initial='2026-01-01T00:00:00.000Z';
function fixture(t,filename=':memory:'){
 const db=new Database(filename);t.after(()=>{if(db.open)db.close();});
 db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY); INSERT INTO movies VALUES(1); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY);');
 migratePremium(db);migratePremiumLedgerV3(db);migratePaymentCases(db);migratePaymentCaseAdapter(db);
 let time=Date.parse(initial);const clock=()=>time;
 const s=createPremiumService(db,{clock});s.upsertUser({telegram_user_id:101,username:'fake'});
 const adapter=createPaymentCaseAdapter(db,{clock});
 const now=()=>new Date(time).toISOString();
 function add(evidence=true){
  const id=Number(db.prepare(`INSERT INTO payment_cases(telegram_user_id,plan,plan_days,amount_mmk,payment_method,payment_account_reference,created_at,updated_at) VALUES(101,'MONTH_1',30,2000,'KBZPAY','fake-account',?,?)`).run(now(),now()).lastInsertRowid);
  if(evidence){db.prepare("INSERT INTO payment_case_submissions(case_id,transaction_last_four,proof_file_id,created_at) VALUES(?,'1234','fake-file',?)").run(id,now());db.prepare("UPDATE payment_cases SET status='WAITING_VERIFICATION',submitted_at=? WHERE id=?").run(now(),id);}
  return id;
 }
 const data=(reference='FAKE-FULL-1234')=>({transaction_reference:reference,payment_at:now(),plan:'MONTH_1',amount_mmk:2000,payment_method:'KBZPAY'});
 const count=table=>db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
 return {db,s,adapter,add,data,count,now,advance:days=>time+=days*DAY};
}
const failGrant=db=>db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON premium_membership_effects BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");

test('new activation, internal identifier hidden, completed replay and one financial effect',t=>{
 const f=fixture(t),id=f.add(),data=f.data();const result=f.adapter.confirmPaymentCase(id,data,'test-admin');
 assert.equal(result.status,'COMPLETED');assert(!JSON.stringify(result).includes('NM-'));
 assert.equal(f.s.status(101).start_at,initial);assert.equal(Date.parse(f.s.status(101).expires_at)-Date.parse(initial),30*DAY);
 assert.deepEqual(f.adapter.confirmPaymentCase(id,data,'another-admin'),result);
 assert.equal(f.count('payments'),1);assert.equal(f.count('premium_membership_effects'),1);
 const p=f.db.prepare('SELECT * FROM payments').get();assert.match(p.payment_request_code,/^NM-[A-HJ-NP-Z2-9]{6}$/);assert.equal(f.s.lookup(p.payment_request_code).status,'CONFIRMED');
 assert.equal(f.db.prepare('SELECT confirmed_by FROM payment_cases').get().confirmed_by,'test-admin');
});
for(const [label,elapsed,expected] of [['active',10,60],['expired',40,70]])test(label+' renewal reuses existing engine',t=>{
 const f=fixture(t);const p=f.s.request({telegram_user_id:101,plan:'MONTH_1',payment_method:'KBZPAY'});
 f.s.confirm(p.id,{transaction_reference:'FAKE-LEGACY',payment_at:f.now()},'admin');f.advance(elapsed);
 assert.equal(f.adapter.confirmPaymentCase(f.add(),f.data(),'admin').status,'COMPLETED');
 assert.equal(Date.parse(f.s.status(101).expires_at),Date.parse(initial)+expected*DAY);
 assert.equal(f.s.status(101).start_at,label==='active'?initial:f.now());
});
test('durable CONFIRMED before grant; rollback and delayed retry do not double grant',t=>{
 const f=fixture(t),id=f.add(),data=f.data();
 f.db.exec("CREATE TRIGGER require_confirmed BEFORE INSERT ON premium_membership_effects BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM payment_cases WHERE status='CONFIRMED') THEN RAISE(ABORT,'not confirmed') END; END;");
 failGrant(f.db);
 assert.equal(f.adapter.confirmPaymentCase(id,data,'admin').status,'CONFIRMED');
 assert.equal(f.count('payment_case_verifications'),1);assert.equal(f.count('payments'),0);assert.equal(f.count('premium_membership_effects'),0);assert.equal(f.count('premium_memberships'),0);
 f.advance(2);assert.equal(f.adapter.confirmPaymentCase(id,data,'admin').status,'CONFIRMED');
 f.db.exec('DROP TRIGGER injected_failure');
 assert.equal(f.adapter.confirmPaymentCase(id,data,'admin').status,'COMPLETED');
 assert.equal(f.s.status(101).start_at,initial);assert.equal(Date.parse(f.s.status(101).expires_at),Date.parse(initial)+30*DAY);
 f.adapter.confirmPaymentCase(id,data,'admin');assert.equal(f.count('payments'),1);assert.equal(f.count('premium_membership_effects'),1);
});
test('failure linking COMPLETED rolls back successful nested engine writes',t=>{
 const f=fixture(t),id=f.add(),data=f.data();
 f.db.exec("CREATE TRIGGER injected_failure BEFORE UPDATE ON payment_cases WHEN NEW.status='COMPLETED' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
 assert.equal(f.adapter.confirmPaymentCase(id,data,'admin').status,'CONFIRMED');assert.equal(f.count('payments'),0);assert.equal(f.count('premium_memberships'),0);
 f.db.exec('DROP TRIGGER injected_failure');assert.equal(f.adapter.confirmPaymentCase(id,data,'admin').status,'COMPLETED');
});
test('verification update failure rolls back reservation and confirmation together',t=>{
 const f=fixture(t),id=f.add();f.db.exec("CREATE TRIGGER injected_failure BEFORE UPDATE ON payment_cases WHEN NEW.status='CONFIRMED' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
 assert.throws(()=>f.adapter.confirmPaymentCase(id,f.data(),'admin'));assert.equal(f.count('payment_case_verifications'),0);assert.equal(f.count('payments'),0);
 assert.equal(f.db.prepare('SELECT status FROM payment_cases').get().status,'WAITING_VERIFICATION');
});
test('authoritative reference and purchase/evidence/state validation',t=>{
 const f=fixture(t),id=f.add();
 for(const patch of [{transaction_reference:'1234'},{amount_mmk:1},{plan:'YEAR_1'},{payment_method:'AYA_PAY'},{payment_at:'bad'},{payment_at:'2099-01-01T00:00:00.000Z'},{extra:'bad'}])assert.throws(()=>f.adapter.confirmPaymentCase(id,{...f.data(),...patch},'admin'));
 assert.throws(()=>f.adapter.confirmPaymentCase(id,f.data(),''));
 assert.throws(()=>f.adapter.confirmPaymentCase(f.add(false),f.data(),'admin'));
 f.db.prepare("UPDATE payment_cases SET status='NEEDS_CUSTOMER_ACTION' WHERE id=?").run(id);
 assert.throws(()=>f.adapter.confirmPaymentCase(id,f.data(),'admin'));
 f.db.prepare("UPDATE payment_cases SET status='WAITING_VERIFICATION' WHERE id=?").run(id);
 f.db.prepare("UPDATE payment_cases SET status='REJECTED',rejected_at=?,rejected_by='admin',rejection_reason='fake' WHERE id=?").run(f.now(),id);
 assert.throws(()=>f.adapter.confirmPaymentCase(id,f.data(),'admin'));assert.equal(f.count('payments'),0);
});
test('legacy and case duplicate reference protection, last-four reused safely',t=>{
 const f=fixture(t);const p=f.s.request({telegram_user_id:101,plan:'MONTH_1',payment_method:'KBZPAY'});
 f.s.confirm(p.id,{transaction_reference:'FAKE-EXISTING',payment_at:f.now()},'admin');
 assert.throws(()=>f.adapter.confirmPaymentCase(f.add(),f.data('FAKE-EXISTING'),'admin'));
 const first=f.add();failGrant(f.db);f.adapter.confirmPaymentCase(first,f.data(),'admin');
 assert.throws(()=>f.adapter.confirmPaymentCase(f.add(),f.data(),'admin'));
 const legacy=f.s.request({telegram_user_id:101,plan:'MONTH_1',payment_method:'KBZPAY'});
 assert.throws(()=>f.s.confirm(legacy.id,{transaction_reference:'FAKE-FULL-1234',payment_at:f.now()},'admin'),/reserved/);
 f.db.exec('DROP TRIGGER injected_failure');
 assert.equal(f.adapter.confirmPaymentCase(first,f.data(),'admin').status,'COMPLETED');
 assert.equal(f.adapter.confirmPaymentCase(f.add(),f.data('FAKE-OTHER-1234'),'admin').status,'COMPLETED');
 assert.equal(f.count('premium_membership_effects'),3);
});
test('verification immutable, retry data fixed, migration idempotent and legacy rows unchanged',t=>{
 const f=fixture(t),id=f.add();failGrant(f.db);f.adapter.confirmPaymentCase(id,f.data(),'admin');
 for(const sql of ['DELETE FROM payment_case_verifications',"UPDATE payment_case_verifications SET transaction_reference='changed'",'INSERT OR REPLACE INTO payment_case_verifications SELECT * FROM payment_case_verifications'])assert.throws(()=>f.db.exec(sql));
 assert.throws(()=>f.adapter.confirmPaymentCase(id,f.data('DIFFERENT'),'admin'));
 const before=f.db.prepare('SELECT * FROM payment_case_verifications').all();migratePaymentCaseAdapter(f.db);migratePaymentCases(f.db);assert.deepEqual(f.db.prepare('SELECT * FROM payment_case_verifications').all(),before);
 assert.throws(()=>f.db.transaction(()=>f.adapter.confirmPaymentCase(id,f.data(),'admin'))(),/independent/);
});
test('durable restart and two connection retries share one grant',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nemo-case-adapter-'));const filename=path.join(root,'synthetic.db');
 t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('nemo-case-adapter-'));fs.rmSync(root,{recursive:true});});
 const f=fixture(t,filename),id=f.add(),data=f.data();failGrant(f.db);f.adapter.confirmPaymentCase(id,data,'admin');f.db.exec('DROP TRIGGER injected_failure');f.db.close();
 const a=new Database(filename,{fileMustExist:true}),b=new Database(filename,{fileMustExist:true});
 try{
  const one=createPaymentCaseAdapter(a,{clock:()=>Date.parse(initial)+DAY});
  const two=createPaymentCaseAdapter(b,{clock:()=>Date.parse(initial)+DAY});
  assert.deepEqual(one.confirmPaymentCase(id,data,'admin'),two.confirmPaymentCase(id,data,'admin'));
  assert.equal(a.prepare('SELECT count(*) n FROM premium_membership_effects').get().n,1);
 }finally{a.close();b.close();}
});

test('later unrelated ledger activity is preserved; delayed case fails closed for review',t=>{
 const f=fixture(t),id=f.add(),data=f.data();failGrant(f.db);f.adapter.confirmPaymentCase(id,data,'admin');f.db.exec('DROP TRIGGER injected_failure');f.advance(1);
 const p=f.s.request({telegram_user_id:101,plan:'MONTH_1',payment_method:'KBZPAY'});f.s.confirm(p.id,{transaction_reference:'LATER-VALID',payment_at:f.now()},'admin');
 const before=f.s.status(101);assert.equal(f.adapter.confirmPaymentCase(id,data,'admin').status,'CONFIRMED');assert.deepEqual(f.s.status(101),before);assert.equal(f.count('premium_membership_effects'),1);
});
test('adapter migration rejects unknown schema transactionally and cannot invent old verification',t=>{
 const f=fixture(t);f.db.exec('DROP TRIGGER payment_case_verifications_no_delete; CREATE TRIGGER payment_case_verifications_no_delete BEFORE DELETE ON payment_case_verifications BEGIN SELECT 1; END;');
 assert.throws(()=>migratePaymentCaseAdapter(f.db),/Unexpected/);
 const db=new Database(':memory:');try{
  db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY);');migratePremium(db);migratePremiumLedgerV3(db);migratePaymentCases(db);
  const s=createPremiumService(db,{clock:()=>Date.parse(initial)});s.upsertUser({telegram_user_id:101});
  db.prepare(`INSERT INTO payment_cases(telegram_user_id,plan,plan_days,amount_mmk,payment_method,payment_account_reference,created_at,updated_at) VALUES(101,'MONTH_1',30,2000,'KBZPAY','fake',?,?)`).run(initial,initial);
  db.prepare("INSERT INTO payment_case_submissions(case_id,transaction_last_four,proof_file_id,created_at) VALUES(1,'1234','fake',?)").run(initial);
  db.prepare("UPDATE payment_cases SET status='WAITING_VERIFICATION',submitted_at=?").run(initial);
  db.prepare("UPDATE payment_cases SET status='CONFIRMED',confirmed_at=?,confirmed_by='admin'").run(initial);
  assert.throws(()=>migratePaymentCaseAdapter(db),/manual review/);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_case_verifications'").get(),undefined);
 }finally{db.close();}
});
