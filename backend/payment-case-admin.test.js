import { migratePaymentCaseDelivery } from './payment-case-delivery-migration.js';
import { migratePaymentBotIntake } from './payment-bot-intake-migration.js';
import { migratePaymentCaseCompletion } from './payment-case-completion-migration.js';
import { migratePaymentCases } from './payment-case-migration.js';
import { migratePaymentCaseAdapter } from './payment-case-adapter-migration.js';
import { migratePaymentCaseWorkflow } from './payment-case-workflow-migration.js';
import { migratePaymentCaseAdmin } from './payment-case-admin-migration.js';
import { migratePaymentCaseConversation } from './payment-case-conversation-migration.js';
import { createPaymentCaseConversationService } from './payment-case-conversation.js';
import { createPremiumService } from './premium-service.js';
import { migratePremium } from './premium-migration.js';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
import { registerPremiumRoutes } from './premium-routes.js';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import Database from "better-sqlite3";
import multer from "multer";
import { timingSafeEqual, randomUUID } from "node:crypto";
import SQLiteSessionStore from "./session-store.js";
import { createAdminAuth } from "./admin-auth.js";
import { validateDatabasePath } from "./bootstrap-admin.js";
import { resolveMovieDatabasePath } from "./movie-database-path.js";

const serverUrl = new URL("./server.js", import.meta.url);
// Execute the actual production initialization and auth routes, not copied route implementations.
const source = fs.readFileSync(serverUrl, "utf8").split("// GET movies with search")[0]
    .replace(/^import .*;\r?\n/gm, "").replaceAll("import.meta.url", JSON.stringify(serverUrl.href));

