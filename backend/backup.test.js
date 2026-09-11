import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runBackup, verifyDatabase } from "./backup.js";

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-backup-test-"));
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    const options = { moviePath: path.join(source, "movies.db"), adminPath: path.join(source, "admin.db"),
        uploadsPath: path.join(source, "uploads"), backupRoot: path.join(root, "snapshots"), maintenanceConfirmed: true };
    for (const [file, sql] of [[options.moviePath, "CREATE TABLE movies (poster TEXT); INSERT INTO movies VALUES ('/uploads/poster.webp'); CREATE TABLE series_episodes (id INTEGER)"],
        [options.adminPath, "CREATE TABLE admin_credentials (password_hash TEXT); INSERT INTO admin_credentials VALUES ('PRIVATE_TEST_HASH')"]]) {
        const db = new Database(file); db.exec(sql); db.close();
    }
    fs.mkdirSync(options.uploadsPath);
    fs.writeFileSync(path.join(options.uploadsPath, "poster.webp"), "poster-test-bytes");
    fs.writeFileSync(path.join(options.uploadsPath, ".env"), "PRIVATE_TEST_SECRET");
    fs.writeFileSync(path.join(source, ".env"), "PRIVATE_TEST_SECRET");
    t.after(() => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert(path.basename(root).startsWith("nemo-backup-test-"));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, options };
}

test("successful verified snapshot copies uploads, omits env/sessions and records safe hashes", async t => {
    const { options } = fixture(t);
    const output = await runBackup(options);
    assert(fs.existsSync(path.join(output, "COMPLETE")));
    assert.equal(fs.readFileSync(path.join(output, "uploads/poster.webp"), "utf8"), "poster-test-bytes");
    assert(!fs.existsSync(path.join(output, "uploads/.env")));
    const text = fs.readFileSync(path.join(output, "manifest.json"), "utf8");
    assert(!text.includes("PRIVATE_TEST"));
    assert(!text.includes("poster.webp"));
    const manifest = JSON.parse(text);
    assert.equal(manifest.sessionsIncluded, false);
    assert.equal(manifest.verificationSuccess, true);
    assert.equal(manifest.uploads.fileCount, 1);
    assert.equal(manifest.databases.length, 2);
    manifest.databases.forEach(db => assert.match(db.sha256, /^[a-f0-9]{64}$/));
    verifyDatabase(path.join(output, "databases/movies.db"), ["movies", "series_episodes"]);
});

test("missing source never creates a database", async t => {
    const { options } = fixture(t);
    options.moviePath += ".missing";
    await assert.rejects(runBackup(options), /Backup failed/);
    assert(!fs.existsSync(options.moviePath));
});

test("corrupt database and missing core table fail verification", t => {
    const { root, options } = fixture(t);
    const bad = path.join(root, "corrupt.db");
    fs.writeFileSync(bad, "not SQLite");
    assert.throws(() => verifyDatabase(bad, ["movies"]), /Backup failed/);
    assert.throws(() => verifyDatabase(options.moviePath, ["missing_table"]), /Backup failed/);
});

test("missing poster leaves partial without COMPLETE and preserves older snapshot", async t => {
    const { options } = fixture(t);
    const older = await runBackup(options);
    fs.unlinkSync(path.join(options.uploadsPath, "poster.webp"));
    await assert.rejects(runBackup(options), /Backup failed/);
    assert(fs.existsSync(path.join(older, "COMPLETE")));
    const partial = fs.readdirSync(options.backupRoot).filter(name => name.startsWith(".partial-"));
    assert.equal(partial.length, 1);
    assert(!fs.existsSync(path.join(options.backupRoot, partial[0], "COMPLETE")));
});

test("unsafe destinations and absent maintenance confirmation rejected", async t => {
    const { options } = fixture(t);
    for (const backupRoot of [options.uploadsPath, path.dirname(options.moviePath), path.resolve(".")]) {
        await assert.rejects(runBackup({ ...options, backupRoot }), /Backup failed/);
    }
    await assert.rejects(runBackup({ ...options, maintenanceConfirmed: false }), /Backup failed/);
});

test("concurrent runs are blocked even with different backup roots", async t => {
    const { options } = fixture(t);
    const results = await Promise.allSettled([runBackup(options), runBackup({ ...options, backupRoot: options.backupRoot + "-other" })]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected").length, 1);
});

test("sessions explicitly included only when requested", async t => {
    const { options } = fixture(t);
    const sessionPath = path.join(path.dirname(options.moviePath), "sessions.db");
    const db = new Database(sessionPath); db.exec("CREATE TABLE sessions (sid TEXT)"); db.close();
    const output = await runBackup({ ...options, sessionPath });
    verifyDatabase(path.join(output, "databases/sessions.db"), ["sessions"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, "manifest.json"))).sessionsIncluded, true);
});

