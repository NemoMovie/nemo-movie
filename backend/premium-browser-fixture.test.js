import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import Database from 'better-sqlite3';
import { startPremiumBrowserFixture, validateFixturePort, SYNTHETIC_LOGIN } from './premium-browser-fixture.js';

async function freePort() {
    const s = net.createServer();
    await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
    const port = s.address().port;
    await new Promise(resolve => s.close(resolve));
    return validateFixturePort(port);
}
function request(f, route, { method = 'GET', body, cookie, origin, host } = {}) {
    assert.notEqual(f.port, 3000);
    assert.equal(f.address.address, '127.0.0.1');
    return new Promise((resolve, reject) => {
        const headers = { Host: host ?? `127.0.0.1:${f.port}`, 'Content-Type': 'application/json' };
        if (origin !== undefined) headers.Origin = origin;
        if (cookie) headers.Cookie = cookie;
        const req = http.request({ hostname: '127.0.0.1', port: f.port, path: route, method, headers }, res => {
            let text = ''; res.on('data', chunk => text += chunk);
            res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers,
                cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }));
        });
        req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
}

test('fixture port validation fails closed, including production and wildcard binds', async () => {
    for (const port of [3000, '3000', 0, -1, 80, 65536, '3101x', '0.0.0.0', '3000.0', ' 3000 ']) {
        assert.throws(() => validateFixturePort(port));
        await assert.rejects(startPremiumBrowserFixture({ port }));
    }
    assert.equal(validateFixturePort('3101'), 3101);
});

test('occupied port fails without fallback and removes its temporary databases', async () => {
    const blocker = net.createServer();
    const port = await freePort();
    await new Promise(resolve => blocker.listen(port, '127.0.0.1', resolve));
    const snapshots = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('nemo-premium-browser-')).sort();
    const before = snapshots();
    try { await assert.rejects(startPremiumBrowserFixture({ port }), /failed to start/); assert.deepEqual(snapshots(), before); }
    finally { await new Promise(resolve => blocker.close(resolve)); }
});

