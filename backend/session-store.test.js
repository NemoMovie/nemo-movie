import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import session from "express-session";
import Database from "better-sqlite3";
import SQLiteSessionStore from "./session-store.js";

const call = (store, method, ...args) => new Promise((resolve, reject) =>
    store[method](...args, (error, value) => error ? reject(error) : resolve(value)));
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-session-test-"));
    const filename = path.join(directory, "sessions.db");
    const movieDatabasePath = path.join(directory, "movies.db");
    let now = Date.now();
    const stores = [];
    const open = () => {
        const store = new SQLiteSessionStore({ filename, movieDatabasePath, now: () => now });
        stores.push(store);
        return store;
    };
    t.after(() => {
        for (const store of stores) store.close();
        // Delete only this test's uniquely created temporary directory.
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { filename, movieDatabasePath, open, advance: ms => { now += ms; },
        value: () => ({ cookie: { expires: new Date(now + 1000).toISOString(), maxAge: 1000 }, isAdmin: true }) };
}

test("set/get, restart persistence, expiration and destroy", async t => {
    const f = fixture(t);
    let store = f.open();
    await call(store, "set", "one", f.value());
    assert.equal((await call(store, "get", "one")).isAdmin, true);
    await call(store, "close");
    store = f.open();
    assert.equal((await call(store, "get", "one")).isAdmin, true);
    f.advance(1000);
    assert.equal(await call(store, "get", "one"), null);
    await call(store, "set", "two", f.value());
    await call(store, "destroy", "two");
    assert.equal(await call(store, "get", "two"), null);
});

test("touch extends valid sessions but cannot resurrect missing/destroyed/expired rows", async t => {
    const f = fixture(t), store = f.open();
    await call(store, "set", "one", f.value());
    f.advance(500);
    await call(store, "touch", "one", f.value());
    f.advance(600);
    assert.equal((await call(store, "get", "one")).isAdmin, true);
    await call(store, "destroy", "one");
    await call(store, "touch", "one", f.value());
    assert.equal(await call(store, "get", "one"), null);
    await call(store, "set", "expired", f.value());
    f.advance(1001);
    await call(store, "touch", "expired", f.value());
    assert.equal(await call(store, "get", "expired"), null);
    await call(store, "touch", "missing", f.value());
    assert.equal(await call(store, "get", "missing"), null);
});

test("corrupt JSON removed; cleanup, timer and close", async t => {
    const f = fixture(t), store = f.open();
    assert.equal(store.timer.hasRef(), false);
    const inspect = new Database(f.filename);
    try {
        for (const json of ["broken", "null", "[]", '{"cookie":null}']) {
            inspect.prepare("INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)").run("bad", json, Date.now() + 60000);
            assert.equal(await call(store, "get", "bad"), null);
            assert.equal(inspect.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
        }
        await call(store, "set", "expired", f.value());
        f.advance(1001);
        await call(store, "cleanup");
        assert.equal(inspect.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
    } finally { inspect.close(); }
    await call(store, "close");
    await call(store, "close");
    await assert.rejects(call(store, "get", "one"), /Session store operation failed/);
});

test("movie path and hardlink aliases rejected before modification", t => {
    const f = fixture(t);
    fs.writeFileSync(f.movieDatabasePath, "sentinel");
    assert.throws(() => new SQLiteSessionStore({ filename: f.movieDatabasePath, movieDatabasePath: f.movieDatabasePath }));
    fs.linkSync(f.movieDatabasePath, f.filename);
    assert.throws(() => f.open());
    assert.equal(fs.readFileSync(f.movieDatabasePath, "utf8"), "sentinel");
});

test("database failure callbacks are sanitized and called once", async t => {
    const f = fixture(t), store = f.open();
    store.db.exec("DROP TABLE sessions");
    for (const [method, args] of [["get", ["one"]], ["set", ["one", f.value()]], ["destroy", ["one"]], ["touch", ["one", f.value()]], ["cleanup", []]]) {
        let count = 0;
        store[method](...args, error => { count++; assert.equal(error.message, "Session store operation failed."); });
        assert.equal(count, 1);
    }
});

test("concurrent operations; document late explicit set after logout", async t => {
    const f = fixture(t), store = f.open();
    await Promise.all(Array.from({ length: 30 }, (_, i) => call(store, "set", String(i), f.value())));
    const values = await Promise.all(Array.from({ length: 30 }, (_, i) => call(store, "get", String(i))));
    assert(values.every(v => v.isAdmin));
    const stale = f.value();
    await call(store, "destroy", "0");
    await call(store, "touch", "0", stale);
    assert.equal(await call(store, "get", "0"), null);
    // Store.set is an upsert: explicit stale saves require revocation to prevent resurrection.
    await call(store, "set", "0", stale);
    assert.equal((await call(store, "get", "0")).isAdmin, true);
});

test("Express regeneration, authenticated requests, logout and eight-hour cookie", async t => {
    const f = fixture(t), store = f.open(), app = express();
    app.use(session({ store, secret: "isolated-test-secret-only", resave: false, saveUninitialized: false,
        cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: "lax", secure: false } }));
    app.post("/login", (req, res, next) => req.session.regenerate(error => {
        if (error) return next(error);
        req.session.isAdmin = true;
        res.json({ ok: true });
    }));
    app.get("/check", (req, res) => res.status(req.session.isAdmin ? 200 : 401).end());
    app.post("/logout", (req, res, next) => req.session.destroy(error => error ? next(error) : res.end()));
    const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    const request = (route, method = "GET", cookie) => new Promise((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: route, method,
            headers: cookie ? { Cookie: cookie } : {} }, res => { res.resume(); res.on("end", () => resolve(res)); });
        req.on("error", reject); req.end();
    });
    try {
        assert.equal((await request("/check")).statusCode, 401);
        const first = await request("/login", "POST");
        const header = first.headers["set-cookie"][0];
        assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Lax/);
        const expiry = new Date(header.match(/Expires=([^;]+)/)[1]).getTime();
        assert(Math.abs(expiry - Date.now() - 8 * 60 * 60 * 1000) < 5000);
        const cookie = header.split(";")[0];
        assert.equal((await request("/check", "GET", cookie)).statusCode, 200);
        const second = await request("/login", "POST", cookie);
        const replacement = second.headers["set-cookie"][0].split(";")[0];
        assert.notEqual(replacement, cookie);
        assert.equal((await request("/check", "GET", cookie)).statusCode, 401);
        await request("/logout", "POST", replacement);
        assert.equal((await request("/check", "GET", replacement)).statusCode, 401);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
