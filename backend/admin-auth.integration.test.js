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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-auth-integration-"));
    const authPath = path.join(directory, "admin.db");
    const moviesPath = path.join(directory, "movies.db");
    const seed = createAdminAuth({ filename: authPath });
    await seed.initializeCredential("TestAdmin", " test password ");
    seed.close();
    const movies = new Database(moviesPath);
    movies.exec("CREATE TABLE movies (id INTEGER PRIMARY KEY, telegram_chat_id TEXT, telegram_message_id INTEGER)");
    movies.close();
    const logs = [];
    let wrappedAuth;
    let clock = Date.now();
    class Clock extends Date { static now() { return clock; } }
    const context = vm.createContext({ express, session, SQLiteSessionStore, Database, path, multer, fs,
        fileURLToPath, timingSafeEqual, randomUUID, validateDatabasePath,
        resolveMovieDatabasePath: directory => resolveMovieDatabasePath(directory, context.process.env), Date: Clock,
        createAdminAuth: options => { const store = createAdminAuth(options); wrappedAuth = { ...store }; return wrappedAuth; },
        setInterval, clearInterval,
        console: { log: message => logs.push(message), error: message => logs.push(message) },
        process: { env: { ADMIN_DATABASE_PATH: authPath, DATABASE_PATH: moviesPath,
            SESSION_DATABASE_PATH: path.join(directory, "sessions.db"), UPLOADS_DIR: path.join(directory, "uploads"),
            SESSION_SECRET: "synthetic-session-secret-only", NODE_ENV: "development",
            ADMIN_USERNAME: "EnvironmentOnly", ADMIN_PASSWORD: "environment-only-password" },
            exit: () => { throw new Error("Startup refused"); } }
    });
    const runtime = vm.runInContext(source + `
        app.set("trust proxy", 1);
        app.get("/test/protected", requireAdmin, (req,res) => res.json({ok:true}));
        app.post("/test/session", (req,res) => {
            req.session.isAdmin = req.body.isAdmin;
            if (req.body.version !== undefined) req.session.credentialVersion = req.body.version;
            res.json({ok:true});
        });
        app.use((error,req,res,next) => res.status(500).json({message:"Internal server error"}));
        ({app, sessionStore, db, loginCleanup});`, context);
    const listener = await new Promise(resolve => { const s = runtime.app.listen(0, "127.0.0.1", () => resolve(s)); });
    t.after(async () => {
        await new Promise(resolve => listener.close(resolve));
        clearInterval(runtime.loginCleanup);
        runtime.sessionStore.close(); wrappedAuth.close(); runtime.db.close();
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert(path.basename(resolved).startsWith("nemo-auth-integration-"));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    function request(route, { body, cookie, ip = "192.0.2.1", origin } = {}) {
        return new Promise((resolve, reject) => {
            const headers = { "Content-Type": "application/json", "X-Forwarded-For": ip };
            if (cookie) headers.Cookie = cookie;
            if (origin) headers.Origin = origin;
            const req = http.request({ hostname: "127.0.0.1", port: listener.address().port,
                path: route, method: body === undefined ? "GET" : "POST", headers }, res => {
                let text = ""; res.on("data", chunk => text += chunk);
                res.on("end", () => resolve({ status: res.statusCode, text,
                    cookie: res.headers["set-cookie"]?.[0]?.split(";")[0], headers: res.headers }));
            });
            req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
        });
    }
    const login = (body = { username: "TestAdmin", password: " test password " }, options = {}) => request("/api/login", { body, ...options });
    return { request, login, auth: wrappedAuth, authPath, logs, runtime,
        advance: ms => { clock += ms; } };
}

test("DB login, regenerated session, version-only authentication metadata and logout", async t => {
    const f = await fixture(t);
    const first = await f.login(); assert.equal(first.status, 200);
    assert.equal((await f.request("/api/admin/check", { cookie: first.cookie })).status, 200);
    assert.equal((await f.request("/test/protected", { cookie: first.cookie })).status, 200);
    const stored = f.runtime.sessionStore.db.prepare("SELECT session_json FROM sessions").all().map(r => JSON.parse(r.session_json));
    assert(stored.some(s => s.isAdmin === true && s.credentialVersion === 1));
    assert(stored.every(s => Object.keys(s).every(k => ["cookie", "isAdmin", "credentialVersion"].includes(k))));
    const next = await f.login(undefined, { cookie: first.cookie });
    assert.equal(next.status, 200); assert.notEqual(next.cookie, first.cookie);
    assert.equal((await f.request("/api/admin/check", { cookie: first.cookie })).status, 401);
    const logout = await f.request("/api/logout", { body: {}, cookie: next.cookie });
    assert.equal(logout.status, 200); assert.match(logout.headers["set-cookie"][0], /Expires=Thu, 01 Jan 1970/);
    assert.equal((await f.request("/api/admin/check", { cookie: next.cookie })).status, 401);
});

test("wrong/case-sensitive/whitespace credentials and no environment fallback", async t => {
    const f = await fixture(t);
    const cases = [["Wrong", " test password "], ["TestAdmin", "wrong"], ["testadmin", " test password "],
        ["TestAdmin", "test password"], ["EnvironmentOnly", "environment-only-password"]];
    for (let i = 0; i < cases.length; i++) {
        const [username, password] = cases[i];
        const result = await f.login({ username, password }, { ip: `192.0.2.${i + 10}` });
        assert.equal(result.status, 401); assert.equal(result.text, '{"message":"Invalid username or password"}');
        assert.equal(result.cookie, undefined);
    }
    assert.deepEqual(f.logs, []);
});

test("legacy, stale, malformed sessions rejected by both guards; version changes invalidate", async t => {
    const f = await fixture(t);
    for (const version of [undefined, 0, -1, 1.5, "1", 2]) {
        const seeded = await f.request("/test/session", { body: { isAdmin: true, version } });
        for (const route of ["/api/admin/check", "/test/protected"]) {
            assert.equal((await f.request(route, { cookie: seeded.cookie })).status, 401);
        }
    }
    const login = await f.login();
    await f.auth.updateCredential({ expectedVersion: 1, newUsername: "ChangedAdmin" });
    for (const route of ["/api/admin/check", "/test/protected"]) assert.equal((await f.request(route, { cookie: login.cookie })).status, 401);
});

test("five failures, separate IPs, reset, expiry, async concurrent failure accounting and Origin", async t => {
    const f = await fixture(t), bad = { username: "TestAdmin", password: "wrong" };
    for (let i = 0; i < 5; i++) assert.equal((await f.login(bad)).status, 401);
    assert.equal((await f.login()).status, 429);
    assert.equal((await f.login(undefined, { ip: "192.0.2.2" })).status, 200);
    f.advance(15 * 60 * 1000 + 1);
    assert.equal((await f.login()).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await f.login(bad)).status, 401);
    assert.equal((await f.login()).status, 200);
    assert.equal((await f.login(bad)).status, 401);
    const results = await Promise.all(Array.from({length: 6}, () => f.login({username:"Wrong",password:"wrong"}, {ip:"192.0.2.3"})));
    assert.equal(results.filter(r => r.status === 401).length, 5);
    assert.equal(results.filter(r => r.status === 429).length, 1);
    assert.equal((await f.login(undefined, { origin: "https://other.invalid" })).status, 403);
});

