import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createAdminAuth, hashPassword, verifyPassword, validateNewUsername } from "./admin-auth.js";

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-auth-test-"));
    const filename = path.join(directory, "credentials.db");
    const stores = [];
    const open = () => {
        const store = createAdminAuth({ filename });
        stores.push(store);
        return store;
    };
    t.after(() => {
        for (const store of stores) store.close();
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert(path.basename(resolved).startsWith("nemo-auth-test-"));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    return { directory, filename, open };
}

const rejects = (promise, code) => assert.rejects(promise, { code });

test("creates singleton, preserves legacy username, refuses overwrite, and persists after close", async t => {
    const f = fixture(t), auth = f.open();
    assert(fs.existsSync(f.filename));
    assert.equal(auth.getCredential(), null);
    const result = await auth.initializeCredential(" Legacy Admin ", " secret ");
    assert.deepEqual(Object.keys(result).sort(), ["credential_version", "updated_at", "username"]);
    assert.equal(result.username, " Legacy Admin ");
    assert.equal(result.credential_version, 1);
    const row = auth.getCredential();
    assert.notEqual(row.password_hash, " secret ");
    assert.match(row.password_hash, /^scrypt\$1\$/);
    await rejects(auth.initializeCredential("Other", "replacement"), "ALREADY_INITIALIZED");
    assert.deepEqual(auth.getCredential(), row);
    const inspect = new Database(f.filename);
    try {
        assert.equal(inspect.prepare("SELECT count(*) AS n FROM admin_credentials").get().n, 1);
        assert.throws(() => inspect.prepare("INSERT INTO admin_credentials VALUES (2, ?, ?, 1, 1)").run("Other", "dummy"));
    } finally { inspect.close(); }
    auth.close(); auth.close();
    assert.throws(() => auth.getCredential(), { code: "CLOSED" });
    const reopened = f.open();
    assert.deepEqual(reopened.getCredential(), row);
    assert(await reopened.verifyCredential(" Legacy Admin ", " secret "));
});

test("exact credentials and password whitespace", async t => {
    const auth = fixture(t).open();
    await auth.initializeCredential("Admin", " password ");
    assert(await auth.verifyCredential("Admin", " password "));
    for (const [user, pass] of [["Other", " password "], ["admin", " password "],
        ["Admin", "wrong"], ["Admin", "password"], ["Admin", " password"], ["Admin", "password "]]) {
        assert.equal(await auth.verifyCredential(user, pass), false);
    }
});

test("hash format, random salts, malformed/unsupported hashes and input validation", async () => {
    const first = await hashPassword("test password"), second = await hashPassword("test password");
    assert.notEqual(first, second);
    assert(await verifyPassword("test password", first));
    for (const value of [null, {}, "", "plaintext", first + "\n", first + "$extra", first.replace("$1$", "$2$"),
        first.replace("N=131072", "N=999999999"), first.slice(0, -1), first.replace(/.$/, "z")]) {
        assert.equal(await verifyPassword("test password", value), false);
    }
    assert.equal(await verifyPassword(null, first), false);
    await rejects(hashPassword(""), "INVALID_INPUT");
    await rejects(hashPassword(123), "INVALID_INPUT");
    const whitespace = await hashPassword(" ");
    assert(await verifyPassword(" ", whitespace));
});

test("new username policy", () => {
    for (const value of ["Adm", "Admin_01", "nemo.movie-admin", "A".repeat(64)]) assert(validateNewUsername(value));
    for (const value of ["", "ab", "a".repeat(65), " Admin", "Admin ", "Admin\n", "a b", "a/b", "a@b", "အက်မင်", null, 123]) {
        assert.equal(validateNewUsername(value), false);
    }
});

test("username-only, password-only and combined updates; safe metadata and versions", async t => {
    const auth = fixture(t).open();
    await auth.initializeCredential("Admin", "first password");
    const originalHash = auth.getCredential().password_hash;
    const renamed = await auth.updateCredential({ expectedVersion: 1, newUsername: "NewAdmin" });
    assert.equal(renamed.credential_version, 2);
    assert.equal(auth.getCredential().password_hash, originalHash);
    const changed = await auth.updateCredential({ expectedVersion: 2, newPassword: "second password" });
    assert.equal(changed.username, "NewAdmin");
    assert.equal(changed.credential_version, 3);
    assert(await auth.verifyCredential("NewAdmin", "second password"));
    const both = await auth.updateCredential({ expectedVersion: 3, newUsername: "FinalAdmin", newPassword: "third password" });
    assert.equal(both.credential_version, 4);
    assert(await auth.verifyCredential("FinalAdmin", "third password"));
    assert.equal(await auth.verifyCredential("FinalAdmin", "second password"), false);
    for (const result of [renamed, changed, both]) {
        assert.deepEqual(Object.keys(result).sort(), ["credential_version", "updated_at", "username"]);
        assert(Number.isSafeInteger(result.updated_at));
    }
});

test("no-op, stale and invalid updates leave row unchanged", async t => {
    const auth = fixture(t).open();
    await rejects(auth.initializeCredential("", "pass"), "INVALID_INPUT");
    await rejects(auth.initializeCredential("   ", "pass"), "INVALID_INPUT");
    await rejects(auth.initializeCredential("Admin", ""), "INVALID_INPUT");
    await rejects(auth.updateCredential({ expectedVersion: 1, newUsername: "Admin" }), "NOT_INITIALIZED");
    await auth.initializeCredential("Admin", "pass");
    const before = auth.getCredential();
    for (const options of [{}, { newUsername: "Admin" }, { newPassword: "pass" }, { newUsername: "Admin", newPassword: "pass" }]) {
        await rejects(auth.updateCredential({ expectedVersion: 1, ...options }), "NO_CHANGE");
    }
    await rejects(auth.updateCredential({ expectedVersion: 2, newUsername: "Other" }), "STALE_VERSION");
    await rejects(auth.updateCredential({ expectedVersion: 1, newUsername: "bad name" }), "INVALID_INPUT");
    await rejects(auth.updateCredential({ expectedVersion: 1, newPassword: "" }), "INVALID_INPUT");
    await rejects(auth.updateCredential({ expectedVersion: 1.5, newUsername: "Other" }), "INVALID_INPUT");
    assert.deepEqual(auth.getCredential(), before);
});

test("concurrent initialization and version-checked updates across connections", async t => {
    const f = fixture(t), first = f.open(), second = f.open();
    const init = await Promise.allSettled([first.initializeCredential("Admin", "pass"), second.initializeCredential("Admin", "pass")]);
    assert.equal(init.filter(x => x.status === "fulfilled").length, 1);
    assert.equal(init.find(x => x.status === "rejected").reason.code, "ALREADY_INITIALIZED");
    const updates = await Promise.allSettled([
        first.updateCredential({ expectedVersion: 1, newPassword: "replacement" }),
        second.updateCredential({ expectedVersion: 1, newUsername: "Renamed" })
    ]);
    assert.equal(updates.filter(x => x.status === "fulfilled").length, 1);
    assert.equal(updates.find(x => x.status === "rejected").reason.code, "STALE_VERSION");
    assert.equal(first.getCredential().credential_version, 2);
});

test("open failures and unrelated databases are rejected safely", t => {
    const f = fixture(t);
    for (const filename of [undefined, "", path.join(f.directory, "missing", "auth.db"), path.join(f.directory, "movies.db"), path.join(f.directory, "sessions.db")]) {
        assert.throws(() => createAdminAuth({ filename }), { code: "INITIALIZATION_FAILED", message: "Admin credential operation failed." });
    }
    const existing = new Database(f.filename);
    try {
        existing.exec("CREATE TABLE movies (id INTEGER)");
        assert.throws(() => f.open(), { code: "INITIALIZATION_FAILED" });
        assert.equal(existing.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'admin_credentials'").get().n, 0);
    } finally { existing.close(); }
});