test("upload junctions are rejected", async t => {
    const { root, options } = fixture(t);
    const outside = path.join(root, "outside"); fs.mkdirSync(outside);
    try { fs.symlinkSync(outside, path.join(options.uploadsPath, "link"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Link creation unavailable"); throw error; }
    await assert.rejects(runBackup(options), /Backup failed/);
});

test("publication precedes COMPLETE and partial never contains it", async t => {
    const { options } = fixture(t);
    let published = false;
    const output = await runBackup(options, { ...fs, renameSync(from, to) {
        if (path.basename(from).startsWith(".partial-")) {
            assert(!fs.existsSync(path.join(from, "COMPLETE")));
            assert.equal(JSON.parse(fs.readFileSync(path.join(from, "manifest.json"))).verificationSuccess, true);
            fs.renameSync(from, to); published = true;
        } else {
            assert(published);
            assert.equal(path.basename(to), "COMPLETE");
            assert(!path.dirname(to).includes(".partial-"));
            fs.renameSync(from, to);
        }
    } });
    assert(fs.existsSync(path.join(output, "COMPLETE")));
});

for (const mode of ["rename", "marker", "collision", "copy"]) {
    test(`${mode} failure leaves unambiguous state and preserves older backups`, async t => {
        const { options } = fixture(t);
        const older = await runBackup(options);
        const io = { ...fs };
        const fail = () => { throw Object.assign(new Error("simulated"), { code: "ENOSPC" }); };
        if (mode === "rename") io.renameSync = fail;
        if (mode === "marker") io.writeFileSync = (file, ...args) => {
            fs.writeFileSync(file, "partial-marker", { flag: "wx" }); fail();
        };
        if (mode === "copy") io.copyFileSync = fail;
        if (mode === "collision") io.lstatSync = file => {
            fs.mkdirSync(file); fs.writeFileSync(path.join(file, "keep"), "existing");
            return fs.lstatSync(file);
        };
        await assert.rejects(runBackup(options, io), error => error.code === (mode === "copy" ? "BACKUP_FAILED" : "PUBLICATION_FAILED"));
        assert(fs.existsSync(path.join(older, "COMPLETE")));
        for (const name of fs.readdirSync(options.backupRoot)) {
            const dir = path.join(options.backupRoot, name);
            if (dir === older) continue;
            assert(!fs.existsSync(path.join(dir, "COMPLETE")));
            if (fs.existsSync(path.join(dir, "keep"))) assert.equal(fs.readFileSync(path.join(dir, "keep"), "utf8"), "existing");
        }
    });
}

for (const mode of ["cleanup", "replacement"]) {
    test(`${mode} lock warning cannot undo successful publication`, async t => {
        const { options } = fixture(t);
        let lockPath;
        t.after(() => { if (lockPath && fs.existsSync(lockPath)) fs.unlinkSync(lockPath); });
        const output = await runBackup(options, { ...fs,
            readFileSync(file, encoding) {
                lockPath = file;
                const owner = JSON.parse(fs.readFileSync(file, encoding));
                assert.equal(owner.version, 1); assert.equal(owner.pid, process.pid);
                assert(owner.startedAt); assert(owner.repository); assert(owner.runId);
                if (mode === "replacement") fs.writeFileSync(file, JSON.stringify({ ...owner, runId: "replacement-owner" }));
                return fs.readFileSync(file, encoding);
            },
            unlinkSync() { throw new Error("permission denied"); }
        });
        assert(fs.existsSync(path.join(output, "COMPLETE")));
        assert(fs.existsSync(lockPath));
        if (mode === "replacement") assert.equal(JSON.parse(fs.readFileSync(lockPath)).runId, "replacement-owner");
    });
}

test("WAL-mode source including committed WAL rows backs up consistently", async t => {
    const { options } = fixture(t);
    const source = new Database(options.moviePath);
    try {
    source.pragma("journal_mode = WAL");
    source.pragma("wal_autocheckpoint = 0");
    source.prepare("INSERT INTO movies VALUES (?)").run("/uploads/poster.webp");
    const output = await runBackup(options);
    const copied = new Database(path.join(output, "databases/movies.db"), { readonly: true });
    try { assert.equal(copied.prepare("SELECT count(*) AS n FROM movies").get().n, 2); }
    finally { copied.close(); }
    } finally { source.close(); }
});
