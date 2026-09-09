import session from "express-session";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const noop = () => {};

// Resolve existing ancestors too, so directory symlinks cannot alias movies.db.
function canonicalPath(filename) {
    const absolute = path.resolve(filename);
    let resolved;
    if (fs.existsSync(absolute)) resolved = fs.realpathSync(absolute);
    else {
        const parent = path.dirname(absolute);
        resolved = path.join(parent === absolute ? parent : canonicalPath(parent), path.basename(absolute));
    }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameFile(a, b) {
    if (canonicalPath(a) === canonicalPath(b)) return true;
    if (fs.existsSync(a) && fs.existsSync(b)) {
        const first = fs.statSync(a, { bigint: true });
        const second = fs.statSync(b, { bigint: true });
        return first.ino !== 0n && first.dev === second.dev && first.ino === second.ino;
    }
    return false;
}

export default class SQLiteSessionStore extends session.Store {
    constructor({ filename, movieDatabasePath, cleanupIntervalMs = 15 * 60 * 1000, now = Date.now }) {
        super();
        this.now = now;
        this.closed = false;
        try {
            if (typeof filename !== "string" || !filename.trim() ||
                typeof movieDatabasePath !== "string" || !movieDatabasePath.trim() ||
                !Number.isSafeInteger(cleanupIntervalMs) || cleanupIntervalMs <= 0 ||
                path.basename(filename).toLowerCase() === "movies.db" ||
                path.basename(canonicalPath(filename)).toLowerCase() === "movies.db" ||
                sameFile(filename, movieDatabasePath)) throw new Error();
            this.db = new Database(path.resolve(filename));
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS sessions (
                    sid TEXT PRIMARY KEY NOT NULL,
                    session_json TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
            `);
            this.read = this.db.prepare("SELECT session_json, expires_at FROM sessions WHERE sid = ?");
            this.write = this.db.prepare(`INSERT INTO sessions (sid, session_json, expires_at) VALUES (?, ?, ?)
                ON CONFLICT(sid) DO UPDATE SET session_json = excluded.session_json, expires_at = excluded.expires_at`);
            this.remove = this.db.prepare("DELETE FROM sessions WHERE sid = ?");
            this.updateExpiry = this.db.prepare("UPDATE sessions SET expires_at = ? WHERE sid = ? AND expires_at > ?");
            this.purge = this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?");
            this.timer = setInterval(() => this.cleanup(error => {
                if (error) console.error("Session cleanup failed.");
            }), cleanupIntervalMs);
            this.timer.unref();
        } catch {
            if (this.db?.open) this.db.close();
            throw new Error("Session store initialization failed.");
        }
    }

    perform(operation, callback = noop) {
        let result;
        try {
            if (this.closed) throw new Error();
            result = operation();
        } catch {
            callback(new Error("Session store operation failed."));
            return;
        }
        callback(null, result);
    }

    expiry(value) {
        const cookie = value?.cookie;
        let expires;
        if (cookie?.expires != null) expires = new Date(cookie.expires).getTime();
        else {
            const age = cookie?.maxAge ?? EIGHT_HOURS;
            if (typeof age !== "number" || !Number.isFinite(age)) throw new Error();
            expires = this.now() + age;
        }
        if (!Number.isSafeInteger(expires)) throw new Error();
        return expires;
    }

    get(sid, callback = noop) {
        this.perform(() => {
            const row = this.read.get(sid);
            if (!row) return null;
            if (!Number.isSafeInteger(row.expires_at) || row.expires_at <= this.now()) {
                this.remove.run(sid);
                return null;
            }
            let value;
            try { value = JSON.parse(row.session_json); } catch { /* Invalid session below. */ }
            if (!value || typeof value !== "object" || Array.isArray(value) ||
                !value.cookie || typeof value.cookie !== "object" || Array.isArray(value.cookie)) {
                this.remove.run(sid);
                return null;
            }
            value.cookie.expires = new Date(row.expires_at).toISOString();
            return value;
        }, callback);
    }

    set(sid, value, callback = noop) {
        this.perform(() => {
            if (!value || typeof value !== "object" || Array.isArray(value) ||
                !value.cookie || typeof value.cookie !== "object" || Array.isArray(value.cookie)) throw new Error();
            const expires = this.expiry(value);
            if (expires <= this.now()) this.remove.run(sid);
            else this.write.run(sid, JSON.stringify(value), expires);
        }, callback);
    }

    destroy(sid, callback = noop) {
        this.perform(() => { this.remove.run(sid); }, callback);
    }

    touch(sid, value, callback = noop) {
        this.perform(() => {
            this.updateExpiry.run(this.expiry(value), sid, this.now());
        }, callback);
    }

    cleanup(callback = noop) {
        this.perform(() => { this.purge.run(this.now()); }, callback);
    }

    close(callback = noop) {
        clearInterval(this.timer);
        if (this.closed) { callback(null); return; }
        this.perform(() => { this.db.close(); this.closed = true; }, callback);
    }
}
