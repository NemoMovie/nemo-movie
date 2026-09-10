import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import express from "express";
import session from "express-session";
import Database from "better-sqlite3";
import { timingSafeEqual } from "node:crypto";

const source = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
const fields = "id poster title genres year review fileSize quality duration rating type episodes categories series_status".split(" ");
// Run actual route and authorization code, without production startup or databases.
const guards = source.slice(source.indexOf("function validAdminSession("), source.indexOf('app.get("/api/admin/check"')) +
    source.slice(source.indexOf("function requireAdmin("), source.indexOf("// GET movies with search"));
const routes = source.slice(source.indexOf("// GET movies with search"), source.indexOf("// Add movie or series"));

async function fixture(t, secret = "test-mapping-secret") {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-mapping-access-"));
    const db = new Database(path.join(directory, "movies.db"));
    db.exec(`CREATE TABLE movies (
        id INTEGER PRIMARY KEY, poster TEXT, title TEXT, genres TEXT, year INTEGER,
        review TEXT, fileSize TEXT, quality TEXT, duration TEXT, rating REAL, type TEXT,
        episodes INTEGER, categories TEXT, series_status TEXT, link TEXT,
        telegram_chat_id TEXT, telegram_message_id INTEGER, future_private_field TEXT);
        CREATE TABLE series_episodes (id INTEGER PRIMARY KEY, series_id INTEGER,
        episode_number INTEGER, telegram_chat_id TEXT, telegram_message_id INTEGER,
        UNIQUE(series_id, episode_number));`);
    const insert = db.prepare("INSERT INTO movies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const [id, type, title] of [[1, "movie", "Love Movie"], [2, "series", "Love Series"], [3, "movie", "Other Movie"]]) {
        insert.run(id, "/uploads/test.webp", title, "Drama", 2020, "Full review", "1 GB", "HD",
            "90 min", 8, type, type === "series" ? 10 : null, "Thailand", type === "series" ? "ongoing" : null,
            "https://example.invalid/legacy", "synthetic-storage", 123, "private");
    }
    db.prepare("INSERT INTO series_episodes VALUES (?, ?, ?, ?, ?)").run(1, 2, 1, "synthetic-storage", 456);
    const app = express();
    app.use(express.json());
    const store = new session.MemoryStore();
    app.use(session({ store, secret: "isolated-test-secret", resave: false, saveUninitialized: false }));
    // Test-only session setup; real login/regeneration is covered by admin-auth.integration.test.js.
    app.post("/test/session", (req, res) => {
        req.session.isAdmin = true;
        req.session.credentialVersion = 1;
        res.json({ ok: true });
    });
    const writes = source.slice(source.indexOf("function requireAutomaticMapping("), source.indexOf("// Validate the parent and episode number for admin episode mutations"));
    vm.runInNewContext(guards + routes + writes, { app, db, Buffer, timingSafeEqual,
        process: { env: { MAPPING_API_SECRET: secret, STORAGE_GROUP_ID: "synthetic-storage" } },
        adminAuth: { getCredential: () => ({ credential_version: 1 }) } });
    const listener = await new Promise(resolve => {
        const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
    t.after(async () => {
        await new Promise(resolve => listener.close(resolve));
        store.clear();
        db.close();
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert(path.basename(directory).startsWith("nemo-mapping-access-"));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return async (route, cookie, method = "GET", authorization, body) => {
        const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, {
            method, headers: { ...(cookie ? { Cookie: cookie } : {}),
                ...(authorization ? { Authorization: authorization } : {}), "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, headers: response.headers, body: await response.json() };
    };
}

function publicMetadata(movie) {
    assert.deepEqual(Object.keys(movie).sort(), [...fields].sort());
    for (const key of ["telegram_chat_id", "telegram_message_id", "link", "future_private_field"]) {
        assert.equal(Object.hasOwn(movie, key), false);
    }
    assert.equal(movie.poster, "/uploads/test.webp");
    assert.equal(movie.review, "Full review");
}

test("anonymous catalogue and detail expose only public metadata", async t => {
    const request = await fixture(t);
    const list = await request("/api/movies");
    assert.equal(list.status, 200);
    assert.deepEqual(Object.keys(list.body).sort(), ["movies", "total"]);
    assert.equal(list.body.total, 3);
    assert.deepEqual(list.body.movies.map(m => m.id), [3, 2, 1]);
    list.body.movies.forEach(publicMetadata);
    for (const id of [1, 2]) {
        const detail = await request(`/api/movies/${id}`);
        assert.equal(detail.status, 200);
        publicMetadata(detail.body);
    }
    assert.equal((await request("/api/movies/invalid")).status, 400);
    assert.equal((await request("/api/movies/999")).status, 404);
});

test("catalogue filters, pagination and bot limit remain compatible", async t => {
    const request = await fixture(t);
    const filtered = await request("/api/movies?search=love&type=series&category=Thailand");
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.movies[0].id, 2);
    const page = await request("/api/movies?limit=1&page=2");
    assert.equal(page.body.total, 3);
    assert.deepEqual(page.body.movies.map(m => m.id), [2]);
    assert.equal((await request("/api/movies?limit=500")).body.movies.length, 3);
    for (const query of ["page=0", "limit=501", "search=" + "x".repeat(151)]) {
        assert.equal((await request("/api/movies?" + query)).status, 400);
    }
});

test("Admin detail requires authentication and returns full uncached record", async t => {
    const request = await fixture(t);
    assert.equal((await request("/api/admin/movies/1")).status, 401);
    const login = await request("/test/session", undefined, "POST");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const detail = await request("/api/admin/movies/1", cookie);
    assert.equal(detail.status, 200);
    assert.equal(detail.headers.get("cache-control"), "no-store");
    assert.equal(detail.body.telegram_chat_id, "synthetic-storage");
    assert.equal(detail.body.telegram_message_id, 123);
    assert.equal(detail.body.link, "https://example.invalid/legacy");
    for (const key of fields) assert(Object.hasOwn(detail.body, key));
    for (const id of ["invalid", "0", "-1", "1.5", "9007199254740992"]) {
        assert.equal((await request(`/api/admin/movies/${id}`, cookie)).status, 400);
    }
    assert.equal((await request("/api/admin/movies/999", cookie)).status, 404);
    assert.equal((await request("/api/admin/movies", cookie)).body[0].telegram_chat_id, "synthetic-storage");
});

test("Bearer mapping reads preserve responses and public episode list", async t => {
    const rawRequest = await fixture(t);
    const request = route => rawRequest(route, undefined, "GET", "Bearer test-mapping-secret");
    const movie = await request("/api/movies/1/telegram");
    assert.equal(movie.status, 200);
    assert.deepEqual(movie.body, { id: 1, title: "Love Movie", telegram_chat_id: "synthetic-storage", telegram_message_id: 123 });
    const episode = await request("/api/series/2/episodes/1/telegram");
    assert.equal(episode.status, 200);
    assert.equal(movie.headers.get("cache-control"), "no-store");
    assert.equal(episode.headers.get("cache-control"), "no-store");
    assert.deepEqual(episode.body, { telegram_chat_id: "synthetic-storage", telegram_message_id: 456 });
    assert.deepEqual((await request("/api/series/2/episodes")).body, [{ id: 1, series_id: 2, episode_number: 1 }]);
    assert.equal((await request("/api/movies/999/telegram")).status, 404);
    assert.equal((await request("/api/series/2/episodes/99/telegram")).status, 404);
    assert.equal((await request("/api/series/1/episodes/1/telegram")).status, 404);
});

test("anonymous/invalid authorization rejected; current Admin sessions accepted", async t => {
    const request = await fixture(t);
    const login = await request("/test/session", undefined, "POST");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    for (const route of ["/api/movies/1/telegram", "/api/series/2/episodes/1/telegram"]) {
        for (const token of [undefined, "Bearer wrong", "Bearer test-mapping-secrex"]) {
            assert.equal((await request(route, undefined, "GET", token)).status, 401);
        }
        const admin = await request(route, cookie);
        assert.equal(admin.status, 200);
        assert.equal(admin.headers.get("cache-control"), "no-store");
    }
    assert.equal((await request("/api/series/2/episodes")).status, 200);
});

test("missing secret fails closed with 503, including Admin reads", async t => {
    const request = await fixture(t, "");
    const login = await request("/test/session", undefined, "POST");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    for (const route of ["/api/movies/1/telegram", "/api/series/2/episodes/1/telegram"]) {
        assert.equal((await request(route)).status, 503);
        assert.equal((await request(route, cookie)).status, 503);
    }
});

test("automatic writes still authenticate, validate bodies and replace mappings", async t => {
    const request = await fixture(t);
    const token = "Bearer test-mapping-secret";
    for (const [write, read] of [["/api/internal/movies/1/telegram", "/api/movies/1/telegram"],
        ["/api/internal/series/2/episodes/1/telegram", "/api/series/2/episodes/1/telegram"]]) {
        const body = { telegram_chat_id: "synthetic-storage", telegram_message_id: 789 };
        assert.equal((await request(write, undefined, "PUT", undefined, body)).status, 401);
        assert.equal((await request(write, undefined, "PUT", token, { ...body, telegram_chat_id: "wrong" })).status, 403);
        assert.equal((await request(write, undefined, "PUT", token, { ...body, telegram_message_id: 0 })).status, 400);
        for (const id of [789, 790]) {
            assert.equal((await request(write, undefined, "PUT", token, { ...body, telegram_message_id: id })).status, 200);
            assert.equal((await request(read, undefined, "GET", token)).body.telegram_message_id, id);
        }
    }
    assert.equal((await request("/api/series/2/episodes")).body[0].id, 1);
});
