import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratePremium } from './premium-migration.js';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
const time='2026-01-01T00:00:00.000Z';
function fixture(t,ledger=true){
 const db=new Database(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE movies(id INTEGER PRIMARY KEY,title TEXT); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY,series_id INTEGER); INSERT INTO movies VALUES(1,'fake'); INSERT INTO series_episodes VALUES(1,1);");
 migratePremium(db);if(ledger)migratePremiumLedgerV3(db);
 db.prepare('INSERT INTO telegram_users(telegram_user_id,first_seen_at,last_seen_at,created_at,updated_at) VALUES(101,?,?,?,?)').run(time,time,time,time);
 return db;
}
function payment(db,pid=1,days=30){db.prepare(`INSERT INTO payments(id,telegram_user_id,payment_request_code,payment_method,amount_mmk,plan,plan_days,status,created_at,request_expires_at) VALUES(?,101,?,'KBZPAY',2000,'MONTH_1',?,'CONFIRMED',?,?)`).run(pid,'FAKE-'+pid,days,time,time);}
function effect(db,overrides={}){const row={telegram_user_id:101,event_order:1,revision:1,effect_type:'PAYMENT_GRANT',payment_id:1,effective_at:time,plan_days:30,admin_identifier:'test-admin',created_at:time,...overrides};return db.prepare(`INSERT INTO premium_membership_effects(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));}
const snapshot=db=>({schema:db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(),rows:['movies','series_episodes','telegram_users','payments','premium_memberships','membership_audit_log'].map(n=>db.prepare(`SELECT * FROM ${n}`).all())});
test('fresh/empty Phase 2 upgrade and repeat preserve unrelated data and guards',t=>{
 const db=fixture(t,false);const before=snapshot(db);migratePremiumLedgerV3(db);migratePremiumLedgerV3(db);
 assert.deepEqual(snapshot(db).rows,before.rows);
 for(const row of before.schema)assert.deepEqual(db.prepare('SELECT * FROM sqlite_master WHERE name=?').get(row.name),row);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM premium_membership_effects').get().n,0);
});
test('grant and correction shapes, timestamps and required fields',t=>{
 const db=fixture(t);payment(db);
 for(const values of [{plan_days:0},{plan_days:1.5},{payment_id:null},{effect_type:'BAD'},{event_order:0},{revision:0},{correction_start_at:time},{effective_at:'2026-02-30T00:00:00.000Z'},{created_at:'invalid'},{admin_identifier:' '}])assert.throws(()=>effect(db,values));
 for(const values of [{correction_expires_at:time},{reason:''},{correction_start_at:null},{plan_days:30},{payment_id:1}])assert.throws(()=>effect(db,{effect_type:'MEMBERSHIP_CORRECTION',payment_id:null,plan_days:null,correction_start_at:time,correction_expires_at:'2026-02-01T00:00:00.000Z',reason:'test',...values}));
 effect(db,{effect_type:'MEMBERSHIP_CORRECTION',payment_id:null,plan_days:null,correction_start_at:time,correction_expires_at:'2026-02-01T00:00:00.000Z',reason:'test'});
});
test('same event corrected revision preserves original, link, effective time and uniqueness',t=>{
 const db=fixture(t);payment(db);payment(db,2,90);const original=Number(effect(db).lastInsertRowid);const row=db.prepare('SELECT * FROM premium_membership_effects').get();
 assert.throws(()=>effect(db));
 assert.throws(()=>effect(db,{payment_id:2,plan_days:90,revision:3,supersedes_effect_id:original,reason:'fix'}));
 assert.throws(()=>effect(db,{payment_id:2,plan_days:90,revision:2,supersedes_effect_id:original,reason:'fix',effective_at:'2026-01-02T00:00:00.000Z'}));
 effect(db,{payment_id:2,plan_days:90,revision:2,supersedes_effect_id:original,reason:'fix'});
 assert.deepEqual(db.prepare('SELECT * FROM premium_membership_effects WHERE id=?').get(original),row);
 const current=db.prepare('SELECT * FROM premium_membership_effects ORDER BY revision DESC LIMIT 1').get();assert.equal(current.event_order,1);assert.equal(current.revision,2);assert.equal(current.supersedes_effect_id,original);
 migratePremiumLedgerV3(db);assert.equal(db.prepare('SELECT COUNT(*) n FROM premium_membership_effects').get().n,2);
 assert.throws(()=>effect(db,{payment_id:2,plan_days:90,revision:2,supersedes_effect_id:original,reason:'fix'}));
});
test('append only, payment/user foreign keys and sequence restrictions',t=>{
 const db=fixture(t);payment(db);effect(db);
 assert.throws(()=>db.exec('UPDATE premium_membership_effects SET plan_days=90'),/immutable/);
 assert.throws(()=>db.exec('DELETE FROM premium_membership_effects'),/immutable/);
 assert.throws(()=>db.exec('DELETE FROM telegram_users WHERE telegram_user_id=101'),/FOREIGN KEY/);
 assert.throws(()=>effect(db,{event_order:3,payment_id:999}));
 assert.throws(()=>effect(db,{event_order:2,payment_id:999}));
 assert.throws(()=>effect(db,{telegram_user_id:999,payment_id:1}));
 db.exec("UPDATE payments SET status='PENDING',request_expires_at='2000-01-01T00:00:00.000Z'");
 assert.throws(()=>db.exec('DELETE FROM payments WHERE id=1'),/FOREIGN KEY/);
 assert.deepEqual(db.pragma('foreign_key_check'),[]);
});
test('ambiguous histories refuse migration without any changes',t=>{
 for(const kind of ['payment','membership','audit']){
  const db=fixture(t,false);
  if(kind==='payment')payment(db);
  if(kind==='membership')db.prepare('INSERT INTO premium_memberships(telegram_user_id,start_at,expires_at,created_at,updated_at) VALUES(101,?,?,?,?)').run(time,time,time,time);
  if(kind==='audit')db.prepare("INSERT INTO membership_audit_log(telegram_user_id,action,field_name,reason,admin_identifier,created_at) VALUES(101,'test','test','test','test',?)").run(time);
  const before=snapshot(db);assert.throws(()=>migratePremiumLedgerV3(db),/history/);assert.deepEqual(snapshot(db),before);
 }
});
test('malformed schema/protections and partial DDL failures fail closed',t=>{
 const db=fixture(t,false);db.exec('CREATE TABLE premium_membership_effects(id INTEGER PRIMARY KEY)');const before=snapshot(db);assert.throws(()=>migratePremiumLedgerV3(db),/schema/);assert.deepEqual(snapshot(db),before);
 const valid=fixture(t);valid.exec('DROP TRIGGER premium_effects_no_update');const modified=snapshot(valid);assert.throws(()=>migratePremiumLedgerV3(valid),/protections/);assert.deepEqual(snapshot(valid),modified);
 const conflict=fixture(t,false);conflict.exec("CREATE TRIGGER premium_effects_no_delete BEFORE DELETE ON movies BEGIN SELECT RAISE(ABORT,'test'); END");const baseline=snapshot(conflict);assert.throws(()=>migratePremiumLedgerV3(conflict));assert.deepEqual(snapshot(conflict),baseline);
});