test("unavailable DB fails closed at runtime without exposing errors", async t => {
    const f = await fixture(t), login = await f.login();
    f.auth.close();
    for (const route of ["/api/admin/check", "/test/protected"]) {
        const result = await f.request(route, { cookie: login.cookie });
        assert.equal(result.status, 500); assert.equal(result.text, '{"message":"Internal server error"}');
    }
    assert.equal((await f.login()).text, '{"message":"Login failed"}');
    assert.deepEqual(f.logs, []);
});

test("credential-version race during verification and regeneration fails safely", async t => {
    const f = await fixture(t);
    const original = f.auth.verifyCredential;
    f.auth.verifyCredential = async (...args) => {
        const verified = await original(...args);
        await f.auth.updateCredential({ expectedVersion: 1, newUsername: "Renamed" });
        return verified;
    };
    assert.equal((await f.login()).status, 401);
    f.auth.verifyCredential = original;
    const regenerate = f.runtime.sessionStore.regenerate.bind(f.runtime.sessionStore);
    f.runtime.sessionStore.regenerate = (req, callback) => regenerate(req, error => {
        f.auth.updateCredential({ expectedVersion: 2, newUsername: "AgainRenamed" })
            .then(() => callback(error), () => callback(new Error("test failure")));
    });
    const result = await f.login({username:"Renamed",password:" test password "});
    assert.equal(result.status, 401);
    assert.equal((await f.request("/api/admin/check", {cookie:result.cookie})).status, 401);
});

test("existing-only startup refuses missing, empty, corrupt or invalid credential storage", async t => {
    const f = await fixture(t);
    const missing = path.join(path.dirname(f.authPath), "missing.db");
    assert.throws(() => createAdminAuth({filename:missing, requireExisting:true}));
    assert.equal(fs.existsSync(missing), false);
    for (const contents of ["", "not sqlite"]) {
        const file = path.join(path.dirname(f.authPath), "invalid.db"); fs.writeFileSync(file, contents);
        assert.throws(() => createAdminAuth({filename:file,requireExisting:true}));
    }
    const inspect = new Database(f.authPath);
    try { inspect.prepare("UPDATE admin_credentials SET password_hash = ? WHERE id = 1").run("malformed"); }
    finally { inspect.close(); }
    assert.throws(() => createAdminAuth({filename:f.authPath,requireExisting:true}));
    assert.equal((await f.login()).status, 500);
});
