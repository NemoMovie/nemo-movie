import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratePremium } from './premium-migration.js';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
import { createPremiumService } from './premium-service.js';
import { migratePaymentCases } from './payment-case-migration.js';
const time='2026-01-01T00:00:00.000Z';
function fixture(t){
 const db=new Database(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY); INSERT INTO movies VALUES(1); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY); INSERT INTO series_episodes VALUES(2);');
 migratePremium(db);migratePremiumLedgerV3(db);
 const service=createPremiumService(db,{clock:()=>Date.parse(time)});
 service.upsertUser({telegram_user_id:101,username:'synthetic'});
 migratePaymentCases(db);return {db,service};
}
const add=db=>Number(db.prepare(`INSERT INTO payment_cases(telegram_user_id,plan,plan_days,amount_mmk,payment_method,payment_account_reference,created_at,updated_at) VALUES(101,'MONTH_1',30,2000,'KBZPAY','test-account-v1',?,?)`).run(time,time).lastInsertRowid);
const proof=(db,id,last='0123')=>db.prepare('INSERT INTO payment_case_submissions(case_id,transaction_last_four,proof_file_id,created_at) VALUES(?,?,?,?)').run(id,last,'fake-file',time);
const submit=(db,id)=>db.prepare("UPDATE payment_cases SET status='WAITING_VERIFICATION',submitted_at=? WHERE id=?").run(time,id);
const confirm=(db,id)=>db.prepare("UPDATE payment_cases SET status='CONFIRMED',confirmed_at=?,confirmed_by='synthetic-admin' WHERE id=?").run(time,id);

test('fresh isolated migration, repeated migration, same-user cases and legacy preservation',t=>{
 const {db,service}=fixture(t);const p=service.request({telegram_user_id:101,plan:'MONTH_1',payment_method:'KBZPAY'});
 service.confirm(p.id,{transaction_reference:'fake-reference',payment_at:time},'fake-admin');
 const tables=['movies','series_episodes','telegram_users','payments','premium_memberships','premium_membership_effects','membership_audit_log'];
 const snapshot=()=>tables.map(n=>[db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(n),db.prepare(`SELECT * FROM ${n}`).all()]);
 const before=snapshot();add(db);add(db);migratePaymentCases(db);migratePaymentCases(db);
 assert.deepEqual(snapshot(),before);assert.equal(db.prepare('SELECT count(*) n FROM payment_cases').get().n,2);
 assert.match(service.lookup(p.payment_request_code).payment_request_code,/^NM-/);
});
test('allowed states, permanent rejection and new attempt',t=>{
 const {db}=fixture(t);const id=add(db);proof(db,id);submit(db,id);
 db.prepare("UPDATE payment_cases SET status='NEEDS_CUSTOMER_ACTION' WHERE id=?").run(id);submit(db,id);
 db.prepare("UPDATE payment_cases SET status='REJECTED',rejected_at=?,rejected_by='admin',rejection_reason='fake reason' WHERE id=?").run(time,id);
 assert.throws(()=>db.prepare('DELETE FROM payment_cases WHERE id=?').run(id));
 assert.throws(()=>db.prepare("UPDATE payment_cases SET rejection_reason='changed' WHERE id=?").run(id));
 assert.notEqual(add(db),id);
});
test('confirmation/completion require evidence and matching ledger, preserve financial fields',t=>{
 const {db,service}=fixture(t);const id=add(db);assert.throws(()=>submit(db,id));proof(db,id);submit(db,id);confirm(db,id);
 for(const sql of ["DELETE FROM payment_cases", "UPDATE payment_cases SET amount_mmk=1", "UPDATE payment_cases SET confirmed_by='other'", "UPDATE payment_cases SET status='WAITING_PAYMENT'"])assert.throws(()=>db.exec(sql));
 assert.throws(()=>proof(db,id));
 assert.throws(()=>db.prepare("UPDATE payment_cases SET status='COMPLETED',completed_at=?,payment_id=99 WHERE id=?").run(time,id));
 const p=service.request({telegram_user_id:101,plan:'MONTH_1',payment_method:'KBZPAY'});
 service.confirm(p.id,{transaction_reference:'fake-reference',payment_at:time},'fake-admin');
 db.prepare("UPDATE payment_cases SET status='COMPLETED',completed_at=?,payment_id=? WHERE id=?").run(time,p.id,id);
 assert.throws(()=>db.exec('DELETE FROM payment_cases'));assert.throws(()=>db.exec("UPDATE payment_cases SET updated_at=updated_at"));
 assert.equal(db.prepare('SELECT status FROM payment_cases').get().status,'COMPLETED');
 const second=add(db);proof(db,second);submit(db,second);confirm(db,second);
 assert.throws(()=>db.prepare("UPDATE payment_cases SET status='COMPLETED',completed_at=?,payment_id=? WHERE id=?").run(time,p.id,second));
});
test('append-only proof/last-four history and latest projection',t=>{
 const {db}=fixture(t);const id=add(db);proof(db,id);proof(db,id,'9876');
 assert.equal(db.prepare('SELECT transaction_last_four FROM payment_cases_latest').get().transaction_last_four,'9876');
 assert.deepEqual(db.prepare('SELECT transaction_last_four FROM payment_case_submissions ORDER BY id').all().map(r=>r.transaction_last_four),['0123','9876']);
 for(const sql of ['DELETE FROM payment_case_submissions',"UPDATE payment_case_submissions SET transaction_last_four='1111'",
 `INSERT OR REPLACE INTO payment_case_submissions(id,case_id,transaction_last_four,created_at) VALUES(1,${id},'9999','${time}')`])assert.throws(()=>db.exec(sql));
});
test('invalid states, transitions, values, timestamp, foreign key and REPLACE fail closed',t=>{
 const {db}=fixture(t);const id=add(db);
 for(const state of ['BAD','COMPLETED','CONFIRMED'])assert.throws(()=>db.prepare('UPDATE payment_cases SET status=?').run(state));
 for(const value of ['bad','2026-02-30T00:00:00.000Z',null])assert.throws(()=>db.prepare('UPDATE payment_cases SET updated_at=?').run(value));
 assert.throws(()=>proof(db,id,'123x'));assert.throws(()=>proof(db,999));
 assert.throws(()=>db.exec(`INSERT OR REPLACE INTO payment_cases SELECT * FROM payment_cases WHERE id=${id}`));
 assert.throws(()=>db.exec("UPDATE payment_cases SET plan='YEAR_1'"));
});
test('schema mismatch fails transactionally without partial additions',t=>{
 const {db}=fixture(t);db.exec('DROP VIEW payment_cases_latest; DROP INDEX payment_cases_user; CREATE VIEW payment_cases_latest AS SELECT 1;');
 assert.throws(()=>migratePaymentCases(db),/Unexpected/);
 assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_cases_user'").get(),undefined);
 assert.equal(db.prepare('SELECT count(*) n FROM movies').get().n,1);
});
test('missing prerequisites and nested transactions are refused',t=>{
 const db=new Database(':memory:');t.after(()=>db.close());assert.throws(()=>migratePaymentCases(db));
 assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_cases'").get(),undefined);
 db.transaction(()=>assert.throws(()=>migratePaymentCases(db),/own transaction/))();
});
