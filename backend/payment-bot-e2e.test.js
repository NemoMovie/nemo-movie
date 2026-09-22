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
import { createClient } from '../payment-bot/client.js';
import { createRuntime } from '../payment-bot/runtime.js';
import { createFakeTransport } from '../payment-bot/fake-transport.js';
import { messages } from '../payment-bot/flow.js';
import { createPaymentCaseAdapter } from './payment-case-adapter.js';

const DAY=86400000;
async function harness(t,{outcomes=[]}={}){
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-01-01T00:00:00.000Z')});
 const f=await fixture(t);let cookie=(await f.login()).cookie,sequence=0,bot,pending=[];
 const replies=[],acks=[],transport=createFakeTransport({outcomes});
 const api=(p,b)=>createClient({baseUrl:`http://127.0.0.1:${f.port}`,secret:'synthetic-e2e-api-secret'})(p,b);
 const telegram={sendFlow:async(...args)=>replies.push(args),answerCallbackQuery:async id=>acks.push(id),getUpdates:async offset=>{const batch=pending.filter(u=>u.update_id>=offset);pending=[];return batch;}};
 const resetBot=()=>{bot=createRuntime({api,telegram,transport});};resetBot();
 const advance=ms=>{t.mock.timers.tick(ms);f.advance(ms);};
 const msg=(uid,extra)=>({message:{from:{id:uid},chat:{id:uid,type:'private'},message_id:++sequence,date:Math.floor(Date.now()/1000),...extra}});
 const cb=(uid,data)=>({callback_query:{id:'e2e-'+ ++sequence,from:{id:uid},message:{chat:{id:uid,type:'private'}},data}});
 const send=async update=>{pending=[{update_id:++sequence,...update}];await bot.processUpdates();assert.equal(bot.offset,sequence+1,'update must finish, not silently fail');};
 const state=async uid=>(await api('/flow/state',{telegram_user_id:uid})).case;
 const admin=async(suffix='',body,options={})=>{const r=await f.request('/api/admin/premium/cases'+suffix,{cookie,body,origin:body===undefined?undefined:`http://127.0.0.1:${f.port}`,...options});assert.equal(r.headers['cache-control'],'no-store');assert(!/synthetic-e2e-api-secret|proof_file_id|proof_chat_id|proof_message_id|claim_token|lease_token|internal_request_code|payment_request_code|E2E_PROOF|stack/.test(r.text));return {...r,data:JSON.parse(r.text)};};
 const begin=async(uid=101)=>{await send(msg(uid,{text:'/start upgrade'}));const boundary=(await state(uid))?.id??0;await send(cb(uid,`plan:MONTH_3:${boundary}`));await send(cb(uid,`method:MONTH_3:KBZPAY:${boundary}`));return state(uid);};
 const submit=async(uid=101)=>{const c=await begin(uid);await send(msg(uid,{photo:[{file_id:'E2E_PROOF_'+uid,file_unique_id:'E2E_UNIQUE_'+uid}]}));await send(msg(uid,{text:'0123'}));assert.equal((await state(uid)).status,'WAITING_VERIFICATION');return c;};
 const confirm=c=>admin('/'+c.id+'/confirm',{plan:c.plan,amount_mmk:c.amount_mmk,payment_method:c.payment_method,payment_at:new Date(Date.now()-1000).toISOString()});
 const count=table=>f.runtime.db.prepare('SELECT count(*) n FROM '+table).get().n;
 const membership=uid=>f.runtime.db.prepare('SELECT * FROM premium_memberships WHERE telegram_user_id=?').get(uid);
 const drain=async(n=2)=>{for(let i=0;i<n;i++)await bot.processDelivery();};
 return {login:async()=>{cookie=(await f.login()).cookie;},f,api,admin,msg,cb,send,state,begin,submit,confirm,count,membership,drain,replies,acks,transport,resetBot,advance,reopen:async()=>{await f.reopen();cookie=(await f.login()).cookie;resetBot();}};
}

