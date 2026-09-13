import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMovieDatabasePath } from './movie-database-path.js';

// Version 3: intentionally separate from previous Premium migrations and server startup.
const TABLE = 'premium_membership_effects';
const timestamp = column => `typeof(${column}) = 'text' AND length(${column}) = 24
    AND ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}, '+0 seconds') = ${column}`;
const schema = `CREATE TABLE ${TABLE} (
    id INTEGER PRIMARY KEY,
    telegram_user_id INTEGER NOT NULL REFERENCES telegram_users(telegram_user_id) ON DELETE RESTRICT,
    event_order INTEGER NOT NULL CHECK(typeof(event_order) = 'integer' AND event_order > 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision) = 'integer' AND revision > 0),
    effect_type TEXT NOT NULL CHECK(effect_type IN ('PAYMENT_GRANT', 'MEMBERSHIP_CORRECTION')),
    payment_id INTEGER UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
    effective_at TEXT NOT NULL CHECK(COALESCE(${timestamp('effective_at')}, 0)),
    plan_days INTEGER,
    correction_start_at TEXT,
    correction_expires_at TEXT,
    supersedes_effect_id INTEGER UNIQUE REFERENCES ${TABLE}(id) ON DELETE RESTRICT,
    admin_identifier TEXT NOT NULL CHECK(length(trim(admin_identifier)) > 0),
    reason TEXT,
    created_at TEXT NOT NULL CHECK(COALESCE(${timestamp('created_at')}, 0)),
    UNIQUE(telegram_user_id, event_order, revision),
    CHECK((revision = 1 AND supersedes_effect_id IS NULL) OR
          (revision > 1 AND supersedes_effect_id IS NOT NULL AND effect_type = 'PAYMENT_GRANT')),
    CHECK(COALESCE(
        (effect_type = 'PAYMENT_GRANT' AND payment_id IS NOT NULL
            AND typeof(plan_days) = 'integer' AND plan_days > 0
            AND correction_start_at IS NULL AND correction_expires_at IS NULL)
        OR (effect_type = 'MEMBERSHIP_CORRECTION' AND payment_id IS NULL AND plan_days IS NULL
            AND ${timestamp('correction_start_at')} AND ${timestamp('correction_expires_at')}
            AND correction_expires_at > correction_start_at AND length(trim(reason)) > 0), 0)),
    CHECK(revision = 1 OR COALESCE(length(trim(reason)) > 0, 0))
)`;
const triggers = {
    premium_effects_no_update: `CREATE TRIGGER premium_effects_no_update BEFORE UPDATE ON ${TABLE}
        BEGIN SELECT RAISE(ABORT, 'Membership effects are immutable'); END`,
    premium_effects_no_delete: `CREATE TRIGGER premium_effects_no_delete BEFORE DELETE ON ${TABLE}
        BEGIN SELECT RAISE(ABORT, 'Membership effects are immutable'); END`,
    premium_effects_append: `CREATE TRIGGER premium_effects_append BEFORE INSERT ON ${TABLE} BEGIN
        SELECT CASE WHEN NEW.revision = 1 AND NEW.event_order <> (
            SELECT COALESCE(MAX(event_order),0)+1 FROM ${TABLE} WHERE telegram_user_id=NEW.telegram_user_id
        ) THEN RAISE(ABORT, 'Invalid membership event order') END;
        SELECT CASE WHEN NEW.revision > 1 AND NOT EXISTS (
            SELECT 1 FROM ${TABLE} e WHERE e.id=NEW.supersedes_effect_id
            AND e.telegram_user_id=NEW.telegram_user_id AND e.event_order=NEW.event_order
            AND e.effect_type='PAYMENT_GRANT' AND e.revision=NEW.revision-1
            AND e.effective_at=NEW.effective_at
            AND NOT EXISTS (SELECT 1 FROM ${TABLE} newer WHERE newer.supersedes_effect_id=e.id)
        ) THEN RAISE(ABORT, 'Invalid membership effect revision') END;
        SELECT CASE WHEN NEW.effect_type='PAYMENT_GRANT' AND NOT EXISTS (
            SELECT 1 FROM payments p WHERE p.id=NEW.payment_id
            AND p.telegram_user_id=NEW.telegram_user_id AND p.status='CONFIRMED' AND p.plan_days=NEW.plan_days
        ) THEN RAISE(ABORT, 'Confirmed matching payment required') END;
    END`
};
const normalize = sql => sql?.replace(/\s+/g,' ').trim().replace(/;$/,'');

export function migratePremiumLedgerV3(db) {
    if (db.inTransaction) throw new Error('Ledger migration requires its own transaction.');
    db.pragma('foreign_keys = ON');
    if (db.pragma('foreign_keys',{simple:true}) !== 1) throw new Error('Foreign keys are required.');
    db.transaction(() => {
        for (const name of ['movies','series_episodes','telegram_users','premium_memberships','payments','membership_audit_log']) {
            if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new Error('Approved Phase 2 schema is required.');
        }
        if (!db.prepare('PRAGMA table_info(payments)').all().some(c=>c.name==='request_expires_at' && c.notnull===1)) throw new Error('Approved Phase 2 schema is required.');
        const existing = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(TABLE);
        if (existing) {
            if (existing.type !== 'table' || normalize(existing.sql) !== normalize(schema)) throw new Error('Unexpected ledger schema; manual review required.');
            const actual = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(TABLE);
            if (actual.length !== Object.keys(triggers).length || actual.some(t=>normalize(t.sql)!==normalize(triggers[t.name]))) throw new Error('Unexpected ledger protections; manual review required.');
            if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").get(TABLE)) throw new Error('Unexpected ledger indexes; manual review required.');
            if (db.prepare('PRAGMA foreign_key_check(premium_membership_effects)').all().length) throw new Error('Invalid ledger relationships; manual review required.');
            return;
        }
        // No guessed legacy baseline, even for pending-only payment history.
        for (const name of ['premium_memberships','payments','membership_audit_log']) {
            if (db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get()) throw new Error('Existing Premium history requires manual review; no ledger baseline was invented.');
        }
        db.exec(schema);
        for (const sql of Object.values(triggers)) db.exec(sql);
    }).immediate();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let db;
    try {
        await import('dotenv/config');
        db = new Database(resolveMovieDatabasePath(path.dirname(fileURLToPath(import.meta.url))), {fileMustExist:true});
        migratePremiumLedgerV3(db);
        console.log('Premium ledger v3 migration completed.');
    } catch {
        console.error('Premium ledger v3 migration failed; schema/history requires review. No success claimed.');
        process.exitCode=1;
    } finally { db?.close(); }
}
