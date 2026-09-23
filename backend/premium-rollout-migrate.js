// Operator-only Stage 7D runner. Never imported by application startup.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { resolveMovieDatabasePath } from './movie-database-path.js';
import { migratePremium } from './premium-migration.js';
import { migratePremiumLedgerV3 } from './premium-ledger-migration.js';
import { migratePaymentCases } from './payment-case-migration.js';
import { migratePaymentCaseAdapter } from './payment-case-adapter-migration.js';
import { migratePaymentCaseAdmin } from './payment-case-admin-migration.js';
import { migratePaymentCaseConversation } from './payment-case-conversation-migration.js';
import { migratePaymentCaseWorkflow } from './payment-case-workflow-migration.js';
import { migratePaymentBotIntake } from './payment-bot-intake-migration.js';
import { migratePaymentCaseCompletion } from './payment-case-completion-migration.js';
import { migratePaymentCaseDelivery } from './payment-case-delivery-migration.js';

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const stages = [migratePaymentCases, migratePaymentCaseAdapter, migratePaymentCaseAdmin,
    migratePaymentCaseConversation, migratePaymentCaseWorkflow, migratePaymentBotIntake,
    migratePaymentCaseCompletion, migratePaymentCaseDelivery];
const premiumTables = ['telegram_users', 'premium_memberships', 'payments',
    'membership_audit_log', 'premium_membership_effects'];
const relevant = name => premiumTables.includes(name) || /^(payment_case|payment_bot)/.test(name);
const normalize = sql => sql?.replace(/"(payments|payment_cases|payment_case_verifications)"/g, '$1')
    .replace(/IF NOT EXISTS/gi, '').replace(/\s+/g, '').replace(/;$/, '');
const objects = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();

// Inspect ancestors before descending: refuse direct E: paths and detectable aliases.
function safePath(filename) {
    const absolute = path.resolve(filename);
    const root = path.parse(absolute).root;
    let current = root;
    for (const part of ['', ...absolute.slice(root.length).split(path.sep).filter(Boolean)]) {
        current = part ? path.join(current, part) : current;
        if (/^(?:\\\\\?\\)?E:/i.test(current)) throw new Error('Unsafe migration path.');
        if (!fs.existsSync(current)) break;
        const resolved = fs.realpathSync(current);
        if (/^(?:\\\\\?\\)?E:/i.test(resolved)) throw new Error('Unsafe migration path.');
    }
    return absolute;
}

function verify(db, reference) {
    if (db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('Unsafe connection state.');
    const actual = objects(db).filter(o => relevant(o.tbl_name));
    const expected = objects(reference).filter(o => relevant(o.tbl_name));
    if (JSON.stringify(actual.map(o => [o.type, o.name, normalize(o.sql)])) !==
        JSON.stringify(expected.map(o => [o.type, o.name, normalize(o.sql)]))) throw new Error('Unexpected schema.');
    for (const { name } of expected.filter(o => o.type === 'table')) {
        if (db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n !== 0) throw new Error('Expected empty business tables.');
    }
    if (db.pragma('foreign_key_check').length) throw new Error('Invalid relationships.');
}

export function runPremiumRollout({ env, log = console.log } = {}) {
    if (env?.NEMO_STAGE_7D_CONFIRMED !== 'YES') throw new Error('Stage 7D operator confirmation required.');
    let db, reference;
    let phase = 'preflight';
    try {
        safePath(path.resolve(backendDir, env.DATABASE_PATH || 'movies.db'));
        safePath(path.resolve(backendDir, '../frontend'));
        safePath(path.resolve(backendDir, env.UPLOADS_DIR || 'uploads'));
        const filename = resolveMovieDatabasePath(backendDir, env);
        db = new Database(filename, { fileMustExist: true });
        db.pragma('foreign_keys = ON');
        reference = new Database(':memory:');
        reference.exec('CREATE TABLE movies(id INTEGER PRIMARY KEY); CREATE TABLE series_episodes(id INTEGER PRIMARY KEY);');
        // Stages 1–2 execute ONLY in memory to construct expected schema, never on target.
        migratePremium(reference);
        migratePremiumLedgerV3(reference);
        for (const name of ['movies', 'series_episodes']) {
            if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new Error('Missing catalogue.');
        }
        if (objects(db).some(o => /^(payment_case|payment_bot)/.test(o.name))) throw new Error('Existing case installation requires review.');
        verify(db, reference);
        log('Preflight verified.');
        for (const [index, migrate] of stages.entries()) {
            phase = `Stage ${index + 3}: ${migrate.name}`;
            migrate(reference);
            migrate(db);
            verify(db, reference);
            log(`${phase} verified.`);
        }
        phase = 'final verification';
        const integrity = db.pragma('integrity_check');
        if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Integrity check failed.');
        verify(db, reference);
        log('Stages 3–10 verified successfully.');
    } catch {
        throw new Error(`Migration stopped during ${phase}. Earlier stages may have committed. Inspect schema before resuming; do not blindly rerun.`);
    } finally {
        try { db?.close(); } finally { reference?.close(); }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        // Confirmation must come from the operator process, not from .env.
        if (process.env.NEMO_STAGE_7D_CONFIRMED !== 'YES') throw new Error('Stage 7D operator confirmation required.');
        const env = { ...dotenv.parse(fs.readFileSync(path.join(backendDir, '.env'))), ...process.env };
        runPremiumRollout({ env });
    } catch {
        console.error('Stage 7D failed; no success claimed. Earlier stages may have committed. Inspect schema before resuming; do not blindly rerun.');
        process.exitCode = 1;
    }
}
