import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { resolveMovieDatabasePath } from "./movie-database-path.js";

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(backendDir, "..");
const failure = () => new Error("Backup failed; snapshot is not complete.");

function canonical(value) {
    const absolute = path.resolve(value);
    try { return fs.realpathSync(absolute); }
    catch (error) {
        if (error.code !== "ENOENT") throw error;
        try { fs.lstatSync(absolute); throw failure(); }
        catch (e) { if (e.code !== "ENOENT") throw e; }
        const parent = path.dirname(absolute);
        if (parent === absolute) throw failure();
        return path.join(canonical(parent), path.basename(absolute));
    }
}

function inside(a, b) {
    if (process.platform === "win32") { a = a.toLowerCase(); b = b.toLowerCase(); }
    const relative = path.relative(b, a);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

function regularEntry(filename, directory) {
    const info = fs.lstatSync(filename);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
        !inside(canonical(filename), canonical(path.dirname(filename)))) throw failure();
    return info;
}

function copyUploads(source, target, totals, io = fs) {
    regularEntry(source, true);
    fs.mkdirSync(target);
    for (const entry of fs.readdirSync(source)) {
        // Never copy environment files, including renamed *.env and .env variants.
        if (/^\.env(?:\.|$)|\.env$/i.test(entry)) continue;
        const from = path.join(source, entry), to = path.join(target, entry);
        const info = fs.lstatSync(from);
        regularEntry(from, info.isDirectory());
        if (info.isDirectory()) copyUploads(from, to, totals, io);
        else {
            io.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
            totals.fileCount++;
            totals.totalSize += fs.statSync(to).size;
        }
    }
}

export function verifyDatabase(filename, tables) {
    let db;
    try {
        regularEntry(filename, false);
        db = new Database(filename, { readonly: true, fileMustExist: true });
        const results = db.pragma("integrity_check");
        if (results.length !== 1 || results[0].integrity_check !== "ok") throw failure();
        for (const table of tables) {
            if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw failure();
        }
    } catch { throw failure(); }
    finally { db?.close(); }
}

async function hashFile(filename) {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return hash.digest("hex");
}

