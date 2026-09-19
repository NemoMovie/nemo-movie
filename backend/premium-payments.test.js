import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratePremium } from './premium-migration.js';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
import { createPremiumService } from './premium-service.js';

function fixture(t) {
    const db=new Database(':memory:');t.after(()=>db.close());
    db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY);CREATE TABLE series_episodes(id INTEGER PRIMARY KEY);');
    migratePremium(db);migratePremiumLedgerV3(db);
    const service=createPremiumService(db,{clock:()=>Date.parse('2026-01-02T00:00:00.000Z')});
    service.upsertUser({telegram_user_id:101,username:'Alice_%'});
    service.upsertUser({telegram_user_id:202,username:'Bob'});
    const insert=db.prepare(`INSERT INTO payments (telegram_user_id,payment_request_code,payment_method,amount_mmk,plan,plan_days,status,created_at,request_expires_at,payment_at,confirmed_at,admin_note,transaction_reference)
        VALUES (?,?,?,2000,'MONTH_1',30,?,?,?,?,?,'Synthetic note','Synthetic reference')`);
    const add=(status,method='KBZPAY',uid=101,paymentAt=null,confirmedAt=null,createdAt='2026-01-01T00:00:00.000Z')=>{
        const n=db.prepare('SELECT COUNT(*) n FROM payments').get().n;
        return Number(insert.run(uid,'TEST-'+n,method,status,createdAt,'2026-01-03T00:00:00.000Z',paymentAt,confirmedAt).lastInsertRowid);
    };
    return {db,service,add};
}

test('payment list defaults, bounded pages, totals and empty boundaries',t=>{
    const {service,add}=fixture(t);
    for(let i=0;i<25;i++)add('CONFIRMED');
    const first=service.payments();assert.equal(first.page,1);assert.equal(first.limit,20);
    assert.equal(first.records.length,20);assert.equal(first.total,25);assert.equal(first.totalPages,2);
    assert.equal(first.records[0].id,25);assert.equal(first.records[19].id,6);
    const second=service.payments({page:'2'});assert.deepEqual(second.records.map(p=>p.id),[5,4,3,2,1]);
    assert.equal(service.payments({page:'3'}).records.length,0);
    assert.equal(service.payments({limit:'100'}).records.length,25);
    assert.equal(service.payments({search:'not-found'}).totalPages,0);
});

test('permanent statuses, methods, literal search and exclusion of unpaid requests',t=>{
    const {service,db,add}=fixture(t);
    add('CONFIRMED','KBZPAY');add('CORRECTED','WAVE_MONEY',202);add('VOID','AYA_PAY');add('REFUNDED');
    add('PENDING');const expired=add('EXPIRED');
    db.prepare('UPDATE payments SET request_expires_at=? WHERE id=?').run('2001-01-01T00:00:00.000Z',expired);
    assert.equal(service.payments({status:'ALL',method:'ALL'}).total,4);
    for(const status of ['CONFIRMED','CORRECTED','VOID']){
        const r=service.payments({status});assert.equal(r.total,1);assert.equal(r.records[0].status,status);
    }
    for(const [method,total] of [['KBZPAY',2],['WAVE_MONEY',1],['AYA_PAY',1]])assert.equal(service.payments({method}).total,total);
    assert.equal(service.payments({search:'TEST-1'}).records[0].status,'CORRECTED');
    assert.equal(service.payments({search:'202'}).total,1);
    assert.equal(service.payments({search:' Alice_% '}).total,3);
    assert.equal(service.payments({search:'%'}).total,3);
    assert.equal(service.payments({search:"' OR 1=1 --"}).total,0);
    assert.equal(service.payments({status:'CORRECTED',method:'AYA_PAY'}).total,0);
    assert.equal(service.cleanup(),1);assert.equal(service.payments().total,4);
});

test('payment chronology, date fallback and deterministic tie ordering',t=>{
    const {service,add}=fixture(t);
    const jan=add('CONFIRMED','KBZPAY',101,'2025-01-01T00:00:00.000Z');
    const feb=add('CORRECTED','KBZPAY',101,null,'2025-02-01T00:00:00.000Z');
    const march=add('VOID','KBZPAY',101,null,null,'2025-03-01T00:00:00.000Z');
    const tie=add('VOID','KBZPAY',101,null,null,'2025-03-01T00:00:00.000Z');
    assert.deepEqual(service.payments().records.map(p=>p.id),[tie,march,feb,jan]);
    assert.deepEqual(service.payments({sort:'oldest'}).records.map(p=>p.id),[jan,feb,march,tie]);
});

test('payment query validation rejects malformed and unsafe input',t=>{
    const {service}=fixture(t);
    for(const value of ['0','-1','1.5','abc','9007199254740992',[],{}]){
        for(const key of ['page','limit'])assert.throws(()=>service.payments({[key]:value}),e=>e.status===400);
    }
    for(const q of [{limit:'101'},{page:'9007199254740991',limit:'20'},
        {status:'REFUNDED'},{status:'PENDING'},{status:'EXPIRED'},{status:'bad'},
        {method:'bad'},{sort:'bad'},{search:[]},{search:'x'.repeat(151)},
        {unknown:'x'},{status:[]},{method:{}},{sort:[]}])assert.throws(()=>service.payments(q),e=>e.status===400);
    assert.doesNotThrow(()=>service.payments({search:'x'.repeat(150)}));
});

test('explicit field allowlist and unchanged existing APIs; listing is read-only',t=>{
    const {service,db,add}=fixture(t);add('CONFIRMED');add('CORRECTED');add('VOID');add('PENDING');
    const history=service.history(101),pending=service.pending(),stats=service.stats();
    const changes=db.prepare('SELECT total_changes() n').get().n;
    const record=service.payments().records[0];
    assert.deepEqual(Object.keys(record).sort(),['id','payment_request_code','telegram_user_id','username','plan','plan_days','payment_method','amount_mmk','status','payment_at','confirmed_at','created_at','admin_note','transaction_reference'].sort());
    assert.equal(record.admin_note,'Synthetic note');
    assert.equal(record.transaction_reference,'Synthetic reference');
    assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
    assert.deepEqual(service.history(101),history);assert.equal(history.total,4);
    assert.deepEqual(service.pending(),pending);assert.equal(pending.total,1);
    assert.deepEqual(service.stats(),stats);assert.equal(stats.totalIncome,2000);
});
