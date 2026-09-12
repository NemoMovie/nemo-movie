import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMovieDatabasePath } from "./movie-database-path.js";

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
            CREATE TABLE IF NOT EXISTS payments (
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
            );
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
