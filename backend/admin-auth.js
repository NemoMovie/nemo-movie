import Database from "better-sqlite3";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";

const derive = promisify(scrypt);
const PARAMETERS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const PREFIX = "scrypt$1$N=131072,r=8,p=1$";
const FORMAT = /^scrypt\$1\$N=131072,r=8,p=1\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const nonempty = value => typeof value === "string" && value.length > 0;

function failure(code) {
    const error = new Error("Admin credential operation failed.");
    error.code = code;
    return error;
}

export function validateNewUsername(username) {
    return typeof username === "string" && /^[A-Za-z0-9._-]{3,64}$/.test(username) && username === username.trim();
}

export async function hashPassword(password) {
    if (!nonempty(password)) throw failure("INVALID_INPUT");
    try {
        const salt = randomBytes(16);
        const key = await derive(password, salt, 64, PARAMETERS);
        return `${PREFIX}${salt.toString("hex")}$${key.toString("hex")}`;
    } catch {
        throw failure("HASH_FAILED");
    }
}

export async function verifyPassword(password, encodedHash) {
    if (!nonempty(password) || typeof encodedHash !== "string") return false;
    // Accept only the supported, bounded parameters; never execute costs from arbitrary input.
    const match = FORMAT.exec(encodedHash);
    if (!match || match[0] !== encodedHash) return false;
    try {
        const key = await derive(password, Buffer.from(match[1], "hex"), 64, PARAMETERS);
        return timingSafeEqual(key, Buffer.from(match[2], "hex"));
    } catch {
        throw failure("HASH_FAILED");
    }
}

// This factory has no environment/default path and is not imported by the live server.
export function createAdminAuth({ filename, requireExisting = false } = {}) {
    let db;
    try {
        if (!nonempty(filename) || !filename.trim() ||
            ["movies.db", "sessions.db"].includes(path.basename(filename).toLowerCase())) {
            throw new Error();
        }
        db = new Database(path.resolve(filename), { fileMustExist: requireExisting });
        // Refuse a movie/session database, including aliases with a different filename.
        if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
            .get("movies", "sessions")) throw new Error();
        if (!requireExisting) db.exec(`CREATE TABLE IF NOT EXISTS admin_credentials (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            username TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
            updated_at INTEGER NOT NULL
        )`);
        const read = db.prepare("SELECT username, password_hash, credential_version, updated_at FROM admin_credentials WHERE id = ?");
        const insert = db.prepare("INSERT INTO admin_credentials (id, username, password_hash, credential_version, updated_at) VALUES (1, ?, ?, 1, ?)");
        const update = db.prepare(`UPDATE admin_credentials SET username = ?, password_hash = ?,
            credential_version = credential_version + 1, updated_at = ? WHERE id = 1 AND credential_version = ?`);
        if (requireExisting && db.prepare("SELECT count(*) AS n FROM admin_credentials").get().n !== 1) throw new Error();

        function run(operation) {
            if (!db.open) throw failure("CLOSED");
            try { return operation(); } catch (error) {
                if (["ALREADY_INITIALIZED", "STALE_VERSION", "NOT_INITIALIZED"].includes(error.code)) throw error;
                throw failure("DATABASE_FAILED");
            }
        }

        function getCredential() {
            // Internal-only: callers must never serialize this row into an API response.
            return run(() => {
                const row = read.get(1);
                if (!row && !requireExisting) return null;
                if (!row || !nonempty(row.username) || !row.username.trim() ||
                    typeof row.password_hash !== "string" || FORMAT.exec(row.password_hash)?.[0] !== row.password_hash ||
                    !Number.isSafeInteger(row.credential_version) || row.credential_version <= 0 ||
                    !Number.isSafeInteger(row.updated_at)) throw new Error();
                return row;
            });
        }

        const metadata = row => ({ username: row.username,
            credential_version: row.credential_version, updated_at: row.updated_at });

        async function initializeCredential(username, password) {
            if (!nonempty(username) || !username.trim() || !nonempty(password)) throw failure("INVALID_INPUT");
            if (getCredential()) throw failure("ALREADY_INITIALIZED");
            const encoded = await hashPassword(password);
            return run(db.transaction(() => {
                if (read.get(1)) throw failure("ALREADY_INITIALIZED");
                insert.run(username, encoded, Date.now());
                return metadata(read.get(1));
            }));
        }

        async function verifyCredential(username, password) {
            const row = getCredential();
            if (!row || row.username !== username || !nonempty(password)) return false;
            if (!await verifyPassword(password, row.password_hash)) return false;
            // Hashing yields: do not report success for credentials replaced in the meantime.
            const current = getCredential();
            return current?.credential_version === row.credential_version &&
                current.username === row.username && current.password_hash === row.password_hash;
        }

        async function updateCredential({ expectedVersion, newUsername, newPassword } = {}) {
            if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0 ||
                expectedVersion === Number.MAX_SAFE_INTEGER ||
                (newUsername !== undefined && !validateNewUsername(newUsername)) ||
                (newPassword !== undefined && !nonempty(newPassword))) throw failure("INVALID_INPUT");
            const row = getCredential();
            if (!row) throw failure("NOT_INITIALIZED");
            if (row.credential_version !== expectedVersion) throw failure("STALE_VERSION");
            const username = newUsername ?? row.username;
            const passwordChanged = newPassword !== undefined &&
                !await verifyPassword(newPassword, row.password_hash);
            if (username === row.username && !passwordChanged) throw failure("NO_CHANGE");
            const encoded = passwordChanged ? await hashPassword(newPassword) : row.password_hash;
            return run(db.transaction(() => {
                const result = update.run(username, encoded, Date.now(), expectedVersion);
                if (result.changes !== 1) throw failure("STALE_VERSION");
                return metadata(read.get(1));
            }));
        }

        function close() {
            if (db.open) run(() => db.close());
        }

        if (requireExisting) getCredential();
        return { initializeCredential, getCredential, verifyCredential, updateCredential, close };
    } catch {
        if (db?.open) db.close();
        throw failure("INITIALIZATION_FAILED");
    }
}