const serverUrl = new URL("./server.js", import.meta.url);
// Execute the actual production initialization and auth routes, not copied route implementations.
const source = fs.readFileSync(serverUrl, "utf8").split("// GET movies with search")[0]
    .replace(/^import .*;\r?\n/gm, "").replaceAll("import.meta.url", JSON.stringify(serverUrl.href));

async function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-payment-e2e-"));
    const authPath = path.join(directory, "admin.db");
    const moviesPath = path.join(directory, "movies.db");
    const seed = createAdminAuth({ filename: authPath });
    await seed.initializeCredential("TestAdmin", " test password ");
    seed.close();
    const movies = new Database(moviesPath);
    movies.exec("CREATE TABLE movies (id INTEGER PRIMARY KEY, telegram_chat_id TEXT, telegram_message_id INTEGER)");
    movies.exec('CREATE TABLE series_episodes(id INTEGER PRIMARY KEY)');
    migratePremium(movies);migratePremiumLedgerV3(movies);migratePaymentCases(movies);migratePaymentCaseAdapter(movies);migratePaymentCaseAdmin(movies);
    migratePaymentCaseConversation(movies);migratePaymentCaseWorkflow(movies);migratePaymentBotIntake(movies);migratePaymentCaseCompletion(movies);migratePaymentCaseDelivery(movies);
    movies.close();
    const logs = [];
    let wrappedAuth;
    let clock = Date.now();
    class Clock extends Date { static now() { return clock; } }
    const createContext = () => vm.createContext({ URL, express, session, SQLiteSessionStore, Database, path, multer, fs,
        fileURLToPath, timingSafeEqual, randomUUID, validateDatabasePath,
        resolveMovieDatabasePath: directory => resolveMovieDatabasePath(directory, context.process.env), Date: Clock,
        createAdminAuth: options => { const store = createAdminAuth(options); wrappedAuth = { ...store }; return wrappedAuth; },
        setInterval, clearInterval, registerPremiumRoutes,
        console: { log: message => logs.push(message), error: message => logs.push(message) },
        process: { env: { ADMIN_DATABASE_PATH: authPath, DATABASE_PATH: moviesPath,
            SESSION_DATABASE_PATH: path.join(directory, "sessions.db"), UPLOADS_DIR: path.join(directory, "uploads"),
            PAYMENT_BOT_API_SECRET: "synthetic-e2e-api-secret", SESSION_SECRET: "synthetic-session-secret-only", NODE_ENV: "development",
            ADMIN_USERNAME: "EnvironmentOnly", ADMIN_PASSWORD: "environment-only-password" },
            exit: () => { throw new Error("Startup refused"); } }
    });
    let context=createContext();
    const build=()=>vm.runInContext(source + `
        const stopPremium = registerPremiumRoutes(app,db,{requireAdmin,requireSameOrigin,adminIdentity:()=>adminAuth.getCredential().username,env:process.env});
        app.use((error,req,res,next) => res.status(500).json({message:"Internal server error"}));
        ({app, sessionStore, db, loginCleanup, accountCleanup, stopPremium});`, context);
    let runtime=build();
    const listen=()=>new Promise(resolve=>{const s=runtime.app.listen(0,"127.0.0.1",()=>resolve(s));});
    let listener=await listen();
    async function shutdown(){await new Promise(resolve=>listener.close(resolve));clearInterval(runtime.loginCleanup);clearInterval(runtime.accountCleanup);runtime.stopPremium();runtime.sessionStore.close();wrappedAuth.close();runtime.db.close();}
    async function reopen(){await shutdown();context=createContext();runtime=build();listener=await listen();assert.notEqual(listener.address().port,3000);}
    t.after(async () => {
        await new Promise(resolve => listener.close(resolve));
        clearInterval(runtime.loginCleanup);clearInterval(runtime.accountCleanup);runtime.stopPremium();
        runtime.sessionStore.close(); wrappedAuth.close(); runtime.db.close();
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert(path.basename(resolved).startsWith("nemo-payment-e2e-"));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    function request(route, { body, cookie, ip = "192.0.2.1", origin, method, secret } = {}) {
        return new Promise((resolve, reject) => {
            const headers = { "Content-Type": "application/json", "X-Forwarded-For": ip };
            if (cookie) headers.Cookie = cookie;
            if (secret) headers.Authorization = "Bearer " + secret;
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
    return { reopen, directory, moviesPath, get port(){return listener.address().port;}, env:context.process.env, request, login, auth: wrappedAuth, authPath, logs, get runtime(){return runtime;},
        advance: ms => { clock += ms; } };
}

test('connected new-user purchase, protected Admin confirmation, ordered delivery and reopen',async t=>{
 const h=await harness(t),uid=101;
 const start=h.msg(uid,{text:'/start upgrade'});await h.send(start);await h.send(start);
 assert.equal(h.count('payment_cases'),0);assert.equal(h.replies.at(-1)[1],messages.plans);
 const plan=h.cb(uid,'plan:MONTH_3:0');await h.send(plan);await h.send(plan);assert.equal(h.count('payment_cases'),0);
 const method=h.cb(uid,'method:MONTH_3:KBZPAY:0');await h.send(method);await h.send(method);
 const c=await h.state(uid);assert.deepEqual([c.plan_days,c.amount_mmk,c.payment_method],[90,5000,'KBZPAY']);assert.equal(h.count('payment_cases'),1);
 const photo=h.msg(uid,{photo:[{file_id:'E2E_PROOF_101',file_unique_id:'unique_101'}]});await h.send(photo);await h.send(photo);
 assert.equal(h.count('payment_case_submissions'),1);assert.equal((await h.state(uid)).status,'WAITING_PAYMENT');
 h.resetBot();await h.send(h.msg(uid,{text:'/start'}));assert.equal(h.replies.at(-1)[1],messages.photo);
 const digits=h.msg(uid,{text:'0123'});await h.send(digits);await h.send(digits);
 assert.equal(h.count('premium_membership_effects'),0);
 const queue=await h.admin('?status=OPEN');assert.equal(queue.status,200);assert.equal(queue.data.cases[0].status,'WAITING_VERIFICATION');
 const detail=(await h.admin('/'+c.id)).data;assert.equal(detail.transaction_last_four,'0123');assert(detail.evidence.some(e=>e.has_proof));
 await h.reopen();await h.send(h.msg(uid,{text:'/start'}));assert.equal(h.replies.at(-1)[1],messages.review);
 h.advance(1000);const confirmedAt=new Date().toISOString();const results=await Promise.all([h.confirm(c),h.confirm(c)]);assert(results.every(r=>r.status===200&&r.data.status==='COMPLETED'));const r=results[0];
 assert.equal(h.membership(uid).start_at,confirmedAt);assert.equal(h.membership(uid).expires_at,new Date(Date.now()+90*DAY).toISOString());
 assert.equal(h.count('premium_membership_effects'),1);assert.equal(h.count('payment_case_verifications'),1);assert.throws(()=>h.f.runtime.db.exec('DELETE FROM payment_case_verifications'));assert.throws(()=>h.f.runtime.db.exec('DELETE FROM premium_membership_effects'));
 const db=h.f.runtime.db;assert.deepEqual(db.prepare('SELECT event FROM payment_case_notifications ORDER BY message_id').all().map(r=>r.event),['CONFIRMED','COMPLETED']);
 await h.drain();assert.equal(h.transport.sent.length,2);assert.match(h.transport.sent[0].text,/ခဏစောင့်/);assert.match(h.transport.sent[1].text,/06:30:01/);
 assert(db.prepare('SELECT state FROM payment_case_deliveries').all().every(r=>r.state==='SENT'));
 const expiry=h.membership(uid).expires_at;await h.reopen();assert.equal((await h.confirm(c)).data.status,'COMPLETED');assert.equal(h.membership(uid).expires_at,expiry);
 assert.equal((await h.admin('/'+c.id+'/retry-activation',{})).status,409);await h.drain();assert.equal(h.transport.sent.length,2);
 assert.equal(h.count('premium_membership_effects'),1);assert.equal(h.count('payment_case_submissions'),2);
});

for(const active of [true,false])test(active?'ACTIVE early renewal through runtime/API preserves remaining time':'expired-member purchase starts at confirmation',async t=>{
 const h=await harness(t);const first=await h.submit();h.advance(1000);assert.equal((await h.confirm(first)).data.status,'COMPLETED');await h.drain();
 h.advance((active?20:100)*DAY);await h.login();const old=h.membership(101),beforeCases=h.count('payment_cases');
 await h.send(h.msg(101,{text:'/start upgrade'}));await h.send(h.cb(101,'plan:MONTH_3:'+first.id));
 assert.equal(h.count('payment_cases'),beforeCases);assert.deepEqual(h.membership(101),old);
 await h.send(h.cb(101,'method:MONTH_3:KBZPAY:'+first.id));const c=await h.state(101);assert.notEqual(c.id,first.id);
 assert.equal(h.count('payment_cases'),beforeCases+1);assert.deepEqual(h.membership(101),old);
 const selects=await Promise.all([1,2].map(n=>h.api('/flow/select',{telegram_user_id:101,operation_key:'cb:concurrent-'+n,plan:'MONTH_3',payment_method:'KBZPAY',after_case_id:first.id})));
 assert(selects.every(r=>r.case.id===c.id));assert.equal(h.count('payment_cases'),beforeCases+1);
 await assert.rejects(h.api('/flow/select',{telegram_user_id:101,operation_key:'cb:conflict',plan:'MONTH_1',payment_method:'AYA_PAY',after_case_id:first.id}),e=>e.status===409);
 assert.throws(()=>h.f.runtime.db.prepare("INSERT INTO payment_cases(telegram_user_id,plan,plan_days,amount_mmk,payment_method,payment_account_reference,created_at,updated_at) VALUES(101,'MONTH_3',90,5000,'KBZPAY','DEV:KBZPAY:v1',?,?)").run(new Date().toISOString(),new Date().toISOString()));
 await h.send(h.msg(101,{photo:[{file_id:'E2E_PROOF_RENEWAL'}]}));await h.send(h.msg(101,{text:'0123'}));
 assert.deepEqual(h.membership(101),old);assert.equal((await h.api('/users/101/status')).status,active?'ACTIVE':'EXPIRED');h.advance(1000);
 const at=new Date().toISOString();assert.equal((await h.confirm(c)).data.status,'COMPLETED');
 assert.equal(h.membership(101).expires_at,new Date((active?Date.parse(old.expires_at):Date.now())+90*DAY).toISOString());
 assert.equal(h.membership(101).start_at,active?old.start_at:at);const expiry=h.membership(101).expires_at;
 await h.confirm(c);await h.admin('/'+c.id+'/retry-activation',{});assert.equal(h.membership(101).expires_at,expiry);assert.equal(h.count('premium_membership_effects'),2);
 await h.drain();assert.equal(h.transport.sent.length,4);assert.equal(h.transport.sent.at(-1).text.includes('စတင်သည့်အချိန်'),!active);
});

for(const reason of ['PAYMENT_NOT_FOUND','INCORRECT_PAYMENT_DETAILS','PAYMENT_PROOF_ALREADY_USED','INCORRECT_AMOUNT','INVALID_OR_UNCLEAR_PROOF','OTHER'])test('connected rejection '+reason+' and reselect keeps history',async t=>{
 const h=await harness(t),c=await h.submit(),body={reason_category:reason,...(reason==='OTHER'?{message:'<img src=x onerror=alert(1)> synthetic'}:{})};
 if(reason==='OTHER')assert.equal((await h.admin('/'+c.id+'/reject',{reason_category:reason,message:''})).status,400);
 assert.equal((await h.admin('/'+c.id+'/reject',{reason_category:'CUSTOMER_CANCELLED'})).status,400);
 assert.equal((await h.admin('/'+c.id+'/reject',body)).data.status,'REJECTED');assert.equal((await h.admin('/'+c.id+'/reject',body)).data.status,'REJECTED');
 assert.equal((await h.confirm(c)).status,409);assert.equal(h.count('premium_membership_effects'),0);assert.equal(h.count('payment_case_notifications'),1);
 await h.drain(1);const sent=h.transport.sent[0];assert.equal(sent.actions[0].callback_data,'plans:'+c.id);if(reason==='OTHER')assert(sent.text.includes(body.message));
 await h.send(h.cb(101,sent.actions[0].callback_data));assert.equal(h.replies.at(-1)[1],messages.plans);
 await h.send(h.cb(101,'plan:MONTH_3:'+c.id));assert.equal(h.count('payment_cases'),1);
 await h.send(h.cb(101,'method:MONTH_3:KBZPAY:'+c.id));assert.equal(h.count('payment_cases'),2);
 assert.equal((await h.admin('/'+c.id)).data.status,'REJECTED');
});

for(const expired of [false,true])test(expired?'lazy 24-hour case expiry and legitimate new purchase':'customer cancellation replay and legitimate new purchase',async t=>{
 const h=await harness(t),c=await h.begin();
 if(expired){h.advance(DAY+1);await h.login();await h.state(101);}else{const cancel=h.cb(101,'cancel:'+c.id);await h.send(cancel);await h.send(cancel);}
 const status=expired?'EXPIRED':'CANCELLED';assert.equal((await h.state(101)).status,status);
 await h.send(h.msg(101,{photo:[{file_id:'E2E_PROOF_LATE'}]}));await h.send(h.msg(101,{text:'0123'}));
 assert.equal(h.count('payment_case_submissions'),0);assert.equal(h.count('premium_membership_effects'),0);assert.equal((await h.state(101)).status,status);
 await h.send(h.cb(101,'premium_reselect'));await h.send(h.cb(101,'method:MONTH_3:KBZPAY:'+c.id));assert.equal(h.count('payment_cases'),2);
 assert.equal((await h.admin('/'+c.id)).data.status,status);
});

test('same-case method audit and replacement proof are preserved across backend/bot reopen',async t=>{
 const h=await harness(t),c=await h.begin();await h.send(h.cb(101,'change:'+c.id+':AYA_PAY'));
 const change=h.f.runtime.db.prepare('SELECT * FROM payment_case_method_changes').get();assert.deepEqual([change.old_method,change.new_method,change.old_account,change.new_account],['KBZPAY','AYA_PAY','DEV:KBZPAY:v1','DEV:AYA_PAY:v1']);
 const after=await h.state(101);for(const key of ['id','plan','plan_days','amount_mmk'])assert.equal(after[key],c[key]);
 const proof=h.msg(101,{photo:[{file_id:'E2E_PROOF_A',file_unique_id:'unique_A'}]});await h.send(proof);await h.send(proof);
 await h.reopen();await h.send(h.msg(101,{photo:[{file_id:'E2E_PROOF_B',file_unique_id:'unique_B'}]}));
 assert.equal(h.count('payment_case_submissions'),2);assert.equal(h.replies.at(-1)[1],messages.photo);
 const rows=h.f.runtime.db.prepare('SELECT * FROM payment_case_submissions ORDER BY id').all();assert.equal(rows[0].proof_file_id,'E2E_PROOF_A');assert.equal(rows[1].proof_file_id,'E2E_PROOF_B');
 const detail=(await h.admin('/'+c.id)).data;assert.equal(detail.latest_proof_submission_id,rows[1].id);assert.equal(detail.evidence.length,2);
 await assert.rejects(h.api('/flow/method',{telegram_user_id:101,operation_key:'cb:blocked',case_id:c.id,payment_method:'KBZPAY'}),e=>e.status===409);
 await h.send(h.msg(101,{text:' 0123'}));assert.equal((await h.state(101)).status,'WAITING_PAYMENT');await h.send(h.msg(101,{text:'0123'}));assert.equal((await h.state(101)).status,'WAITING_VERIFICATION');
 assert.throws(()=>h.f.runtime.db.exec('UPDATE payment_case_submissions SET proof_file_id=NULL'));
});

test('activation failure persists CONFIRMED; reopen/retry activates once and preserves notification order',async t=>{
 const h=await harness(t),c=await h.submit();h.advance(1000);
 h.f.runtime.db.exec("CREATE TRIGGER e2e_fail BEFORE INSERT ON premium_membership_effects BEGIN SELECT RAISE(ABORT,'SYNTHETIC_PRIVATE_FAILURE'); END");
 const r=await h.confirm(c);assert.equal(r.data.status,'CONFIRMED');assert.equal(r.data.activation_pending,true);assert.equal(r.data.completion_error,'COMPLETION_FAILED');assert(!r.text.includes('SYNTHETIC_PRIVATE_FAILURE'));
 assert.equal(h.count('premium_membership_effects'),0);assert.equal(h.count('payment_case_verifications'),1);assert.equal(h.count('payment_case_notifications'),1);
 await h.reopen();await h.send(h.msg(101,{text:'/start'}));assert.equal(h.replies.at(-1)[1],messages.confirmed);
 assert((await h.admin('/'+c.id)).data.activation_attempts.some(a=>a.outcome==='COMPLETION_FAILED'));
 h.f.runtime.db.exec('DROP TRIGGER e2e_fail');h.advance(10000);
 assert.equal((await h.admin('/'+c.id+'/retry-activation',{})).data.status,'COMPLETED');
 assert.equal(h.membership(101).start_at,r.data.confirmed_at);assert.equal(h.count('payment_case_verifications'),1);assert.equal(h.count('premium_membership_effects'),1);
 await h.admin('/'+c.id+'/retry-activation',{});assert.equal(h.count('premium_membership_effects'),1);await h.drain();assert.equal(h.transport.sent.length,2);
});

test('interrupted already-applied effect reconciles over HTTP without a second grant',async t=>{
 const h=await harness(t),c=await h.submit(),db=h.f.runtime.db;h.advance(1000);
 const input={plan:c.plan,amount_mmk:c.amount_mmk,payment_method:c.payment_method,payment_at:new Date(Date.now()-1000).toISOString()};
 createPaymentCaseAdapter(db).verifyPaymentCase(c.id,input,'TestAdmin');
 const v=db.prepare('SELECT * FROM payment_case_verifications').get();
 const p=db.prepare("INSERT INTO payments(telegram_user_id,payment_request_code,payment_method,amount_mmk,plan,plan_days,status,created_at,request_expires_at) VALUES(101,?,'KBZPAY',5000,'MONTH_3',90,'PENDING',?,?)").run(v.internal_request_code,v.confirmed_at,new Date(Date.parse(v.confirmed_at)+DAY).toISOString());
 createPremiumService(db,{clock:()=>Date.parse(v.confirmed_at)}).confirmVerifiedCase(Number(p.lastInsertRowid),c.id,v.payment_at,'TestAdmin');
 const before=h.membership(101);await h.reopen();assert.equal((await h.confirm(c)).data.status,'COMPLETED');assert.deepEqual(h.membership(101),before);assert.equal(h.count('premium_membership_effects'),1);assert.equal(h.count('payments'),1);await h.drain();assert.equal(h.transport.sent.length,2);
});

test('worker failure/backoff, customer ordering, stale leases and DB reopen through real API',async t=>{
 const h=await harness(t,{outcomes:['fail']}),a=await h.submit(101);h.advance(1000);await h.confirm(a);
 const b=await h.submit(202);h.advance(1000);await h.confirm(b);const before=h.membership(101);
 await h.drain(1);assert.equal(h.transport.sent.length,0);assert.equal(h.f.runtime.db.prepare('SELECT state FROM payment_case_deliveries ORDER BY message_id').get().state,'FAILED');
 await h.drain(2);assert(h.transport.sent.every(m=>m.telegramUserId===202));assert.equal(h.transport.sent.length,2);
 h.advance(60000);await h.reopen();const first=(await h.api('/deliveries/claim',{})).delivery;assert.equal(first.telegram_user_id,101);
 h.advance(120001);await h.reopen();const recovered=(await h.api('/deliveries/claim',{})).delivery;assert.equal(recovered.message_id,first.message_id);assert.notEqual(recovered.claim_token,first.claim_token);
 await assert.rejects(h.api('/deliveries/'+first.message_id+'/sent',{claim_token:first.claim_token}),e=>e.status===409);
 await h.transport.sendMessage({telegramUserId:recovered.telegram_user_id,text:recovered.text,actions:recovered.actions});await h.api('/deliveries/'+recovered.message_id+'/sent',{claim_token:recovered.claim_token});await h.drain(1);
 assert.equal(h.transport.sent.length,4);assert.deepEqual(h.membership(101),before);assert.equal(h.count('premium_membership_effects'),2);assert.equal(h.count('payment_case_notifications'),4);
 assert(h.f.runtime.db.prepare('SELECT state FROM payment_case_deliveries').all().every(r=>r.state==='SENT'));
});

test('integrated HTTP authentication, Origin, no-store and minimal browser projection',async t=>{
 const h=await harness(t),c=await h.submit();
 assert.equal((await h.admin('',undefined,{cookie:''})).status,401);
 for(const origin of [undefined,'https://wrong.invalid','malformed'])assert.equal((await h.admin('/'+c.id+'/messages',{text:'Synthetic'},{origin})).status,403);
 assert.equal((await h.admin('/'+c.id+'/messages',{text:'<img src=x onerror=alert(1)> Admin text'})).status,200);
 await h.send(h.msg(101,{text:'<script>synthetic</script>'}));const convo=(await h.admin('/'+c.id+'/messages')).data;assert(JSON.stringify(convo).includes('<script>synthetic</script>'));
 const login=await h.f.login();for(const secret of [undefined,'wrong']){const r=await h.f.request('/api/internal/payment-bot/plans',{cookie:login.cookie,secret});assert.equal(r.status,401);assert.equal(r.headers['cache-control'],'no-store');}
 await assert.rejects(h.api('/flow/method',{telegram_user_id:202,case_id:c.id,operation_key:'cb:wrong-owner',payment_method:'AYA_PAY'}),e=>e.status===404);
 const allowed=['message_id','claim_token','lease_expires_at','telegram_user_id','text','actions'];assert.deepEqual(Object.keys((await h.api('/deliveries/claim',{})).delivery).sort(),allowed.sort());
});

for(const status of ['WAITING_VERIFICATION','CONFIRMED','COMPLETED','REJECTED','CANCELLED','EXPIRED'])test('protected '+status+' case cannot change method or reopen',async t=>{
 const h=await harness(t),c=['CANCELLED','EXPIRED'].includes(status)?await h.begin():await h.submit();h.advance(1000);
 if(status==='CONFIRMED')h.f.runtime.db.exec("CREATE TRIGGER e2e_hold BEFORE INSERT ON premium_membership_effects BEGIN SELECT RAISE(ABORT,'Synthetic'); END");
 if(['CONFIRMED','COMPLETED'].includes(status))await h.confirm(c);
 if(status==='REJECTED')await h.admin('/'+c.id+'/reject',{reason_category:'PAYMENT_NOT_FOUND'});
 if(status==='CANCELLED')await h.send(h.cb(101,'cancel:'+c.id));
 if(status==='EXPIRED'){h.advance(DAY);await h.login();await h.state(101);}
 assert.equal((await h.state(101)).status,status);
 await assert.rejects(h.api('/flow/method',{telegram_user_id:101,operation_key:'cb:forbidden',case_id:c.id,payment_method:'AYA_PAY'}),e=>e.status===409);
 if(status==='WAITING_VERIFICATION')return; // This state still legitimately permits Admin confirmation/rejection.
 const db=h.f.runtime.db,before=db.prepare('SELECT * FROM payment_cases WHERE id=?').get(c.id),submissions=h.count('payment_case_submissions'),effects=h.count('premium_membership_effects');
 for(const kind of ['PHOTO','TEXT']){
  const n=kind==='PHOTO'?9001:9002;const result=await h.api('/flow/message',{telegram_user_id:101,operation_key:'msg:101:'+n,case_id:c.id,kind,chat_id:'101',message_id:n,message_date:Math.floor(Date.now()/1000),...(kind==='PHOTO'?{file_id:'E2E_PROOF_LATE'}:{text:'9999'})});assert.equal(result.outcome,'CLOSED');
 }
 assert.equal(h.count('payment_case_submissions'),submissions);assert.equal(h.count('premium_membership_effects'),effects);
 assert.throws(()=>db.prepare("UPDATE payment_cases SET status='WAITING_PAYMENT' WHERE id=?").run(c.id));
 assert.throws(()=>db.prepare('DELETE FROM payment_cases WHERE id=?').run(c.id));
 if(!['CONFIRMED','COMPLETED'].includes(status))assert((await h.confirm(c)).status>=400);
 assert((await h.admin('/'+c.id+'/reject',{reason_category:'OTHER',message:'Conflict'})).status>=400);
 assert.deepEqual(db.prepare('SELECT * FROM payment_cases WHERE id=?').get(c.id),before);
 if(submissions)assert.throws(()=>db.exec("UPDATE payment_case_submissions SET transaction_last_four='9999'"));
});

test('fresh schema, synthetic pre-Stage upgrade preservation and whole-SQLite snapshot coverage',async t=>{
 const h=await harness(t),c=await h.submit();h.advance(1000);await h.confirm(c);await h.drain();const db=h.f.runtime.db;
 const tables=['telegram_users','premium_memberships','payments','payment_cases','payment_case_submissions','payment_case_messages','payment_case_message_evidence','payment_case_verifications','payment_case_activation_attempts','premium_membership_effects','payment_case_notifications','payment_case_deliveries','payment_bot_operations'];
 for(const table of tables)assert(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
 for(const name of ['payment_cases_one_open','payment_cases_update','payment_case_submissions_no_update','premium_effects_no_update','payment_case_deliveries_notification'])assert(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));
 for(const migrate of [migratePaymentBotIntake,migratePaymentCaseCompletion,migratePaymentCaseDelivery])migrate(db);
 assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
 // Same whole-database SQLite mechanism used by backup.js, no production backup/lock/root.
 const snapshot=path.join(h.f.directory,'synthetic-snapshot.db');await db.backup(snapshot);
 const restored=new Database(snapshot,{readonly:true,fileMustExist:true});try{assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');for(const table of tables)assert.deepEqual(restored.prepare('SELECT * FROM '+table).all(),db.prepare('SELECT * FROM '+table).all());}finally{restored.close();}
 const legacy=new Database(path.join(h.f.directory,'synthetic-legacy.db'));try{
  legacy.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY); INSERT INTO movies VALUES(7); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY); INSERT INTO series_episodes VALUES(8)');
  migratePremium(legacy);migratePremiumLedgerV3(legacy);const service=createPremiumService(legacy);service.upsertUser({telegram_user_id:303});const payment=service.request({telegram_user_id:303,plan:'MONTH_1',payment_method:'AYA_PAY'});service.confirm(payment.id,{transaction_reference:'SYNTHETIC-LEGACY',payment_at:new Date().toISOString()},'TestAdmin');
  const before=legacy.prepare('SELECT * FROM premium_memberships').all(),payments=legacy.prepare('SELECT * FROM payments').all();
  for(const migrate of [migratePaymentCases,migratePaymentCaseAdapter,migratePaymentCaseAdmin,migratePaymentCaseConversation])migrate(legacy);
  legacy.prepare("INSERT INTO payment_cases(id,telegram_user_id,plan,plan_days,amount_mmk,payment_method,payment_account_reference,created_at,updated_at) VALUES(11,303,'MONTH_1',30,2000,'AYA_PAY','synthetic-legacy-account',?,?)").run(new Date().toISOString(),new Date().toISOString());
  const cases=legacy.prepare('SELECT * FROM payment_cases').all();
  for(const migrate of [migratePaymentCaseWorkflow,migratePaymentBotIntake,migratePaymentCaseCompletion,migratePaymentCaseDelivery])migrate(legacy);
  assert.deepEqual(legacy.prepare('SELECT * FROM payment_cases').all(),cases);assert.deepEqual(legacy.prepare('SELECT * FROM payments').all(),payments);
  assert.deepEqual(legacy.prepare('SELECT * FROM premium_memberships').all(),before);assert.equal(legacy.prepare('SELECT id FROM movies').get().id,7);assert.equal(legacy.prepare('SELECT id FROM series_episodes').get().id,8);assert.equal(legacy.prepare('SELECT count(*) n FROM premium_membership_effects').get().n,1);assert.deepEqual(legacy.pragma('foreign_key_check'),[]);
 }finally{legacy.close();}
});


