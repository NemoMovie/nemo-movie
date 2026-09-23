import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migratePremium } from './premium-migration.js';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
import { runPremiumRollout } from './premium-rollout-migrate.js';

function fixture(t, initialized = true) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-rollout-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'synthetic.db');
    const db = new Database(filename);
    db.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY, title TEXT); INSERT INTO movies VALUES(1,\'synthetic\'); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY); INSERT INTO series_episodes VALUES(2);');
    if (initialized) { migratePremium(db); migratePremiumLedgerV3(db); }
    db.close();
    const env = { DATABASE_PATH: filename, NEMO_STAGE_7D_CONFIRMED: 'YES' };
    return { filename, env, dir };
}
function inspect(filename, fn) {
    const db = new Database(filename, { fileMustExist: true });
    try { return fn(db); } finally { db.close(); }
}
const exists = (db, name) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name);

test('empty prerequisites migrate; final schema, empty business data and catalogue survive', t => {
    const { filename, env } = fixture(t);
    const logs = [];
    runPremiumRollout({ env, log: line => logs.push(line) });
    inspect(filename, db => {
        assert.deepEqual(db.prepare('SELECT * FROM movies').all(), [{ id: 1, title: 'synthetic' }]);
        assert.deepEqual(db.prepare('SELECT * FROM series_episodes').all(), [{ id: 2 }]);
        for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('movies','series_episodes','sqlite_sequence')").all()) {
            assert.equal(db.prepare(`SELECT count(*) n FROM "${name}"`).get().n, 0);
        }
        for (const name of ['payment_cases_one_open', 'payment_case_deliveries', 'payment_case_notifications_delivery_guard', 'payment_bot_operations', 'payment_case_method_changes_apply']) assert.ok(exists(db, name));
        assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
        assert.deepEqual(db.pragma('foreign_key_check'), []);
    });
    assert.equal(logs.filter(s => /^Stage \d+:.* verified\.$/.test(s)).length, 8);
    assert.equal(logs.at(-1), 'Stages 3–10 verified successfully.');
    assert.throws(() => runPremiumRollout({ env, log() {} }), /preflight/);
});

test('missing prerequisites fail without creating case schema', t => {
    const { filename, env } = fixture(t, false);
    assert.throws(() => runPremiumRollout({ env, log() {} }), /preflight/);
    inspect(filename, db => assert.equal(exists(db, 'payment_cases'), false));
});

test('partial case schema fails closed and remains untouched', t => {
    const { filename, env } = fixture(t);
    inspect(filename, db => db.exec('CREATE TABLE payment_cases(unexpected TEXT)'));
    assert.throws(() => runPremiumRollout({ env, log() {} }), /preflight/);
    inspect(filename, db => {
        assert.equal(db.pragma('table_info(payment_cases)')[0].name, 'unexpected');
        assert.equal(exists(db, 'payment_case_submissions'), false);
    });
});

test('mismatched prerequisite protection fails closed', t => {
    const { filename, env } = fixture(t);
    inspect(filename, db => db.exec('DROP TRIGGER premium_effects_append'));
    assert.throws(() => runPremiumRollout({ env, log() {} }), /preflight/);
    inspect(filename, db => assert.equal(exists(db, 'payment_cases'), false));
});

test('nonempty prerequisite data refuses migration', t => {
    const { filename, env } = fixture(t);
    inspect(filename, db => db.exec("INSERT INTO telegram_users(telegram_user_id,first_seen_at,last_seen_at,created_at,updated_at) VALUES(123,'synthetic','synthetic','synthetic','synthetic')"));
    assert.throws(() => runPremiumRollout({ env, log() {} }), /preflight/);
});

test('confirmation missing fails before opening any target', t => {
    const { filename, env } = fixture(t);
    delete env.NEMO_STAGE_7D_CONFIRMED;
    assert.throws(() => runPremiumRollout({ env, log() {} }), /confirmation/);
    inspect(filename, db => assert.equal(exists(db, 'payment_cases'), false));
});

test('CLI without confirmation exits nonzero before reading environment files', t => {
    const { dir } = fixture(t);
    const env = { ...process.env };
    delete env.NEMO_STAGE_7D_CONFIRMED;
    const result = spawnSync(process.execPath,
        [fileURLToPath(new URL('./premium-rollout-migrate.js', import.meta.url))],
        { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /no success claimed/);
});

test('missing and invalid paths fail without creating a database; E: refused', t => {
    const { env, dir } = fixture(t);
    const missing = path.join(dir, 'absent.db');
    for (const filename of [missing, dir, 'E:\\must-not-be-accessed.db']) {
        assert.throws(() => runPremiumRollout({ env: { ...env, DATABASE_PATH: filename }, log() {} }));
    }
    assert.equal(fs.existsSync(missing), false);
});

test('migration failure stops later stages and closes connection', t => {
    const { filename, env } = fixture(t);
    const logs = [];
    assert.throws(() => runPremiumRollout({ env, log(line) {
        logs.push(line);
        if (line === 'Preflight verified.') inspect(filename, db => db.exec('CREATE TABLE payment_cases(unexpected TEXT)'));
    } }), /Stage 3/);
    inspect(filename, db => assert.equal(exists(db, 'payment_case_verifications'), false));
    assert.equal(logs.some(line => line.includes('successfully')), false);
});

test('failure after a committed stage preserves it without proceeding', t => {
    const { filename, env } = fixture(t);
    assert.throws(() => runPremiumRollout({ env, log(line) {
        if (line.startsWith('Stage 3:')) throw new Error('synthetic interruption');
    } }), /Earlier stages may have committed/);
    inspect(filename, db => {
        assert.equal(exists(db, 'payment_cases'), true);
        assert.equal(exists(db, 'payment_case_verifications'), false);
    });
});