async function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-case-admin-http-"));
    const authPath = path.join(directory, "admin.db");
    const moviesPath = path.join(directory, "movies.db");
    const seed = createAdminAuth({ filename: authPath });
    await seed.initializeCredential("TestAdmin", " test password ");
    seed.close();
    const movies = new Database(moviesPath);
    movies.exec("CREATE TABLE movies (id INTEGER PRIMARY KEY, telegram_chat_id TEXT, telegram_message_id INTEGER)");
    movies.exec('CREATE TABLE series_episodes(id INTEGER PRIMARY KEY)');
    migratePremium(movies);migratePremiumLedgerV3(movies);migratePaymentCases(movies);migratePaymentCaseAdapter(movies);migratePaymentCaseAdmin(movies);
    migratePaymentCaseConversation(movies);migratePaymentCaseWorkflow(movies);
    movies.close();
    const logs = [];
    let wrappedAuth;
    let clock = Date.now();
    class Clock extends Date { static now() { return clock; } }
    const context = vm.createContext({ URL, express, session, SQLiteSessionStore, Database, path, multer, fs,
        fileURLToPath, timingSafeEqual, randomUUID, validateDatabasePath,
        resolveMovieDatabasePath: directory => resolveMovieDatabasePath(directory, context.process.env), Date: Clock,
        createAdminAuth: options => { const store = createAdminAuth(options); wrappedAuth = { ...store }; return wrappedAuth; },
        setInterval, clearInterval, registerPremiumRoutes,
        console: { log: message => logs.push(message), error: message => logs.push(message) },
        process: { env: { ADMIN_DATABASE_PATH: authPath, DATABASE_PATH: moviesPath,
            SESSION_DATABASE_PATH: path.join(directory, "sessions.db"), UPLOADS_DIR: path.join(directory, "uploads"),
            SESSION_SECRET: "synthetic-session-secret-only", NODE_ENV: "development",
            ADMIN_USERNAME: "EnvironmentOnly", ADMIN_PASSWORD: "environment-only-password" },
            exit: () => { throw new Error("Startup refused"); } }
    });
    const runtime = vm.runInContext(source + `
        const stopPremium = registerPremiumRoutes(app,db,{requireAdmin,requireSameOrigin,adminIdentity:()=>adminAuth.getCredential().username,env:process.env});
        app.get("/test/protected", requireAdmin, (req,res) => res.json({ok:true}));
        app.post("/test/session", (req,res) => {
            req.session.isAdmin = req.body.isAdmin;
            if (req.body.version !== undefined) req.session.credentialVersion = req.body.version;
            res.json({ok:true});
        });
        app.use((error,req,res,next) => res.status(500).json({message:"Internal server error"}));
        ({app, sessionStore, db, loginCleanup, accountCleanup, stopPremium});`, context);
    const listener = await new Promise(resolve => { const s = runtime.app.listen(0, "127.0.0.1", () => resolve(s)); });
    t.after(async () => {
        await new Promise(resolve => listener.close(resolve));
        clearInterval(runtime.loginCleanup);clearInterval(runtime.accountCleanup);runtime.stopPremium();
        runtime.sessionStore.close(); wrappedAuth.close(); runtime.db.close();
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert(path.basename(resolved).startsWith("nemo-case-admin-http-"));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    function request(route, { body, cookie, ip = "192.0.2.1", origin, method } = {}) {
        return new Promise((resolve, reject) => {
            const headers = { "Content-Type": "application/json", "X-Forwarded-For": ip };
            if (cookie) headers.Cookie = cookie;
            if (origin) headers.Origin = origin;
            const req = http.request({ hostname: "127.0.0.1", port: listener.address().port,
                path: route, method: method ?? (body === undefined ? "GET" : "POST"), headers }, res => {
                let text = ""; res.on("data", chunk => text += chunk);
                res.on("end", () => resolve({ status: res.statusCode, text,
                    cookie: res.headers["set-cookie"]?.[0]?.split(";")[0], headers: res.headers }));
            });
            req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
        });
    }
    const login = (body = { username: "TestAdmin", password: " test password " }, options = {}) => request("/api/login", { body, ...options });
    return { port:listener.address().port, env:context.process.env, request, login, auth: wrappedAuth, authPath, logs, runtime,
        advance: ms => { clock += ms; } };
}


test('Payment Case Admin API with real isolated Admin sessions',async t=>{
 const f=await fixture(t),db=f.runtime.db,root='/api/admin/premium/cases',origin=`http://127.0.0.1:${f.port}`;
 assert.notEqual(f.port,3000);
 const service=createPremiumService(db);service.upsertUser({telegram_user_id:101,username:'fixture_customer'});
 const time='2026-01-01T00:00:00.000Z';
 function add(evidence=true){
  const uid=101+db.prepare('SELECT count(*) n FROM payment_cases').get().n;service.upsertUser({telegram_user_id:uid,username:'fixture_customer'});
  const caseId=Number(db.prepare(`INSERT INTO payment_cases(telegram_user_id,plan,plan_days,amount_mmk,payment_method,payment_account_reference,created_at,updated_at) VALUES(?,'MONTH_1',30,2000,'KBZPAY','fake-account-v1',?,?)`).run(uid,time,time).lastInsertRowid);
  if(evidence){for(const last of ['0123','1234'])db.prepare('INSERT INTO payment_case_submissions(case_id,transaction_last_four,proof_file_id,proof_chat_id,proof_message_id,created_at) VALUES(?,?,?,?,?,?)').run(caseId,last,'PRIVATE-FAKE-FILE','PRIVATE-FAKE-CHAT',123,time);
   db.prepare("UPDATE payment_cases SET status='WAITING_VERIFICATION',submitted_at=? WHERE id=?").run(time,caseId);}
  return caseId;
 }
 const first=add();let cookie;
 async function call(suffix='',body,opts={}){
  const r=await f.request(root+suffix,{cookie,body,origin:body===undefined?undefined:origin,...opts});
  assert.equal(r.headers['cache-control'],'no-store');
  assert(!/internal_request_code|payment_request_code|NM-[A-HJ-NP-Z2-9]{6}|PRIVATE-FAKE|proof_file_id|proof_chat_id|proof_message_id/.test(r.text));
  return {...r,data:JSON.parse(r.text)};
 }
 const verify=(reference)=>({... (reference===undefined?{}:{transaction_reference:reference}),payment_at:time,plan:'MONTH_1',amount_mmk:2000,payment_method:'KBZPAY'});
 await t.test('anonymous rejected; normal login and authenticated GET without Origin',async()=>{
  assert.equal((await call()).status,401);assert.equal((await call('/'+first)).status,401);assert.equal((await call(`/${first}/messages`)).status,401);
  const login=await f.login();assert.equal(login.status,200);cookie=login.cookie;
  assert.equal((await call()).status,200);assert.equal((await call('/'+first)).status,200);
 });
 await t.test('mutation Origin, auth and client identity checks',async()=>{
  for(const value of [undefined,'https://wrong.invalid','null','not a url'])assert.equal((await call(`/${first}/needs-customer-action`,{message:'Please clarify'},{origin:value})).status,403);
  assert.equal((await call(`/${first}/needs-customer-action`,{message:'Please clarify'},{cookie:undefined})).status,401);
  assert.equal((await call(`/${first}/needs-customer-action`,{message:'Please clarify',adminIdentity:'forged'})).status,410);
  assert.equal((await call(`/${first}/needs-customer-action`,{})).status,410);
 });
 await t.test('pagination, status, literal username and Telegram search, strict input',async()=>{
  for(let n=0;n<25;n++)add();
  assert.equal((await call()).data.cases.length,24);assert.equal((await call('?page=2')).data.cases.length,2);
  assert.equal((await call('?status=WAITING_VERIFICATION&search=fixture_customer&sort=oldest')).data.cases[0].id,first);
  assert.equal((await call('?search=101')).data.total,1);assert.equal((await call('?search=%25')).data.total,0);
  assert.equal((await call('?status=CONFIRMED')).data.total,0);
  for(const q of ['page=0','limit=101','status=BAD','sort=bad','search[x]=a','limit=1.5','page=9007199254740991&limit=100','extra=x'])assert.equal((await call('?'+q)).status,400);
  assert.equal((await call('/0')).status,400);assert.equal((await call('/999999')).status,404);
 });
 await t.test('conversation read authentication, projection, ordering, isolation and bounds',async()=>{
  const conversation=createPaymentCaseConversationService(db,{clock:()=>Date.parse(time)});
  conversation.appendCustomerMessage(first,{message_type:'PHOTO',telegram_chat_id:'-999',telegram_message_id:1,telegram_file_id:'PRIVATE-FAKE-FILE'},{telegramUserId:101});
  conversation.appendCustomerMessage(first,{message_type:'TEXT',text:'<img src=x onerror=alert(1)>',telegram_chat_id:'-999',telegram_message_id:2},{telegramUserId:101});
  conversation.prepareAdminMessage(first,{text:'Please wait'},{adminIdentifier:'TestAdmin'});
  conversation.appendSystemMessage(first,{text:'Synthetic system note'});
  const other=conversation.appendSystemMessage(2,{text:'Other case'});
  const r=await call(`/${first}/messages?limit=2`);assert.equal(r.status,200);assert.equal(r.data.messages.length,2);
  assert.deepEqual(r.data.messages.map(m=>m.message_type),['PHOTO','TEXT']);assert(r.data.messages.every(m=>m.payment_case_id===first));
  const next=await call(`/${first}/messages?limit=2&after_id=${r.data.next_after_id}`);
  assert.deepEqual(next.data.messages.map(m=>m.sender_type),['ADMIN','SYSTEM']);assert.equal(next.data.next_after_id,null);
  assert.equal(next.data.messages[0].initial_delivery_state,'PENDING_SEND');
  const keys=['id','payment_case_id','sender_type','message_type','text_content','admin_identifier','initial_delivery_state','created_at','has_photo','evidence_id'];
  for(const m of [...r.data.messages,...next.data.messages])assert.deepEqual(Object.keys(m).sort(),keys.sort());
  for(const q of ['limit=0','limit=101','limit=1.5','after_id=0','extra=x'])assert.equal((await call(`/${first}/messages?${q}`)).status,400);
  assert.equal((await call(`/${first}/messages?after_id=${other.id}`)).status,404);
  assert.equal((await call('/0/messages')).status,400);assert.equal((await call('/999999/messages')).status,404);
  assert.deepEqual((await call('/3/messages')).data,{messages:[],next_after_id:null});
 });
 await t.test('details project safe evidence history and append-only manual actions',async()=>{
  const d=(await call('/'+first)).data;assert.equal(d.evidence.length,2);assert.deepEqual(d.evidence.map(e=>e.transaction_last_four),['0123','1234']);assert(d.evidence.every(e=>e.has_proof));assert.equal(d.transaction_last_four,'1234');
  assert.equal((await call(`/${first}/needs-customer-action`,{message:'Please clarify'})).status,410);
  assert.equal((await call('/'+first)).data.status,'WAITING_VERIFICATION');
 });
 await t.test('rejection categories, permanence, no activation',async()=>{
  const c=add();assert.equal((await call(`/${c}/reject`,{message:'Not found'})).status,400);
  assert.equal((await call(`/${c}/reject`,{message:'Not found',reason_category:'BAD'})).status,400);
  const r=await call(`/${c}/reject`,{message:'Payment could not be verified',reason_category:'PAYMENT_NOT_FOUND'});assert.equal(r.data.status,'REJECTED');assert.equal(r.data.actions[0].reason_category,'PAYMENT_NOT_FOUND');assert.equal(r.data.rejected_by,'TestAdmin');
  assert.equal((await call(`/${c}/confirm`,verify())).status,409);assert.equal((await call(`/${c}/retry-activation`,{})).status,409);assert.equal(db.prepare('SELECT count(*) n FROM payments').get().n,0);
 });
 await t.test('optional legacy reference, separate completion and idempotence',async()=>{
  assert.equal((await call(`/${first}/confirm`,verify('1234'))).status,400);
  assert.equal((await call(`/${first}/confirm`,{...verify(),admin_identifier:'forged'})).status,400);
  assert.equal((await call(`/${add(false)}/confirm`,verify())).status,409);
  const confirmed=await call(`/${first}/confirm`,verify());assert.equal(confirmed.data.status,'CONFIRMED');assert.equal(confirmed.data.membership,null);const completed=await call(`/${first}/retry-activation`,{});assert.equal(completed.status,200);assert.equal(completed.data.status,'COMPLETED');assert(completed.data.membership);assert.equal(completed.data.payment.status,'CONFIRMED');assert.equal(completed.data.verification.admin_identifier,'TestAdmin');
  const count=db.prepare('SELECT count(*) n FROM premium_membership_effects').get().n;
  assert.equal((await call(`/${first}/retry-activation`,{})).status,409);assert.equal((await call(`/${first}/confirm`,verify())).data.status,'COMPLETED');assert.equal(db.prepare('SELECT count(*) n FROM premium_membership_effects').get().n,count);
  assert.equal((await call(`/${first}/reject`,{message:'No',reason_category:'OTHER'})).status,409);
 });
 await t.test('failed activation stays queryable CONFIRMED; retry requires no verification body',async()=>{
  const c=add();db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON premium_membership_effects BEGIN SELECT RAISE(ABORT,'fake failure'); END;");
  const r=await call(`/${c}/confirm`,verify('FAKE-SECOND-1234'));assert.equal(r.data.status,'CONFIRMED');assert.equal(r.data.activation_pending,true);assert.equal((await call(`/${c}/retry-activation`,{})).data.completion_error,'COMPLETION_FAILED');
  assert.equal((await call('?status=CONFIRMED')).data.total,1);
  assert.equal((await call(`/${c}/reject`,{message:'No',reason_category:'OTHER'})).status,409);
  assert.equal((await call(`/${c}/retry-activation`,verify())).status,400);
  db.exec('DROP TRIGGER injected_failure');assert.equal((await call(`/${c}/retry-activation`,{})).data.status,'COMPLETED');assert.equal((await call(`/${c}/retry-activation`,{})).status,409);
 });
 await t.test('intervening ledger activity yields explicit manual reconciliation result',async()=>{
  const c=add();db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON premium_membership_effects BEGIN SELECT RAISE(ABORT,'fake failure'); END;");
  await call(`/${c}/confirm`,verify('FAKE-REVIEW-1234'));db.exec('DROP TRIGGER injected_failure');
  const v=db.prepare('SELECT confirmed_at FROM payment_cases WHERE id=?').get(c).confirmed_at;
  const later=createPremiumService(db,{clock:()=>Date.parse(v)+1000});const p=later.request({telegram_user_id:db.prepare('SELECT telegram_user_id FROM payment_cases WHERE id=?').get(c).telegram_user_id,plan:'MONTH_1',payment_method:'AYA_PAY'});later.confirm(p.id,{transaction_reference:'FAKE-LATER',payment_at:v},'TestAdmin');
  const r=await call(`/${c}/retry-activation`,{});assert.equal(r.data.status,'CONFIRMED');assert.equal(r.data.completion_error,'MANUAL_RECONCILIATION_REQUIRED');assert.match(r.data.message,/manual reconciliation/);
 });
 await t.test('transition rollback, idempotent migration, existing Premium routes unchanged',async()=>{
  const c=add();db.exec("CREATE TRIGGER injected_failure BEFORE UPDATE ON payment_cases BEGIN SELECT RAISE(ABORT,'fake failure'); END;");
  const before=db.prepare('SELECT count(*) n FROM payment_case_admin_actions').get().n;
  assert.equal((await call(`/${c}/reject`,{message:'Not found',reason_category:'OTHER'})).status,500);assert.equal(db.prepare('SELECT count(*) n FROM payment_case_admin_actions').get().n,before);db.exec('DROP TRIGGER injected_failure');
  migratePaymentCaseWorkflow(db);migratePaymentCaseWorkflow(db);
  db.exec('ALTER TABLE payment_case_admin_actions RENAME TO isolated_actions_unavailable');
  assert.equal((await call()).status,503);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_case_admin_actions'").get(),undefined);
  assert.equal((await f.request('/api/admin/premium/stats',{cookie})).status,200);assert.equal((await f.request('/api/admin/premium/payments',{cookie})).status,200);
  db.exec('ALTER TABLE isolated_actions_unavailable RENAME TO payment_case_admin_actions');
  db.exec('ALTER TABLE payment_case_messages RENAME TO isolated_messages_unavailable');
  assert.equal((await call(`/${first}/messages`)).status,503);
  assert.equal((await call('/'+first)).status,200);
  db.exec('ALTER TABLE isolated_messages_unavailable RENAME TO payment_case_messages');
  assert.equal((await f.request('/api/logout',{cookie,body:{}})).status,200);assert.equal((await call()).status,401);
  assert.equal((await call(`/${first}/messages`)).status,401);
 });
});


test('Stage 3 automatic confirmation uses real isolated Admin auth and Origin protection',async t=>{
 const f=await fixture(t),db=f.runtime.db,origin='http://127.0.0.1:'+f.port;
 migratePaymentBotIntake(db);migratePaymentCaseCompletion(db);migratePaymentCaseDelivery(db);
 createPremiumService(db).upsertUser({telegram_user_id:777});const at=new Date().toISOString();
 const c=Number(db.prepare("INSERT INTO payment_cases(telegram_user_id,plan,plan_days,amount_mmk,payment_method,payment_account_reference,created_at,updated_at) VALUES(777,'MONTH_1',30,2000,'KBZPAY','fake',?,?)").run(at,at).lastInsertRowid);
 db.prepare("INSERT INTO payment_case_submissions(case_id,proof_file_id,transaction_last_four,created_at) VALUES(?,'FAKE','0007',?)").run(c,at);
 db.prepare("UPDATE payment_cases SET status='WAITING_VERIFICATION',submitted_at=? WHERE id=?").run(at,c);
 const body={plan:'MONTH_1',amount_mmk:2000,payment_method:'KBZPAY',payment_at:at},route='/api/admin/premium/cases/'+c+'/confirm';
 assert.equal((await f.request(route,{body,origin})).status,401);
 const cookie=(await f.login()).cookie;
 for(const bad of [undefined,'https://wrong.invalid','null'])assert.equal((await f.request(route,{body,cookie,origin:bad})).status,403);
 const messageRoute='/api/admin/premium/cases/'+c+'/messages';
 assert.equal((await f.request(messageRoute,{body:{text:'Fake clarification'},origin})).status,401);
 assert.equal((await f.request(messageRoute,{body:{text:'Fake clarification'},cookie})).status,403);
 const prepared=await f.request(messageRoute,{body:{text:'<img src=x onerror=alert(1)>'},cookie,origin});assert.equal(prepared.status,200);assert.equal(JSON.parse(prepared.text).delivery_state,'PENDING_SEND');assert(!/lease_token|telegram_user_id|telegram_chat_id/.test(prepared.text));
 assert.equal(db.prepare('SELECT status FROM payment_cases WHERE id=?').get(c).status,'WAITING_VERIFICATION');
 const r=await f.request(route,{body,cookie,origin});assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store');assert.equal(JSON.parse(r.text).status,'COMPLETED');
 assert.equal(db.prepare('SELECT count(*) n FROM payment_case_notifications').get().n,2);
 assert.equal((await f.request(route,{body,cookie,origin})).status,200);assert.equal(db.prepare('SELECT count(*) n FROM premium_membership_effects').get().n,1);
 assert(!/internal_request_code|proof_file_id|telegram_file_id/.test(r.text));
 assert.equal((await f.request('/api/internal/payment-bot/notifications',{cookie})).status,503);
 assert.equal((await f.request('/api/internal/payment-bot/deliveries/claim',{cookie,body:{}})).status,503);
 f.env.PAYMENT_BOT_API_SECRET='synthetic-secret';assert.equal((await f.request('/api/internal/payment-bot/deliveries/claim',{cookie,body:{}})).status,401);assert.equal((await f.request('/api/internal/payment-bot/notifications',{cookie})).status,401);
});
