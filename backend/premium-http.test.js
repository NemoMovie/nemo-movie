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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-premium-http-"));
    const authPath = path.join(directory, "admin.db");
    const moviesPath = path.join(directory, "movies.db");
    const seed = createAdminAuth({ filename: authPath });
    await seed.initializeCredential("TestAdmin", " test password ");
    seed.close();
    const movies = new Database(moviesPath);
    movies.exec("CREATE TABLE movies (id INTEGER PRIMARY KEY, telegram_chat_id TEXT, telegram_message_id INTEGER)");
    movies.exec('CREATE TABLE series_episodes(id INTEGER PRIMARY KEY)');
    migratePremium(movies);migratePremiumLedgerV3(movies);
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
        assert(path.basename(resolved).startsWith("nemo-premium-http-"));
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

test('isolated real-session Premium HTTP smoke', async t => {
 const f=await fixture(t);t.diagnostic(`Isolated loopback port: ${f.port}; temporary synthetic databases only.`);
 const root='/api/admin/premium';let cookie;
 const call=async(route,body,method,origin=`http://127.0.0.1:${f.port}`)=>{
  const r=await f.request(route,{body,method,cookie,origin});
  return {...r,data:JSON.parse(r.text)};
 };
 assert.equal((await call(root+'/stats')).status,401);
 assert.equal((await f.login({username:'TestAdmin',password:'wrong'})).status,401);
 const login=await f.login();assert.equal(login.status,200);cookie=login.cookie;assert(cookie);
 assert.equal((await call('/api/admin/check')).status,200);
 assert.equal((await call(root+'/users',{telegram_user_id:101},'POST','https://wrong.invalid')).status,403);
 assert.equal((await call(root+'/users',{telegram_user_id:101},'POST','null')).status,403);
 assert.equal((await call(root+'/users',{telegram_user_id:101,username:'fake-user'})).status,200);
 // Premium writes require Origin, while GET and non-Premium login keep their policy.
 assert.equal((await f.request(root+'/stats',{cookie})).status,200);
 assert.equal((await f.request(root+'/users',{body:{telegram_user_id:102},cookie})).status,403);
 assert.equal((await call(root+'/users',{telegram_user_id:102})).status,200);
 assert.equal((await f.request(root+'/users',{body:{telegram_user_id:999},origin:`http://127.0.0.1:${f.port}`})).status,401);
 const req=async(uid=101,plan='MONTH_1')=>call(root+'/payments/request',{telegram_user_id:uid,plan,payment_method:'KBZPAY'});
 const p=(await req()).data;assert.match(p.payment_request_code,/^NM-[A-HJ-NP-Z2-9]{6}$/);assert.equal(p.amount_mmk,2000);assert.equal(p.plan_days,30);assert.equal(Date.parse(p.request_expires_at)-Date.parse(p.created_at),86400000);
 assert.equal((await req()).data.id,p.id);assert.equal(f.runtime.db.prepare('SELECT COUNT(*) n FROM payments').get().n,1);
 assert.equal((await call(root+'/pending')).data.total,1);
 const lookup=(await call(root+'/payments/request/'+p.payment_request_code)).data;assert.equal(lookup.telegram_user_id,101);assert.equal(lookup.status,'PENDING');assert.equal(lookup.plan,'MONTH_1');assert.equal(lookup.payment_method,'KBZPAY');assert.equal(lookup.request_expires_at,p.request_expires_at);
 const confirm=async(pid,ref)=>call(root+`/payments/${pid}/confirm`,{transaction_reference:ref,payment_at:new Date().toISOString()});
 for(const [route,body] of [
  ['/payments/request',{telegram_user_id:101,plan:'BAD',payment_method:'KBZPAY'}],
  ['/payments/request',{telegram_user_id:101,plan:'MONTH_1',payment_method:'BAD'}],
  ['/payments/request',{telegram_user_id:[],plan:'MONTH_1',payment_method:'KBZPAY'}],
  [`/payments/${p.id}/confirm`,{transaction_reference:' ',payment_at:new Date().toISOString()}],
  [`/payments/${p.id}/confirm`,{transaction_reference:'fake',payment_at:'bad'}]])assert.equal((await call(root+route,body)).status,400);
 for(const route of ['/payments/request/bad','/users?page=0','/users?status=BAD','/users?sort=BAD'])assert.equal((await call(root+route)).status,400);
 const activation=await confirm(p.id,'fake-first');assert.equal(activation.status,200);const m=activation.data.membership;
 assert.equal(activation.data.payment.confirmed_by,'TestAdmin');assert.equal(Date.parse(m.expires_at)-Date.parse(m.start_at),30*86400000);assert.equal(m.reminder_1d_sent_at,null);assert.equal(m.reminder_2d_sent_at,null);
 assert(!/password_hash|session_secret|credential_version/i.test(activation.text));
 assert.deepEqual((await confirm(p.id,'fake-first')).data.membership,m);assert.equal(f.runtime.db.prepare('SELECT COUNT(*) n FROM premium_membership_effects').get().n,1);
 const next=(await req()).data;const renewed=(await confirm(next.id,'fake-renewal')).data.membership;assert.equal(renewed.start_at,m.start_at);assert.equal(Date.parse(renewed.expires_at)-Date.parse(m.expires_at),30*86400000);
 const correction=await call(root+`/payments/${p.id}/correct`,{reason:'fake correction',plan:'MONTH_3',payment_method:'KBZPAY'});assert.equal(correction.status,200);assert.equal(correction.data.original.status,'CORRECTED');const replacement=correction.data.replacement;assert.equal(replacement.status,'PENDING');assert.deepEqual((await call(root+'/users/101')).data.membership,renewed);
 const corrected=(await confirm(replacement.id,'fake-replacement')).data.membership;assert.equal(Date.parse(corrected.expires_at)-Date.parse(m.start_at),120*86400000);
 const effects=f.runtime.db.prepare('SELECT event_order,revision FROM premium_membership_effects ORDER BY event_order,revision').all();assert.deepEqual(effects,[{event_order:1,revision:1},{event_order:1,revision:2},{event_order:2,revision:1}]);
 assert.deepEqual((await confirm(replacement.id,'fake-replacement')).data.membership,corrected);
 const start=new Date().toISOString(),expires=new Date(Date.now()+10*86400000).toISOString();
 assert.equal((await call(root+'/users/101/membership',{start_at:start,expires_at:expires,reason:''},'PUT')).status,400);
 assert.equal((await call(root+'/users/101/membership',{start_at:start,expires_at:start,reason:'test'},'PUT')).status,400);
 assert.equal((await f.request(root+'/users/101/membership',{body:{start_at:start,expires_at:expires,reason:'test'},method:'PUT',cookie})).status,403);
 const manual=await call(root+'/users/101/membership',{start_at:start,expires_at:expires,reason:'fake manual correction'},'PUT');assert.equal(manual.status,200);assert.equal(manual.data.expires_at,expires);
 assert.equal(f.runtime.db.prepare("SELECT COUNT(*) n FROM premium_membership_effects WHERE effect_type='MEMBERSHIP_CORRECTION'").get().n,1);assert(f.runtime.db.prepare("SELECT COUNT(*) n FROM membership_audit_log WHERE action='MEMBERSHIP_CORRECTION'").get().n>0);
 assert.deepEqual((await call(root+'/stats')).data,{totalPremiumUsers:1,activePremium:1,expiredPremium:0,totalIncome:7000});
 assert.equal((await call(root+'/users?search=fake-user&status=ACTIVE&sort=username_az')).data.total,1);assert.equal((await call(root+'/users?status=EXPIRED')).data.total,0);
 const unpaid=(await req(102)).data;assert.equal((await call(root+`/payments/${unpaid.id}/void`,{})).status,400);assert.equal((await call(root+`/payments/${unpaid.id}/void`,{reason:'fake void'})).status,200);assert.equal((await call(root+`/payments/${next.id}/void`,{reason:'fake void'})).status,409);
 const expired=(await req(102)).data;f.runtime.db.prepare("UPDATE payments SET request_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(expired.id);
 assert.equal((await confirm(expired.id,'fake-expired')).status,409);assert.equal((await call(root+'/pending')).data.total,0);
 const freshPending=(await req(102)).data;assert.equal(freshPending.status,'PENDING');assert.equal((await req(102)).data.id,freshPending.id);assert.equal(f.runtime.db.prepare('SELECT 1 FROM payments WHERE payment_request_code=?').get(expired.payment_request_code),undefined);assert.equal(f.runtime.db.prepare("SELECT COUNT(*) n FROM payments WHERE status='CONFIRMED'").get().n,2);
 // Add fake users through HTTP to exercise actual default list pagination.
 for(let uid=200;uid<224;uid++){await call(root+'/users',{telegram_user_id:uid,username:'fake'+uid});const payment=(await req(uid)).data;assert.equal((await confirm(payment.id,'fake-'+uid)).status,200);}
 const expiredMember=await call(root+'/users/200/membership',{start_at:'2000-01-01T00:00:00.000Z',expires_at:'2000-02-01T00:00:00.000Z',reason:'fake expired member'},'PUT');assert.equal(expiredMember.status,200);
 assert.equal((await call(root+'/users?status=EXPIRED')).data.total,1);assert.equal((await call(root+'/users?status=ACTIVE')).data.total,24);
 assert.deepEqual((await call(root+'/stats')).data,{totalPremiumUsers:25,activePremium:24,expiredPremium:1,totalIncome:55000});
 assert.equal((await call(root+'/users')).data.users.length,24);assert.equal((await call(root+'/users?page=2')).data.users.length,1);
 for(let n=0;n<20;n++){const payment=(await req(101)).data;await call(root+`/payments/${payment.id}/void`,{reason:'fake history'});}
 assert.equal((await call(root+'/users/101/payments')).data.payments.length,20);
 const statusUrl='/api/internal/premium/users/101/status';assert.equal((await call(statusUrl)).status,503);
 f.env.PREMIUM_STATUS_SECRET='synthetic-status-only';assert.equal((await call(statusUrl)).status,401);
 // Use native HTTP to send authorization without changing production helpers.
 async function statusRequest(secret){const response=await fetch(`http://127.0.0.1:${f.port}${statusUrl}`,{headers:{Authorization:'Bearer '+secret}});return {status:response.status,headers:response.headers,data:await response.json()};}
 assert.equal((await statusRequest('wrong')).status,401);const status=await statusRequest('synthetic-status-only');assert.equal(status.status,200);assert.equal(status.headers.get('cache-control'),'no-store');assert.deepEqual(Object.keys(status.data).sort(),['expires_at','start_at','status']);
 assert.equal((await f.request('/api/logout',{body:{},cookie})).status,200);assert.equal((await call(root+'/stats')).status,401);
});

