import { migratePaymentCaseDelivery } from './payment-case-delivery-migration.js';
import { migratePaymentBotIntake } from './payment-bot-intake-migration.js';
import { migratePaymentCaseCompletion } from './payment-case-completion-migration.js';
// Development only. Never import server.js: it loads .env and starts production initialization.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import Database from 'better-sqlite3';
import multer from 'multer';
import SQLiteSessionStore from './session-store.js';
import { createAdminAuth, validateNewUsername } from './admin-auth.js';
import { migratePremium } from './premium-migration.js';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
import { createPremiumService } from './premium-service.js';
import { registerPremiumRoutes } from './premium-routes.js';
import { migratePaymentCases } from './payment-case-migration.js';
import { migratePaymentCaseAdapter } from './payment-case-adapter-migration.js';
import { migratePaymentCaseWorkflow } from './payment-case-workflow-migration.js';
import { createPaymentCaseLifecycle } from './payment-case-lifecycle.js';
import { migratePaymentCaseAdmin } from './payment-case-admin-migration.js';
import { migratePaymentCaseConversation } from './payment-case-conversation-migration.js';
import { createPaymentCaseConversationService } from './payment-case-conversation.js';
import { createPaymentCaseAdminService } from './payment-case-admin.js';

export const SYNTHETIC_LOGIN = Object.freeze({ username: 'FixtureAdmin', password: 'Fixture-Only-Password-2026!' });
const backend = path.dirname(fileURLToPath(import.meta.url));
const repository = path.dirname(backend);
const frontend = path.join(repository, 'frontend');
const prefix = 'nemo-premium-browser-';
const assets = new Set(['login.html', 'login.js', 'login.css', 'config.js', 'nemo-movie-logo.png', 'premium-admin.css',
    ...['premium-admin', 'premium-users', 'pending-payments', 'premium-payments', 'confirm-payment', 'premium-user-details', 'customer-service'].flatMap(n => [n + '.html', n + '.js'])]);
const inside = (child, root) => { const r = path.relative(root, child); return r === '' || (!path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep)); };
const canonical = value => { const p = fs.realpathSync(value); return process.platform === 'win32' ? p.toLowerCase() : p; };

export function validateFixturePort(value) {
    if (!/^[1-9]\d*$/.test(String(value))) throw new Error('Invalid fixture port.');
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || port === 3000) throw new Error('Invalid fixture port.');
    return port;
}

