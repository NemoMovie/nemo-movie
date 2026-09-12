import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratePremium } from './premium-migration.js';
const now = '2026-09-12T00:00:00.000Z';
function fixture(t) {
    // Disposable in-memory SQLite only; no filesystem DB/config access.
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec(`CREATE TABLE movies (id INTEGER PRIMARY KEY, title TEXT);
        CREATE TABLE series_episodes (id INTEGER PRIMARY KEY, series_id INTEGER, episode_number INTEGER);
        INSERT INTO movies VALUES (1, 'Synthetic movie'), (2, 'Synthetic series');
        INSERT INTO series_episodes VALUES (1, 2, 1);`);
    migratePremium(db);
    db.prepare('INSERT INTO telegram_users (telegram_user_id,first_seen_at,last_seen_at,created_at,updated_at) VALUES (?,?,?,?,?)').run(101,now,now,now,now);
    return db;
}
function payment(db, overrides = {}) {
    const row = { telegram_user_id:101,payment_request_code:'TEST-1',payment_method:'KBZPAY',amount_mmk:2000,plan:'MONTH_1',plan_days:30,status:'PENDING',created_at:now,request_expires_at:'2026-09-13T00:00:00.000Z',...overrides };
    db.prepare(`INSERT INTO payments (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
}
function membership(db, user = 101) {
    db.prepare('INSERT INTO premium_memberships (telegram_user_id,start_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,?)').run(user,now,'2026-10-12T00:00:00.000Z',now,now);
}
function audit(db, reason = 'Synthetic correction', user = 101) {
    db.prepare('INSERT INTO membership_audit_log (telegram_user_id,action,field_name,reason,admin_identifier,created_at) VALUES (?,?,?,?,?,?)').run(user,'CORRECT','expires_at',reason,'test-admin',now);
}
test('creates four tables; repeat migration preserves existing schema and rows', t => {
    const db=fixture(t);
    const schema=db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('movies','series_episodes') ORDER BY name").all();
    const movies=db.prepare('SELECT * FROM movies').all();
    const episodes=db.prepare('SELECT * FROM series_episodes').all();
    payment(db);membership(db);audit(db);
    migratePremium(db);
    for(const table of ['telegram_users','premium_memberships','payments','membership_audit_log']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,1);
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('movies','series_episodes') ORDER BY name").all(),schema);
    assert.deepEqual(db.prepare('SELECT * FROM movies').all(),movies);
    assert.deepEqual(db.prepare('SELECT * FROM series_episodes').all(),episodes);
    assert.equal(db.pragma('foreign_keys',{simple:true}),1);
    assert(!db.prepare('PRAGMA table_info(premium_memberships)').all().some(c=>c.name==='status'));
});
test('Telegram identity, membership and payment request codes are unique', t=>{
    const db=fixture(t);
    assert.throws(()=>db.prepare('INSERT INTO telegram_users SELECT NULL,telegram_user_id,username,first_name,last_name,first_seen_at,last_seen_at,created_at,updated_at FROM telegram_users').run(),/UNIQUE/);
    membership(db);assert.throws(()=>membership(db),/UNIQUE/);
    payment(db);assert.throws(()=>payment(db),/UNIQUE/);
});
test('payment enums and numeric constraints reject invalid values',t=>{
    const db=fixture(t);
    for(const row of [{payment_method:'OTHER'},{plan:'OTHER'},{status:'OTHER'},
        ...[0,-1,1.5].map(amount_mmk=>({amount_mmk})),
        ...[0,-1,1.5].map(plan_days=>({plan_days})),
        ...[-1,2001,0.5].map(refund_amount_mmk=>({refund_amount_mmk}))]) assert.throws(()=>payment(db,row),/CHECK/);
    for(const key of ['telegram_user_id','payment_request_code','payment_method','amount_mmk','plan','plan_days','status','created_at','request_expires_at']) assert.throws(()=>payment(db,{[key]:null}),/NOT NULL/);
});
test('approved methods/plans/statuses and refund bounds accepted; transaction reference can repeat',t=>{
    const db=fixture(t);let code=0;
    for(const payment_method of ['KBZPAY','WAVE_MONEY','AYA_PAY']) payment(db,{payment_request_code:'T'+ ++code,payment_method});
    for(const [plan,plan_days,amount_mmk] of [['MONTH_1',30,2000],['MONTH_3',90,5000],['MONTH_6',180,9000],['YEAR_1',365,17000]]) payment(db,{payment_request_code:'T'+ ++code,plan,plan_days,amount_mmk});
    for(const status of ['PENDING','CONFIRMED','EXPIRED','VOID','CORRECTED','REFUNDED']) payment(db,{payment_request_code:'T'+ ++code,status,transaction_reference:'synthetic-reference'});
    for(const refund_amount_mmk of [null,0,2000]) payment(db,{payment_request_code:'T'+ ++code,refund_amount_mmk});
});
test('each relationship rejects missing parent and restricts parent deletion',t=>{
    const db=fixture(t);
    for(const insert of [()=>membership(db,999),()=>payment(db,{telegram_user_id:999}),()=>audit(db,'test',999)]) assert.throws(insert,/FOREIGN KEY/);
    for(const insert of [()=>membership(db),()=>payment(db),()=>audit(db)]) {
        const check=db.transaction(()=>{insert();assert.throws(()=>db.prepare('DELETE FROM telegram_users WHERE telegram_user_id=101').run(),/FOREIGN KEY/);throw new Error('rollback fixture');});
        assert.throws(check,/rollback fixture/);
    }
});
test('history deletion blocked and blank audit reason rejected',t=>{
    const db=fixture(t);payment(db);audit(db);
    assert.throws(()=>db.exec('DELETE FROM payments'),/cannot be deleted/);
    assert.throws(()=>db.exec('DELETE FROM membership_audit_log'),/cannot be deleted/);
    assert.throws(()=>audit(db,'   '),/CHECK/);
});
test('requires existing catalogue and rejects outer transaction before FK configuration',t=>{
    const db=new Database(':memory:');t.after(()=>db.close());
    assert.throws(()=>migratePremium(db),/catalogue/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n,0);
    assert.throws(()=>db.transaction(()=>migratePremium(db))(),/own transaction/);
});
function legacyFixture(t) {
    const db=fixture(t);
    const sql=db.prepare("SELECT sql FROM sqlite_master WHERE name='payments'").get().sql
        .replace("'CONFIRMED', 'EXPIRED', 'VOID'", "'CONFIRMED', 'VOID'")
        .replace(' request_expires_at TEXT NOT NULL,','');
    const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE name='payments_no_delete'").get().sql;
    db.exec('DROP TRIGGER payments_no_delete; DROP TABLE payments;');
    db.exec(sql);db.exec(trigger);
    const insert=db.prepare(`INSERT INTO payments (id,telegram_user_id,payment_request_code,payment_method,amount_mmk,plan,plan_days,status,created_at,transaction_reference,admin_note,refund_amount_mmk) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run(17,101,'OLD-1','KBZPAY',2000,'MONTH_1',30,'CONFIRMED','2024-02-28T12:34:56.789Z','same','Preserve note',100);
    insert.run(29,101,'OLD-2','KBZPAY',2000,'MONTH_1',30,'PENDING','2024-12-31T00:00:00.000Z','same',null,null);
    return db;
}
test('v1 rows/IDs and history protections survive v2 and repeated upgrade',t=>{
    const db=legacyFixture(t);const before=db.prepare('SELECT * FROM payments ORDER BY id').all();
    const movies=db.prepare('SELECT * FROM movies').all();const episodes=db.prepare('SELECT * FROM series_episodes').all();
    migratePremium(db);migratePremium(db);
    const after=db.prepare('SELECT * FROM payments ORDER BY id').all();
    assert.deepEqual(after.map(({request_expires_at,...row})=>row),before);
    assert.deepEqual(after.map(r=>r.request_expires_at),['2024-02-29T12:34:56.789Z','2025-01-01T00:00:00.000Z']);
    assert.deepEqual(db.prepare('SELECT * FROM movies').all(),movies);assert.deepEqual(db.prepare('SELECT * FROM series_episodes').all(),episodes);
    payment(db,{status:'EXPIRED',transaction_reference:'same'});
    assert.throws(()=>payment(db,{payment_request_code:'OLD-1'}),/UNIQUE/);
    assert.throws(()=>payment(db,{payment_request_code:'NULL-EXP',request_expires_at:null}),/NOT NULL/);
    assert.throws(()=>db.exec('DELETE FROM payments'),/cannot be deleted/);
    audit(db);assert.throws(()=>db.exec('DELETE FROM membership_audit_log'),/cannot be deleted/);
    assert.throws(()=>db.exec('DELETE FROM telegram_users WHERE telegram_user_id=101'),/FOREIGN KEY/);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
});
test('invalid legacy timestamps fail without changing rows or schema',t=>{
    const db=legacyFixture(t);
    for(const value of ['invalid','2024-02-30T00:00:00.000Z','2024-01-01','2024-01-01T00:00:00+07:00']) {
        db.prepare('UPDATE payments SET created_at=? WHERE id=17').run(value);
        const before=db.prepare('SELECT * FROM payments').all();const schema=db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
        assert.throws(()=>migratePremium(db),/timestamp/);
        assert.deepEqual(db.prepare('SELECT * FROM payments').all(),before);
        assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(),schema);
    }
});
test('unexpected schema/index/dependency fails closed without history loss',t=>{
    const db=legacyFixture(t);db.exec('CREATE INDEX custom_payment_index ON payments(status)');
    assert.throws(()=>migratePremium(db),/dependencies/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments').get().n,2);
    db.exec('DROP INDEX custom_payment_index; ALTER TABLE payments ADD COLUMN unexpected TEXT');
    assert.throws(()=>migratePremium(db),/schema/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments').get().n,2);
});