test('cleanup refuses changed ownership instead of deleting an unowned tree', async () => {
    const f = await startPremiumBrowserFixture({ port: await freePort() });
    const marker = path.join(f.directory, 'FIXTURE-OWNER.json');
    fs.writeFileSync(marker, JSON.stringify({ runId: 'different-owner', synthetic: true }));
    await assert.rejects(f.close(), /ownership check/);
    assert(fs.existsSync(f.directory));
    // Test-only removal after the fixture has closed all handles and the refusal is verified.
    assert.equal(path.dirname(f.directory).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert(path.basename(f.directory).startsWith('nemo-premium-browser-'));
    assert(!fs.lstatSync(f.directory).isSymbolicLink());
    fs.rmSync(f.directory, { recursive: true });
});

test('isolated browser fixture: real auth, Premium routes, assets and cleanup', async t => {
    // Only temporary canaries; never supply real production paths or read real .env files.
    const canaries = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-fixture-canary-'));
    const old = {};
    const names = ['DATABASE_PATH', 'ADMIN_DATABASE_PATH', 'SESSION_DATABASE_PATH', 'UPLOADS_DIR', 'NODE_ENV', 'PORT'];
    let f;
    try {
        for (const key of names) { old[key] = process.env[key]; process.env[key] = path.join(canaries, key); }
        process.env.NODE_ENV = 'production'; process.env.PORT = '3000';
        for (const key of names.slice(0, 4)) fs.writeFileSync(path.join(canaries, key), 'DO NOT OPEN OR MODIFY');
        f = await startPremiumBrowserFixture({ port: await freePort() });
    } finally {
        for (const key of names) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
        for (const key of names.slice(0, 4)) assert.equal(fs.readFileSync(path.join(canaries, key), 'utf8'), 'DO NOT OPEN OR MODIFY');
        assert.equal(path.dirname(canaries), path.resolve(os.tmpdir()));
        assert(path.basename(canaries).startsWith('nemo-fixture-canary-'));
        fs.rmSync(canaries, { recursive: true });
    }
    t.after(() => f.close());
    let cookie;
    await t.test('fresh temp paths, loopback, scoped assets, banners, redirect and CSP', async () => {
        assert.equal(f.address.address, '127.0.0.1'); assert.notEqual(f.port, 3000);
        assert.equal(path.dirname(f.paths.movies), f.directory);
        assert.equal(path.dirname(f.paths.admin), f.directory);
        assert.equal(path.dirname(f.paths.sessions), f.directory);
        assert(fs.existsSync(f.paths.uploads));
        for (const page of ['login', 'premium-admin', 'premium-users', 'pending-payments', 'premium-payments', 'confirm-payment', 'premium-user-details', 'customer-service']) {
            const r = await request(f, '/' + page + '.html');
            assert.equal(r.status, 200); assert.match(r.text, /SYNTHETIC DATA ONLY/);
            assert.match(r.headers['content-security-policy'], /connect-src 'self'/);
        }
        assert.equal((await request(f, '/admin.html')).headers.location, '/premium-admin.html');
        for (const route of ['/server.js', '/.env', '/movies.db', '/sessions.db', '/uploads/anything', '/api/movies', '/api/admin/account', '/api/internal/premium/users/101/status']) assert.equal((await request(f, route)).status, 404);
        assert.equal((await request(f, '/login.html', { host: 'nemomovie.com' })).status, 403);
    });
    await t.test('normal login, no bypass, cookie isolation and authenticated check', async () => {
        assert.equal((await request(f, '/api/admin/premium/stats')).status, 401);
        assert.equal((await request(f, '/api/login', { method: 'POST', body: SYNTHETIC_LOGIN })).status, 403);
        assert.equal((await request(f, '/api/login', { method: 'POST', origin: f.origin, body: { ...SYNTHETIC_LOGIN, password: 'wrong' } })).status, 401);
        const r = await request(f, '/api/login', { method: 'POST', origin: f.origin, body: SYNTHETIC_LOGIN });
        assert.equal(r.status, 200); cookie = r.cookie;
        assert(cookie.startsWith(f.cookieName + '=')); assert(!cookie.startsWith('connect.sid='));
        assert.match(r.headers['set-cookie'][0], /HttpOnly/); assert.match(r.headers['set-cookie'][0], /SameSite=Lax/);
        assert.equal((await request(f, '/api/admin/check', { cookie })).status, 200);
    });
    await t.test('synthetic active/expired users, history pagination and pending request', async () => {
        const get = async route => JSON.parse((await request(f, '/api/admin/premium' + route, { cookie })).text);
        assert.equal((await get('/users/101')).status, 'ACTIVE');
        assert.equal((await get('/users/202')).status, 'EXPIRED');
        assert.equal((await get('/users/101/payments')).payments.length, 20);
        assert.equal((await get('/users/101/payments?page=2')).payments.length, 4);
        assert.equal((await get('/payments')).total, 25);
        assert.equal((await get('/pending')).total, 1);
        const cases = await get('/cases');
        assert.equal(cases.total, 6);
        assert.equal(new Set(cases.cases.map(c => c.status)).size, 6);
        const open = await get('/cases?status=OPEN');
        assert.equal(open.total, 3);
        assert.deepEqual(open.cases.map(c => c.status).sort(), ['CONFIRMED','WAITING_PAYMENT','WAITING_VERIFICATION']);
        assert.deepEqual(await get('/cases?status=ALL'), cases);
        for (const status of ['WAITING_PAYMENT','WAITING_VERIFICATION','CANCELLED','CONFIRMED','COMPLETED','REJECTED']) {
            const exact = await get('/cases?status=' + status);
            assert.equal(exact.total, 1); assert.equal(exact.cases[0].status, status);
        }
        const oldest = await get('/cases?status=OPEN&search=fixture_case&sort=oldest&limit=1&page=1');
        const second = await get('/cases?status=OPEN&search=fixture_case&sort=oldest&limit=1&page=2');
        assert.equal(oldest.total, 3); assert.equal(oldest.totalPages, 3);
        assert.equal(oldest.cases.length, 1); assert(oldest.cases[0].id < second.cases[0].id);
        assert.equal(open.cases[0].status, 'CONFIRMED');
        assert.equal((await get('/cases?status=OPEN&search=305')).total, 0);
        assert.equal((await get('/cases?status=OPEN&search=301')).total, 1);
    });
    await t.test('real correction with Origin/auth, audit and no fake payment', async () => {
        const route = '/api/admin/premium/users/101/membership';
        const body = { start_at: '2026-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', reason: 'Synthetic browser fixture correction' };
        assert.equal((await request(f, route, { method: 'PUT', cookie, body })).status, 403);
        assert.equal((await request(f, route, { method: 'PUT', cookie, body, origin: 'https://wrong.invalid' })).status, 403);
        assert.equal((await request(f, route, { method: 'PUT', body, origin: f.origin })).status, 401);
        assert.equal((await request(f, route, { method: 'PUT', cookie, body, origin: f.origin })).status, 200);
        const d = JSON.parse((await request(f, '/api/admin/premium/users/101', { cookie })).text);
        assert.equal(d.membership.expires_at, body.expires_at);
        const db = new Database(f.paths.movies, { readonly: true, fileMustExist: true });
        try {
            assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 26);
            assert.equal(db.prepare("SELECT reason FROM membership_audit_log WHERE action='MEMBERSHIP_CORRECTION' LIMIT 1").get().reason, body.reason);
        } finally { db.close(); }
    });
    await t.test('logout destroys synthetic session and clears only fixture cookie', async () => {
        const r = await request(f, '/api/logout', { method: 'POST', cookie, origin: f.origin });
        assert.equal(r.status, 200); assert(r.headers['set-cookie'][0].startsWith(f.cookieName + '='));
        assert.equal((await request(f, '/api/admin/check', { cookie })).status, 401);
    });
    await t.test('cleanup removes only owned synthetic tree and is idempotent', async () => {
        const sibling = fs.mkdtempSync(path.join(path.dirname(f.directory), 'nemo-fixture-keep-'));
        try { await f.close(); await f.close(); assert(!fs.existsSync(f.directory)); assert(fs.existsSync(sibling)); }
        finally { assert(path.basename(sibling).startsWith('nemo-fixture-keep-')); fs.rmdirSync(sibling); }
    });
});
