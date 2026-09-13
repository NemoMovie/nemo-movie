import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
import { migratePremium } from './premium-migration.js';
import { createPremiumService, PLANS } from './premium-service.js';
import { registerPremiumRoutes } from './premium-routes.js';
function fixture(t){const db=new Database(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY);CREATE TABLE series_episodes(id INTEGER PRIMARY KEY);');migratePremium(db);migratePremiumLedgerV3(db);let time=Date.parse('2001-01-01T00:00:00.000Z');const s=createPremiumService(db,{clock:()=>time});s.upsertUser({telegram_user_id:101,username:'Tester',first_name:'Fake',last_name:'User'});return {db,s,advance:days=>time+=days*86400000,now:()=>new Date(time).toISOString()};}
const request=(s,plan='MONTH_1',method='KBZPAY',uid=101)=>s.request({telegram_user_id:uid,plan,payment_method:method});
const confirm=(f,p,ref='reference')=>f.s.confirm(p.id,{transaction_reference:ref,payment_at:f.now()},'admin-test');
test('plans, unique codes, 24 hours, reuse, expiry cleanup and collision retry',t=>{
 const f=fixture(t);assert.deepEqual(PLANS,{MONTH_1:[30,2000],MONTH_3:[90,5000],MONTH_6:[180,9000],YEAR_1:[365,17000]});
 const p=request(f.s);assert.match(p.payment_request_code,/^NM-[A-HJ-NP-Z2-9]{6}$/);assert.equal(Date.parse(p.request_expires_at)-Date.parse(p.created_at),86400000);assert.equal(request(f.s,'YEAR_1').id,p.id);
 f.advance(1);assert.throws(()=>confirm(f,p),/valid/);assert.equal(f.s.pending().total,0);assert.equal(f.s.lookup(p.payment_request_code).status,'EXPIRED');assert.equal(f.s.cleanup(),1);
 const service=createPremiumService(f.db,{clock:()=>Date.parse(f.now()),random:()=>0});const first=request(service);assert.equal(first.payment_request_code,'NM-AAAAAA');service.void(first.id,{reason:'test'},'admin');
 let calls=0;const collisions=createPremiumService(f.db,{clock:()=>Date.parse(f.now()),random:()=>calls++<6?0:1});assert.equal(request(collisions).payment_request_code,'NM-BBBBBB');
});
test('activation, reminders, early and expired renewal, idempotency, duplicate references',t=>{
 const f=fixture(t);const p=request(f.s);const a=confirm(f,p);assert.equal(a.membership.start_at,f.now());assert.equal(Date.parse(a.membership.expires_at)-Date.parse(f.now()),30*86400000);
 assert.deepEqual(confirm(f,p).membership,a.membership);f.db.exec("UPDATE premium_memberships SET reminder_2d_sent_at='sent',reminder_1d_sent_at='sent'");
 const renewal=request(f.s);assert.throws(()=>confirm(f,renewal),/already confirmed/);const b=confirm(f,renewal,'second');assert.equal(b.membership.start_at,a.membership.start_at);assert.equal(Date.parse(b.membership.expires_at)-Date.parse(a.membership.expires_at),30*86400000);assert.equal(b.membership.reminder_1d_sent_at,null);assert.equal(b.membership.reminder_2d_sent_at,null);
 const other=request(f.s,'MONTH_1','AYA_PAY');confirm(f,other,'reference');f.advance(100);const c=confirm(f,request(f.s),'late');assert.equal(c.membership.start_at,f.now());assert.equal(f.s.cleanup(),0);assert.equal(f.s.stats().totalIncome,8000);
});
test('confirmation rejects mismatch and atomically rolls back on either write failure',t=>{
 const f=fixture(t);const p=request(f.s);for(const [column,value] of [['amount_mmk',1],['plan_days',1]]){f.db.prepare(`UPDATE payments SET ${column}=? WHERE id=?`).run(value,p.id);assert.throws(()=>confirm(f,p),/mismatch/);f.db.prepare(`UPDATE payments SET ${column}=? WHERE id=?`).run(column==='amount_mmk'?2000:30,p.id);}
 f.db.exec("CREATE TRIGGER fail_membership BEFORE INSERT ON premium_memberships BEGIN SELECT RAISE(ABORT,'test');END;");assert.throws(()=>confirm(f,p));assert.equal(f.db.prepare('SELECT status FROM payments').get().status,'PENDING');f.db.exec('DROP TRIGGER fail_membership');
 f.db.exec("CREATE TRIGGER fail_confirm BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT,'test');END;");assert.throws(()=>confirm(f,p));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM premium_memberships').get().n,0);
});
test('void, correction history and membership audit rules',t=>{
 const f=fixture(t);let p=request(f.s);assert.throws(()=>f.s.void(p.id,{reason:' '},'admin'));f.s.void(p.id,{reason:'test'},'admin');assert.throws(()=>confirm(f,p));
 p=request(f.s);const original=confirm(f,p).membership;const correction=f.s.correct(p.id,{reason:'wrong plan',plan:'MONTH_3',payment_method:'AYA_PAY'},'admin');assert.equal(correction.original.status,'CORRECTED');assert.equal(correction.replacement.status,'PENDING');assert.deepEqual(f.s.details(101).membership,original);assert.equal(f.s.stats().totalIncome,0);
 assert.throws(()=>f.s.void(p.id,{reason:'test'},'admin'));assert.throws(()=>f.s.correctMembership(101,{start_at:f.now(),expires_at:f.now(),reason:'test'},'admin'));
 assert.throws(()=>f.s.correctMembership(101,{start_at:f.now(),expires_at:original.expires_at,reason:''},'admin'));
 f.s.correctMembership(101,{start_at:f.now(),expires_at:'2002-01-01T00:00:00.000Z',reason:'fix'},'server-admin');assert.equal(f.db.prepare("SELECT admin_identifier FROM membership_audit_log WHERE action='MEMBERSHIP_CORRECTION'").get().admin_identifier,'server-admin');assert.equal(f.s.history(101).total,3);
});
test('5000 users listing/search/sorts/stats and bounded history',t=>{
 const f=fixture(t);const insert=f.db.prepare('INSERT INTO telegram_users(telegram_user_id,username,first_seen_at,last_seen_at,created_at,updated_at) VALUES (?,?,?,?,?,?)');const member=f.db.prepare('INSERT INTO premium_memberships(telegram_user_id,start_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,?)');f.db.transaction(()=>{for(let i=1000;i<6000;i++){insert.run(i,'user'+i,f.now(),f.now(),f.now(),f.now());member.run(i,f.now(),i%2?'2000-01-01T00:00:00.000Z':'2002-01-01T00:00:00.000Z',f.now(),f.now());}})();
 assert.equal(f.s.users().total,5000);assert.equal(f.s.users().users.length,24);assert.equal(f.s.users({status:'ACTIVE'}).total,2500);assert.equal(f.s.users({status:'EXPIRED'}).total,2500);assert.equal(f.s.users({search:'user1000'}).total,1);
 for(const sort of ['newest','oldest','expiry_high','expiry_low','username_az','username_za'])assert.equal(f.s.users({sort}).users.length,24);
 assert.deepEqual(f.s.stats(),{totalPremiumUsers:5000,activePremium:2500,expiredPremium:2500,totalIncome:0});assert.equal(f.s.status(101).status,'NON_PREMIUM');
 for(let i=0;i<25;i++){const p=request(f.s);f.s.void(p.id,{reason:'test'},'admin');}assert.equal(f.s.history(101).payments.length,20);assert.equal(f.s.history(101,{page:'2'}).payments.length,5);
 for(const q of [{page:'0'},{limit:'101'},{sort:'bad'},{status:'BAD'},{search:[]},{page:'9007199254740991',limit:'100'}])assert.throws(()=>f.s.users(q));
});
test('HTTP Admin protection, CSRF, identity derivation and minimal internal status',async t=>{
 const f=fixture(t);const app=express();app.use(express.json());const stop=registerPremiumRoutes(app,f.db,{requireAdmin:(req,res,next)=>req.get('test-admin')==='yes'?next():res.sendStatus(401),requireSameOrigin:(req,res,next)=>req.get('Origin')==='https://wrong.invalid'?res.sendStatus(403):next(),adminIdentity:()=> 'server-derived',env:{PREMIUM_STATUS_SECRET:'synthetic-secret'}});t.after(stop);
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=(url,headers={},method='GET',data)=>fetch(`http://127.0.0.1:${server.address().port}${url}`,{method,headers:{'Content-Type':'application/json',...headers},body:data?JSON.stringify(data):undefined});
 assert.equal((await call('/api/admin/premium/stats')).status,401);assert.equal((await call('/api/admin/premium/users',{'test-admin':'yes'})).status,200);
 assert.equal((await call('/api/admin/premium/payments/request',{'test-admin':'yes',Origin:'https://wrong.invalid'},'POST',{})).status,403);
 const route='/api/internal/premium/users/101/status';assert.equal((await call(route)).status,401);assert.equal((await call(route,{Authorization:'Bearer wrong'})).status,401);const r=await call(route,{Authorization:'Bearer synthetic-secret'});assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(Object.keys(await r.json()).sort(),['expires_at','start_at','status']);
 const p=await (await call('/api/admin/premium/payments/request',{'test-admin':'yes',Origin:'http://test.invalid'},'POST',{telegram_user_id:101,plan:'MONTH_1',payment_method:'KBZPAY'})).json();
 const result=await (await call(`/api/admin/premium/payments/${p.id}/confirm`,{'test-admin':'yes',Origin:'http://test.invalid'},'POST',{transaction_reference:'test',payment_at:new Date().toISOString()})).json();assert.equal(result.payment.confirmed_by,'server-derived');
});
test('strict input validation, pending pagination, lookup and status boundary',t=>{
 const f=fixture(t);
 for(const value of [0,-1,1.5,[],[101],{},true,'9007199254740992'])assert.throws(()=>f.s.status(value));
 for(const value of [{telegram_user_id:101,plan:'BAD',payment_method:'KBZPAY'},{telegram_user_id:101,plan:'MONTH_1',payment_method:'BAD'},{telegram_user_id:101,plan:'MONTH_1',payment_method:'KBZPAY',amount_mmk:1}])assert.throws(()=>f.s.request(value));
 const p=request(f.s);assert.equal(f.s.lookup(p.payment_request_code).telegram_user_id,101);assert.throws(()=>f.s.lookup('NM-O00000'));
 for(const input of [{transaction_reference:' ',payment_at:f.now()},{transaction_reference:'x',payment_at:'invalid'},{transaction_reference:'x',payment_at:f.now(),confirmed_by:'spoof'}])assert.throws(()=>f.s.confirm(p.id,input,'admin'));
 confirm(f,p);f.advance(30);assert.equal(f.s.status(101).status,'EXPIRED');
 for(let i=200;i<225;i++){f.s.upsertUser({telegram_user_id:i,username:'pending'+i});request(f.s,'MONTH_1',i%2?'KBZPAY':'AYA_PAY',i);}
 assert.equal(f.s.pending().payments.length,24);assert.equal(f.s.pending({page:'2'}).payments.length,1);assert.equal(f.s.pending({search:'pending200'}).total,1);assert.equal(f.s.pending({payment_method:'AYA_PAY'}).total,13);
 const newest=f.s.pending().payments[0].id;assert(f.s.pending({sort:'oldest'}).payments[0].id<newest);
 f.advance(1);assert.equal(f.s.pending().total,0);assert.equal(f.s.cleanup(),25);assert.equal(f.s.history(101).payments[0].status,'CONFIRMED');
});
test('cleanup keeps protected history and malformed expiries',t=>{
 const f=fixture(t);const insert=f.db.prepare(`INSERT INTO payments(telegram_user_id,payment_request_code,payment_method,amount_mmk,plan,plan_days,status,created_at,request_expires_at) VALUES (101,?,'KBZPAY',2000,'MONTH_1',30,?,?,?)`);
 for(const status of ['CONFIRMED','CORRECTED','VOID','REFUNDED','EXPIRED'])insert.run('NM-'+status,status,f.now(),'2000-01-01T00:00:00.000Z');
 insert.run('NM-BAD','PENDING',f.now(),'2000-02-30T00:00:00.000Z');assert.equal(f.s.cleanup(),1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM payments').get().n,5);assert.equal(f.s.stats().totalIncome,2000);
});
function effects(f){return f.db.prepare('SELECT * FROM premium_membership_effects ORDER BY event_order,revision').all();}
function replace(f,p,plan){return f.s.correct(p.id,{reason:'Correct purchase',plan,payment_method:'KBZPAY'},'admin-test').replacement;}
const daysBetween=(end,start)=>(Date.parse(end)-Date.parse(start))/86400000;
test('first activation corrections 30->90 and 90->30 replace, never add; history and idempotency',t=>{
 for(const [from,to,days] of [['MONTH_1','MONTH_3',90],['MONTH_3','MONTH_1',30]]){
  const f=fixture(t);const p=request(f.s,from);const original=confirm(f,p);const first=effects(f)[0];f.advance(0.5);
  const replacement=replace(f,p,to);assert.equal(effects(f).length,1);assert.deepEqual(f.s.details(101).membership,original.membership);
  const result=confirm(f,replacement,'replacement');assert.equal(daysBetween(result.membership.expires_at,first.effective_at),days);
  const rows=effects(f);assert.deepEqual(rows[0],first);assert.equal(rows[1].event_order,1);assert.equal(rows[1].revision,2);assert.equal(rows[1].supersedes_effect_id,first.id);assert.equal(rows[1].effective_at,first.effective_at);
  assert.deepEqual(confirm(f,replacement,'replacement').membership,result.membership);assert.equal(effects(f).length,2);
  const history=f.s.history(101).payments;assert.equal(history[0].status,'CONFIRMED');assert.equal(history[1].status,'CORRECTED');assert.equal(f.s.stats().totalIncome,PLANS[to][1]);
 }
});
test('active and expired renewal corrections keep original event time',t=>{
 for(const elapsed of [1,40]){
  const f=fixture(t);const base=confirm(f,request(f.s));f.advance(elapsed);const renewal=request(f.s);const wrong=confirm(f,renewal,'renewal');
  const replacement=replace(f,renewal,'MONTH_3');const result=confirm(f,replacement,'correct');
  assert.equal(effects(f).at(-1).event_order,2);
  assert.equal(result.membership.start_at,wrong.membership.start_at);
  assert.equal(daysBetween(result.membership.expires_at,elapsed===1?base.membership.expires_at:wrong.membership.start_at),90);
 }
});
test('earlier correction preserves multiple later renewals and later absolute manual correction',t=>{
 for(const manual of [false,true]){
  const f=fixture(t);const p=request(f.s);const initial=confirm(f,p);f.advance(1);confirm(f,request(f.s),'later1');
  if(manual)f.s.correctMembership(101,{start_at:f.now(),expires_at:'2001-06-01T00:00:00.000Z',reason:'Manual date correction'},'admin');
  f.advance(1);confirm(f,request(f.s),'later2');
  const before=effects(f);const replacement=replace(f,p,'MONTH_3');const result=confirm(f,replacement,'replacement');
  if(manual)assert.equal(result.membership.expires_at,'2001-07-01T00:00:00.000Z');
  else assert.equal(daysBetween(result.membership.expires_at,initial.membership.start_at),150);
  for(const row of before)assert.deepEqual(effects(f).find(e=>e.id===row.id),row);
 }
});
test('replacement correction chain uses highest revision only',t=>{
 const f=fixture(t);const p=request(f.s);confirm(f,p);const second=replace(f,p,'MONTH_3');confirm(f,second,'second');const third=replace(f,second,'MONTH_1');const result=confirm(f,third,'third');
 assert.equal(daysBetween(result.membership.expires_at,result.membership.start_at),30);assert.deepEqual(effects(f).map(e=>e.revision),[1,2,3]);
});
test('ledger insert and replay/write failures roll back confirmation and membership',t=>{
 for(const target of ['premium_membership_effects','premium_memberships']){
  const f=fixture(t);const p=request(f.s);confirm(f,p);const replacement=replace(f,p,'MONTH_3');const before=effects(f);const member=f.s.details(101).membership;
  f.db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'synthetic failure');END`);
  assert.throws(()=>confirm(f,replacement,'replacement'));assert.deepEqual(effects(f),before);assert.deepEqual(f.s.details(101).membership,member);assert.equal(f.s.lookup(replacement.payment_request_code).status,'PENDING');
 }
 const f=fixture(t);const p=request(f.s);confirm(f,p);f.s.correctMembership(101,{start_at:'9998-01-01T00:00:00.000Z',expires_at:'9999-12-31T00:00:00.000Z',reason:'Synthetic boundary'},'admin');const renewal=request(f.s);const before=effects(f);
 assert.throws(()=>confirm(f,renewal,'overflow'));assert.deepEqual(effects(f),before);assert.equal(f.s.lookup(renewal.payment_request_code).status,'PENDING');
});
test('missing/corrupt ledger and ambiguous replacement links fail closed',t=>{
 const f=fixture(t);const p=request(f.s);confirm(f,p);const replacement=replace(f,p,'MONTH_3');
 f.db.exec("INSERT INTO membership_audit_log(telegram_user_id,action,field_name,old_value,new_value,reason,admin_identifier,created_at) SELECT telegram_user_id,action,field_name,old_value,new_value,reason,admin_identifier,created_at FROM membership_audit_log WHERE action='PAYMENT_CORRECTION'");
 assert.throws(()=>confirm(f,replacement,'replacement'),/Ambiguous/);assert.equal(effects(f).length,1);
 f.db.exec('DROP TRIGGER premium_effects_no_update; UPDATE premium_membership_effects SET revision=2,supersedes_effect_id=id,reason=\'corrupt\'');
 assert.throws(()=>confirm(f,replacement,'replacement'));assert.equal(f.s.lookup(replacement.payment_request_code).status,'PENDING');
 const g=fixture(t);const q=request(g.s);confirm(g,q);g.db.exec('DROP TRIGGER premium_effects_no_delete; DELETE FROM premium_membership_effects');assert.throws(()=>confirm(g,q));
});