// No caller-supplied data paths. Even DATABASE_PATH/ADMIN_DATABASE_PATH/etc. in the shell are ignored.
export async function startPremiumBrowserFixture({ port = 3101 } = {}) {
    port = validateFixturePort(port); // Reject before creating any files.
    const temp = canonical(os.tmpdir());
    if (inside(temp, canonical(repository)) || /^[eE]:/.test(temp) || /[\\/]NemoMovieData(?:[\\/]|$)/i.test(temp)) throw new Error('Unsafe fixture temporary root.');
    const directory = fs.mkdtempSync(path.join(temp, prefix));
    const identity = fs.statSync(directory, { bigint: true });
    const runId = randomUUID();
    const marker = path.join(directory, 'FIXTURE-OWNER.json');
    fs.writeFileSync(marker, JSON.stringify({ runId, synthetic: true }), { flag: 'wx', mode: 0o600 });
    const paths = Object.freeze({ movies: path.join(directory, 'synthetic-movies.db'), admin: path.join(directory, 'admin-auth.db'),
        sessions: path.join(directory, 'sessions.db'), uploads: path.join(directory, 'uploads') });
    const stores = [], timers = new Set();
    let listener, stopPremium, closePromise;
    const cookieName = 'nemo.fixture.' + runId;

    function checkDirectory() {
        const stat = fs.lstatSync(directory, { bigint: true });
        if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino ||
            path.dirname(directory) !== temp || !path.basename(directory).startsWith(prefix) || canonical(directory) !== (process.platform === 'win32' ? directory.toLowerCase() : directory) ||
            fs.lstatSync(marker).isSymbolicLink() || JSON.parse(fs.readFileSync(marker, 'utf8')).runId !== runId) throw new Error('Fixture ownership check failed.');
    }
    function checkPath(filename, expected) {
        checkDirectory();
        if (path.resolve(filename) !== expected || !inside(expected, directory)) throw new Error('Fixture path refused.');
        if (fs.existsSync(expected)) {
            const stat = fs.lstatSync(expected);
            if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink !== 1)) throw new Error('Fixture alias refused.');
        }
        return expected;
    }
    function checkTree(root) {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            const target = path.join(root, entry.name), stat = fs.lstatSync(target);
            if (stat.isSymbolicLink() || !inside(canonical(target), directory)) throw new Error('Fixture cleanup alias refused.');
            if (stat.isDirectory()) checkTree(target);
            else if (!stat.isFile() || stat.nlink !== 1) throw new Error('Fixture cleanup entry refused.');
        }
    }
    async function close() {
        if (closePromise) return closePromise;
        closePromise = (async () => {
            if (listener?.listening) await new Promise((resolve, reject) => { listener.close(e => e ? reject(e) : resolve()); listener.closeIdleConnections(); });
            stopPremium?.();
            for (const timer of timers) clearInterval(timer);
            for (const store of stores.reverse()) store.close();
            checkDirectory(); checkTree(directory);
            fs.rmSync(directory, { recursive: true, force: false });
        })();
        return closePromise;
    }
    try {
        for (const filename of [paths.movies, paths.admin, paths.sessions]) fs.closeSync(fs.openSync(filename, 'wx', 0o600));
        const auth = createAdminAuth({ filename: checkPath(paths.admin, paths.admin) });
        try { await auth.initializeCredential(SYNTHETIC_LOGIN.username, SYNTHETIC_LOGIN.password); } finally { auth.close(); }
        const seed = new Database(checkPath(paths.movies, paths.movies), { fileMustExist: true });
        try {
            seed.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY,telegram_chat_id TEXT,telegram_message_id INTEGER);CREATE TABLE series_episodes(id INTEGER PRIMARY KEY);');
            migratePremium(seed); migratePremiumLedgerV3(seed);
            migratePaymentCases(seed); migratePaymentCaseAdapter(seed); migratePaymentCaseAdmin(seed);
            migratePaymentCaseConversation(seed); migratePaymentCaseWorkflow(seed);
            const now = Date.now();
            const expired = createPremiumService(seed, { clock: () => now - 60 * 86400000 });
            expired.upsertUser({ telegram_user_id: 202, username: 'fixture_expired', first_name: 'Synthetic', last_name: 'Expired' });
            const old = expired.request({ telegram_user_id: 202, plan: 'MONTH_1', payment_method: 'AYA_PAY' });
            expired.confirm(old.id, { transaction_reference: 'FAKE-EXPIRED', payment_at: new Date(now - 60 * 86400000).toISOString() }, 'FixtureAdmin');
            const service = createPremiumService(seed);
            service.upsertUser({ telegram_user_id: 101, username: 'fixture_active', first_name: 'Synthetic', last_name: 'Active' });
            const paid = service.request({ telegram_user_id: 101, plan: 'MONTH_1', payment_method: 'KBZPAY' });
            service.confirm(paid.id, { transaction_reference: 'FAKE-ACTIVE', payment_at: new Date(now).toISOString() }, 'FixtureAdmin');
            // 22 harmless VOID records make the user history span multiple pages.
            for (let i = 0; i < 22; i++) {
                const p = service.request({ telegram_user_id: 101, plan: 'MONTH_1', payment_method: 'WAVE_MONEY' });
                service.void(p.id, { reason: 'Synthetic pagination fixture' }, 'FixtureAdmin');
            }
            service.request({ telegram_user_id: 101, plan: 'MONTH_3', payment_method: 'WAVE_MONEY' });
            const cases = createPaymentCaseAdminService(seed, { clock: () => now });
            const timestamp = new Date(now).toISOString();
            const conversation = createPaymentCaseConversationService(seed, { clock: () => now });
            for (const [index, state] of ['WAITING_PAYMENT','WAITING_VERIFICATION','CANCELLED','CONFIRMED','COMPLETED','REJECTED'].entries()) {
                const uid = 301 + index;
                service.upsertUser({ telegram_user_id: uid, username: 'fixture_case_' + uid, first_name: 'Synthetic', last_name: state });
                const caseId = Number(seed.prepare(`INSERT INTO payment_cases(telegram_user_id,plan,plan_days,amount_mmk,payment_method,payment_account_reference,created_at,updated_at) VALUES(?,'MONTH_1',30,2000,'KBZPAY','synthetic-account-v1',?,?)`).run(uid,timestamp,timestamp).lastInsertRowid);
                if (state !== 'CONFIRMED') {
                    const customer = (input, messageId) => conversation.appendCustomerMessage(caseId, { ...input, telegram_chat_id: String(uid), telegram_message_id: messageId }, { telegramUserId: uid });
                    if (state === 'WAITING_PAYMENT') {
                        customer({ message_type: 'PHOTO', telegram_file_id: 'SYNTHETIC-PHOTO' }, 1);
                        customer({ message_type: 'TEXT', text: '1473' }, 2);
                    }
                    customer({ message_type: 'TEXT', text: 'I already sent the synthetic payment.' }, 3);
                    customer({ message_type: 'TEXT', text: '<img src=x onerror=alert(1)>' }, 4);
                    conversation.prepareAdminMessage(caseId, { text: 'Please wait while we verify your payment.' }, { adminIdentifier: 'FixtureAdmin' });
                    conversation.appendSystemMessage(caseId, { text: 'Synthetic conversation recorded. No Telegram connection.' });
                }
                if (state === 'CANCELLED') { createPaymentCaseLifecycle(seed,{clock:()=>now}).cancel(caseId,uid); continue; }
                if (state === 'WAITING_PAYMENT') continue;
                for (const last of ['0123','1234']) seed.prepare('INSERT INTO payment_case_submissions(case_id,transaction_last_four,proof_file_id,created_at) VALUES(?,?,?,?)').run(caseId,last,'SYNTHETIC-PROOF-NOT-A-REAL-FILE',timestamp);
                seed.prepare("UPDATE payment_cases SET status='WAITING_VERIFICATION',submitted_at=? WHERE id=?").run(timestamp,caseId);
                if (state === 'REJECTED') cases.reject(caseId,{message:'Synthetic rejection for testing only.',reason_category:'PAYMENT_NOT_FOUND'},'FixtureAdmin');
                if (['CONFIRMED','COMPLETED'].includes(state)) {
                    if (state === 'CONFIRMED') seed.exec("CREATE TRIGGER fixture_fail_grant BEFORE INSERT ON premium_membership_effects BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END;");
                    try { cases.confirm(caseId,{payment_at:timestamp,plan:'MONTH_1',amount_mmk:2000,payment_method:'KBZPAY'},'FixtureAdmin'); if(state==='COMPLETED')cases.retry(caseId,{},'FixtureAdmin'); }
                    finally { if (state === 'CONFIRMED') seed.exec('DROP TRIGGER fixture_fail_grant'); }
                }
            }
        migratePaymentBotIntake(seed); migratePaymentCaseCompletion(seed); migratePaymentCaseDelivery(seed);
        } finally { seed.close(); }

        // Reuse the same bounded production auth initialization as premium-http.test.js.
        const serverUrl = new URL('./server.js', import.meta.url);
        const full = fs.readFileSync(serverUrl, 'utf8');
        const boundary = '// GET movies with search';
        if (full.split(boundary).length !== 2) throw new Error('Fixture auth boundary changed.');
        const source = full.split(boundary)[0].replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(serverUrl.href));
        if (/\bimport\b|\.listen\s*\(|registerPremiumRoutes\s*\(/.test(source)) throw new Error('Fixture auth boundary unsafe.');
        const env = Object.freeze({ NODE_ENV: 'development', DATABASE_PATH: paths.movies, ADMIN_DATABASE_PATH: paths.admin,
            SESSION_DATABASE_PATH: paths.sessions, UPLOADS_DIR: paths.uploads, SESSION_SECRET: randomBytes(32).toString('hex') });
        const origin = `http://127.0.0.1:${port}`;
        const fixtureExpress = Object.assign(() => {
            const app = express();
            app.use((req, res, next) => {
                res.set('Cache-Control', 'no-store');
                // Additional fixture restrictions: no proxy, LAN host, rebinding, or cross-site writes.
                if (req.get('Host') !== `127.0.0.1:${port}` || (req.get('Origin') && req.get('Origin') !== origin)) return res.sendStatus(403);
                if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('Origin') !== origin) return res.sendStatus(403);
                const csp = "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'";
                const setHeader = res.setHeader.bind(res);
                res.setHeader = (name, value) => setHeader(name, name.toLowerCase() === 'content-security-policy' ? csp : value);
                res.set('Content-Security-Policy', csp);
                const clearCookie = res.clearCookie.bind(res);
                res.clearCookie = (name, options) => clearCookie(name === 'connect.sid' ? cookieName : name, options);
                if (req.path === '/' || req.path === '/admin.html') return res.redirect('/premium-admin.html');
                const name = req.path.slice(1);
                if (assets.has(name) && ['GET', 'HEAD'].includes(req.method)) {
                    const filename = path.join(frontend, name);
                    if (fs.lstatSync(filename).isSymbolicLink() || !inside(canonical(filename), canonical(frontend))) return res.sendStatus(404);
                    if (!name.endsWith('.html')) return res.sendFile(filename, { cacheControl: false });
                    const html = fs.readFileSync(filename, 'utf8').replace(/<body\b[^>]*>/i, opening => opening + '<div style="grid-column:1/-1;padding:12px;background:#603b00;color:white;text-align:center;font: bold 16px Arial">DEVELOPMENT FIXTURE — SYNTHETIC DATA ONLY — NOT PRODUCTION</div>');
                    return res.type('html').send(html);
                }
                if (/^\/api\/admin\/premium(?:\/|$)/.test(req.path) || ['/api/login', '/api/logout', '/api/admin/check'].includes(req.path)) return next();
                return res.sendStatus(404);
            });
            return app;
        }, express);
        // Production static roots must never be mounted in this fixture.
        fixtureExpress.static = () => (req, res, next) => next();
        const context = vm.createContext({ URL, Buffer, path, fileURLToPath, timingSafeEqual, randomUUID, multer,
            express: fixtureExpress, session: options => session({ ...options, name: cookieName }),
            Database: function(filename) { const db = new Database(checkPath(filename, paths.movies), { fileMustExist: true }); stores.push(db); return db; },
            SQLiteSessionStore: function(options) { checkPath(options.filename, paths.sessions); checkPath(options.movieDatabasePath, paths.movies); const store = new SQLiteSessionStore(options); stores.push(store); return store; },
            createAdminAuth: options => { checkPath(options.filename, paths.admin); const store = createAdminAuth(options); stores.push(store); return store; },
            validateNewUsername,
            validateDatabasePath: supplied => checkPath(supplied.ADMIN_DATABASE_PATH, paths.admin),
            resolveMovieDatabasePath: () => checkPath(env.DATABASE_PATH, paths.movies),
            fs: Object.freeze({ mkdirSync: filename => fs.mkdirSync(checkPath(filename, paths.uploads), { recursive: true }) }),
            setInterval: (...args) => { const timer = setInterval(...args); timers.add(timer); return timer; }, clearInterval,
            console: { log() {}, error() {} },
            process: { env, exit() { throw new Error('Fixture initialization refused.'); } }
        });
        const runtime = vm.runInContext(source + '\n({app,db,requireAdmin,requireSameOrigin,adminAuth});', context);
        stopPremium = registerPremiumRoutes(runtime.app, runtime.db, { requireAdmin: runtime.requireAdmin,
            requireSameOrigin: runtime.requireSameOrigin, adminIdentity: () => runtime.adminAuth.getCredential().username, env });
        runtime.app.use((error, req, res, next) => res.status(500).json({ message: 'Synthetic fixture request failed.' }));
        await new Promise((resolve, reject) => {
            listener = runtime.app.listen(port, '127.0.0.1', error => error ? reject(error) : resolve());
            listener.once('error', reject);
        });
        return Object.freeze({ directory, paths, origin, port, address: listener.address(), cookieName, close });
    } catch {
        try { await close(); } catch { throw new Error('Fixture failed; temporary cleanup requires review.'); }
        throw new Error('Fixture failed to start; production services were not changed.');
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length > 2) throw new Error('Use only PREMIUM_FIXTURE_PORT to select a fixture port.');
        const fixture = await startPremiumBrowserFixture({ port: process.env.PREMIUM_FIXTURE_PORT ?? 3101 });
        console.log(`SYNTHETIC DEVELOPMENT ONLY: ${fixture.origin}/login.html`);
        console.log('Login: FixtureAdmin / Fixture-Only-Password-2026! (fake fixture credentials only)');
        console.log(`Temporary fixture directory: ${fixture.directory}`);
        console.log('Press Ctrl+C to stop this fixture and remove its temporary data.');
        const stop = async () => { try { await fixture.close(); process.exitCode = 0; } catch { console.error('Fixture cleanup failed. Inspect the printed temporary directory; do not delete production data.'); process.exitCode = 1; } };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