// Caller must keep all metadata, poster and credential mutations stopped throughout.
// No retention/deletion is performed by this first version.
export async function runBackup({ moviePath, uploadsPath, adminPath, sessionPath,
    backupRoot = "C:\\NemoMovieBackups", maintenanceConfirmed = false } = {}, io = fs) {
    let lock, lockPath;
    let stage = "BACKUP_FAILED";
    const runId = randomUUID();
    // Diagnostics contain only generated identifiers and the exact lock path.
    const warn = message => { try { console.warn(message); } catch {} };
    try {
        if (!maintenanceConfirmed || !moviePath || !uploadsPath || !adminPath) throw failure();
        const sources = [[moviePath, "movies.db", ["movies", "series_episodes"]],
            [adminPath, "admin-auth.db", ["admin_credentials"]]];
        if (sessionPath) sources.push([sessionPath, "sessions.db", ["sessions"]]);
        const root = canonical(backupRoot);
        const forbidden = [repository, uploadsPath, ...sources.map(([source]) => path.dirname(path.resolve(source)))];
        if (forbidden.some(dir => inside(root, canonical(dir)))) throw failure();
        // Missing sources must never be silently created.
        for (const [source] of sources) regularEntry(source, false);
        regularEntry(uploadsPath, true);
        fs.mkdirSync(root, { recursive: true });
        // Shared across destinations for this checkout/user, not just one snapshot root.
        const lockId = createHash("sha256").update(canonical(repository).toLowerCase()).digest("hex");
        lockPath = path.join(os.tmpdir(), "nemo-backup-" + lockId + ".lock");
        try { lock = fs.openSync(lockPath, "wx"); }
        catch (error) {
            if (error.code === "EEXIST") {
                let owner = {};
                try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch {}
                const pid = Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : "unknown";
                const id = typeof owner.runId === "string" && /^[a-f0-9-]{36}$/.test(owner.runId) ? owner.runId : "unknown";
                warn(`Backup lock exists: ${lockPath}; PID ${pid}; run ${id}. Confirm the owning process is gone before manually removing this exact lock. Never remove by age alone.`);
                stage = "LOCKED";
            }
            throw error;
        }
        const timestamp = new Date().toISOString();
        fs.writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, startedAt: timestamp,
            repository: canonical(repository), runId }));
        const name = timestamp.replace(/[:.]/g, "-") + "-" + randomUUID();
        const partial = path.join(root, ".partial-" + name);
        fs.mkdirSync(partial);
        fs.mkdirSync(path.join(partial, "databases"));
        const databases = [];
        for (const [source, filename, tables] of sources) {
            const destination = path.join(partial, "databases", filename);
            const db = new Database(source, { readonly: true, fileMustExist: true });
            try { await db.backup(destination); } finally { db.close(); }
            verifyDatabase(destination, tables);
            databases.push({ filename: "databases/" + filename, sha256: await hashFile(destination) });
        }
        const uploads = { fileCount: 0, totalSize: 0 };
        const copiedUploads = path.join(partial, "uploads");
        copyUploads(uploadsPath, copiedUploads, uploads, io);
        const movie = new Database(path.join(partial, "databases/movies.db"), { readonly: true, fileMustExist: true });
        try {
            for (const row of movie.prepare("SELECT poster FROM movies").iterate()) {
                if (typeof row.poster !== "string" || !row.poster.startsWith("/uploads/")) continue;
                const relative = row.poster.slice("/uploads/".length);
                if (!relative || /[\\:%\x00-\x1f]/.test(relative)) throw failure();
                const poster = path.resolve(copiedUploads, relative);
                if (!inside(poster, copiedUploads)) throw failure();
                regularEntry(poster, false);
            }
        } finally { movie.close(); }
        let gitCommit = null;
        try {
            const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
            if (/^[a-f0-9]{40,64}$/.test(commit)) gitCommit = commit;
        } catch { /* Git metadata is optional. */ }
        const manifest = { backupVersion: 1, timestamp, gitCommit, databases, uploads,
            sessionsIncluded: Boolean(sessionPath), verificationSuccess: true };
        fs.writeFileSync(path.join(partial, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
        const destination = path.join(root, name);
        stage = "PUBLICATION_FAILED";
        // Windows rename refuses an existing destination; explicitly refuse it on all platforms.
        try { io.lstatSync(destination); throw failure(); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        io.renameSync(partial, destination);
        // A failed/partial marker write must never create COMPLETE.
        const pendingMarker = path.join(destination, ".complete-pending");
        io.writeFileSync(pendingMarker, "Verified\n", { flag: "wx" });
        io.renameSync(pendingMarker, path.join(destination, "COMPLETE"));
        return destination;
    } catch {
        const error = failure();
        error.code = stage;
        throw error;
    }
    finally {
        if (lock !== undefined) {
            try {
                fs.closeSync(lock);
                const owner = JSON.parse(io.readFileSync(lockPath, "utf8"));
                if (owner.runId !== runId) {
                    warn(`Backup lock ownership changed; left untouched: ${lockPath}`);
                } else {
                    io.unlinkSync(lockPath);
                }
            } catch {
                warn(`Backup lock cleanup warning: ${lockPath}. Snapshot result is unchanged; inspect lock ownership before manual removal.`);
            }
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        // Parse only for configuration; never copy or log environment contents.
        const env = { ...dotenv.parse(fs.readFileSync(path.join(backendDir, ".env"))), ...process.env };
        if (env.BACKUP_MAINTENANCE_CONFIRMED !== "1") throw failure();
        await runBackup({ moviePath: resolveMovieDatabasePath(backendDir, env),
            uploadsPath: path.resolve(backendDir, env.UPLOADS_DIR || "uploads"),
            adminPath: env.ADMIN_DATABASE_PATH,
            sessionPath: env.BACKUP_INCLUDE_SESSIONS === "1" ? path.resolve(backendDir, env.SESSION_DATABASE_PATH || "sessions.db") : undefined,
            backupRoot: env.BACKUP_ROOT || "C:\\NemoMovieBackups", maintenanceConfirmed: true });
        console.log("Backup completed and verified.");
    } catch (error) {
        console.error(error.code === "PUBLICATION_FAILED"
            ? "Backup publication failed. A snapshot without COMPLETE is unusable."
            : error.code === "LOCKED" ? "Backup not started: existing lock requires operator review."
            : "Backup/verification failed. Confirm maintenance and configuration; snapshot is incomplete.");
        process.exitCode = 1;
    }
}
