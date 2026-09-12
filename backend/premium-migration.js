import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMovieDatabasePath } from "./movie-database-path.js";


const PAYMENT_V1 = `CREATE TABLE IF NOT EXISTS payments (
                id INTEGER PRIMARY KEY,
                telegram_user_id INTEGER NOT NULL
                    REFERENCES telegram_users(telegram_user_id) ON DELETE RESTRICT,
                payment_request_code TEXT UNIQUE NOT NULL,
                payment_method TEXT NOT NULL CHECK (payment_method IN ('KBZPAY', 'WAVE_MONEY', 'AYA_PAY')),
                amount_mmk INTEGER NOT NULL CHECK (typeof(amount_mmk) = 'integer' AND amount_mmk > 0),
                plan TEXT NOT NULL CHECK (plan IN ('MONTH_1', 'MONTH_3', 'MONTH_6', 'YEAR_1')),
                plan_days INTEGER NOT NULL CHECK (typeof(plan_days) = 'integer' AND plan_days > 0),
                payment_at TEXT,
                transaction_reference TEXT,
                status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'VOID', 'CORRECTED', 'REFUNDED')),
                admin_note TEXT,
                created_at TEXT NOT NULL,
                confirmed_at TEXT,
                confirmed_by TEXT,
                refunded_at TEXT,
                refunded_by TEXT,
                refund_amount_mmk INTEGER CHECK (refund_amount_mmk IS NULL OR
                    (typeof(refund_amount_mmk) = 'integer' AND refund_amount_mmk >= 0 AND refund_amount_mmk <= amount_mmk)),
                refund_reason TEXT
            );`;
const PAYMENT_V2 = PAYMENT_V1.replace("'CONFIRMED', 'VOID'", "'CONFIRMED', 'EXPIRED', 'VOID'")
    .replace("created_at TEXT NOT NULL,", "created_at TEXT NOT NULL, request_expires_at TEXT NOT NULL,");
const normalizeSchema = sql => sql.replace(/"payments"/g, "payments").replace(/IF NOT EXISTS/gi, "").replace(/\s+/g, "").replace(/;$/, "");

function upgradePayments(db) {
    const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payments'").get();
    if (!existing) { db.exec(PAYMENT_V2); return; }
    const actual = normalizeSchema(existing.sql);
    if (actual === normalizeSchema(PAYMENT_V2)) return;
    if (actual !== normalizeSchema(PAYMENT_V1)) throw new Error("Unexpected payments schema; manual review required.");
    // Fail closed on additional dependencies rather than dropping/reinterpreting them.
    const extras = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'payments' AND type IN ('index','trigger')").all();
    const trigger = "CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'Payment history cannot be deleted'); END";
    if (extras.some(e => e.type === 'index' ? e.sql !== null : e.name !== 'payments_no_delete' || normalizeSchema(e.sql) !== normalizeSchema(trigger))) {
        throw new Error("Unexpected payments dependencies; manual review required.");
    }
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
        if (db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(name).some(f => f.table === 'payments')) {
            throw new Error("Unexpected payments dependencies; manual review required.");
        }
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'payments_v2_upgrade'").get()) throw new Error("Migration staging name unavailable.");
    const rows = db.prepare("SELECT * FROM payments").safeIntegers().all();
    const upgraded = rows.map(row => {
        const time = Date.parse(row.created_at);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.created_at) ||
            !Number.isFinite(time) || new Date(time).toISOString() !== row.created_at ||
            new Date(time + 86400000).getUTCFullYear() > 9999) {
            throw new Error("Invalid legacy payment timestamp; manual review required.");
        }
        return { ...row, request_expires_at: new Date(time + 86400000).toISOString() };
    });
    db.exec(PAYMENT_V2.replace('payments (', 'payments_v2_upgrade ('));
    if (upgraded.length) {
        const columns = Object.keys(upgraded[0]);
        const insert = db.prepare(`INSERT INTO payments_v2_upgrade (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
        for (const row of upgraded) insert.run(...columns.map(c => row[c]));
    }
    if (db.prepare('PRAGMA foreign_key_check(payments_v2_upgrade)').all().length) throw new Error("Payment relationship verification failed.");
    db.exec("DROP TRIGGER IF EXISTS payments_no_delete; DROP TABLE payments; ALTER TABLE payments_v2_upgrade RENAME TO payments;");
}

// Importing this module never opens a database or loads production configuration.
export function migratePremium(db) {
    if (db.inTransaction) throw new Error("Premium migration requires its own transaction.");
    db.pragma("foreign_keys = ON");
    if (db.pragma("foreign_keys", { simple: true }) !== 1) throw new Error("Foreign keys are required.");
    db.transaction(() => {
        for (const name of ["movies", "series_episodes"]) {
            if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)) {
                throw new Error("Existing catalogue schema is required.");
            }
        }
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'payments'").get()) upgradePayments(db);
        db.exec(`
            CREATE TABLE IF NOT EXISTS telegram_users (
                id INTEGER PRIMARY KEY,
                telegram_user_id INTEGER UNIQUE NOT NULL,
                username TEXT,
                first_name TEXT,
                last_name TEXT,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS premium_memberships (
                id INTEGER PRIMARY KEY,
                telegram_user_id INTEGER UNIQUE NOT NULL
                    REFERENCES telegram_users(telegram_user_id) ON DELETE RESTRICT,
                start_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                reminder_2d_sent_at TEXT,
                reminder_1d_sent_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            ${PAYMENT_V2}
            CREATE TABLE IF NOT EXISTS membership_audit_log (
                id INTEGER PRIMARY KEY,
                telegram_user_id INTEGER NOT NULL
                    REFERENCES telegram_users(telegram_user_id) ON DELETE RESTRICT,
                action TEXT NOT NULL,
                field_name TEXT NOT NULL,
                old_value TEXT,
                new_value TEXT,
                reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
                admin_identifier TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TRIGGER IF NOT EXISTS payments_no_delete
            BEFORE DELETE ON payments BEGIN
                SELECT RAISE(ABORT, 'Payment history cannot be deleted');
            END;
            CREATE TRIGGER IF NOT EXISTS membership_audit_log_no_delete
            BEFORE DELETE ON membership_audit_log BEGIN
                SELECT RAISE(ABORT, 'Audit history cannot be deleted');
            END;
        `);
    })();
}

// Operator-only entry point; not called by server.js or database.js.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let db;
    try {
        await import("dotenv/config");
        const filename = resolveMovieDatabasePath(path.dirname(fileURLToPath(import.meta.url)));
        db = new Database(filename, { fileMustExist: true });
        migratePremium(db);
        console.log("Premium schema migration completed.");
    } catch {
        console.error("Premium schema migration failed; no success claimed.");
        process.exitCode = 1;
    } finally {
        db?.close();
    }
}
