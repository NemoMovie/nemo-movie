import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapAdmin, validateDatabasePath } from "./bootstrap-admin.js";
import { createAdminAuth } from "./admin-auth.js";

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bootstrap-test-"));
    t.after(() => {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert(path.basename(resolved).startsWith("nemo-bootstrap-test-"));
        fs.rmSync(resolved, { recursive: true, force: true });
        assert.equal(fs.existsSync(resolved), false);
    });
    return { ADMIN_USERNAME: " Synthetic Admin ", ADMIN_PASSWORD: " synthetic secret ",
        ADMIN_DATABASE_PATH: path.join(directory, "private", "admin-auth.db") };
}

test("missing configuration fails without creating a database", async t => {
    const env = fixture(t);
    for (const name of ["ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_DATABASE_PATH"]) {
        for (const value of [undefined, ""]) {
            assert.equal((await bootstrapAdmin({ ...env, [name]: value })).ok, false);
        }
    }
    assert.equal(fs.existsSync(env.ADMIN_DATABASE_PATH), false);
});

test("first bootstrap verifies exact credentials; second refuses without modifying database", async t => {
    const env = fixture(t);
    const result = await bootstrapAdmin(env);
    assert.deepEqual(result, { ok: true, code: "OK", message: "Admin credential bootstrap verified successfully." });
    const auth = createAdminAuth({ filename: env.ADMIN_DATABASE_PATH });
    try {
        assert(await auth.verifyCredential(env.ADMIN_USERNAME, env.ADMIN_PASSWORD));
        assert.equal(await auth.verifyCredential(env.ADMIN_USERNAME.trim(), env.ADMIN_PASSWORD), false);
        assert.equal(await auth.verifyCredential(env.ADMIN_USERNAME, env.ADMIN_PASSWORD.trim()), false);
        const row = auth.getCredential();
        assert.equal(row.credential_version, 1);
        const output = JSON.stringify(result);
        for (const secret of [env.ADMIN_USERNAME, env.ADMIN_PASSWORD, row.password_hash, row.password_hash.split("$")[3]]) {
            assert.equal(output.includes(secret), false);
        }
    } finally { auth.close(); }
    const before = fs.readFileSync(env.ADMIN_DATABASE_PATH);
    assert.equal((await bootstrapAdmin({ ...env, ADMIN_PASSWORD: "different" })).code, "EXISTS");
    assert(fs.readFileSync(env.ADMIN_DATABASE_PATH).equals(before));
});

test("failed verification and exceptions return generic failure and close store", async t => {
    for (const mode of ["false", "throw", "bad-version", "close-error"]) {
        const env = fixture(t);
        let closed = false;
        const result = await bootstrapAdmin(env, { createStore: () => ({
            initializeCredential: async () => {},
            verifyCredential: async () => { if (mode === "throw") throw new Error(env.ADMIN_PASSWORD); return mode !== "false"; },
            getCredential: () => ({ credential_version: mode === "bad-version" ? 0 : 1 }),
            close: () => { closed = true; if (mode === "close-error") throw new Error(env.ADMIN_PASSWORD); }
        }) });
        assert(closed);
        assert.deepEqual(result, { ok: false, code: "FAILED", message: "Admin credential bootstrap failed." });
    }
});

test("path safety rejects project/public directories and configured database collisions", async t => {
    const env = fixture(t);
    const backend = path.dirname(fileURLToPath(import.meta.url));
    for (const filename of ["relative.db", path.join(backend, "admin-auth.db"),
        path.join(backend, "../frontend/credentials.db"), path.join(backend, "uploads/credentials.db"),
        path.join(path.dirname(env.ADMIN_DATABASE_PATH), "movies.db"), path.join(path.dirname(env.ADMIN_DATABASE_PATH), "sessions.db")]) {
        assert.throws(() => validateDatabasePath({ ...env, ADMIN_DATABASE_PATH: filename }));
    }
    for (const name of ["DATABASE_PATH", "SESSION_DATABASE_PATH"]) {
        assert.throws(() => validateDatabasePath({ ...env, [name]: env.ADMIN_DATABASE_PATH }));
    }
    assert.throws(() => validateDatabasePath({ ...env, UPLOADS_DIR: path.dirname(env.ADMIN_DATABASE_PATH) }));
    assert.equal(fs.existsSync(env.ADMIN_DATABASE_PATH), false);
});

test("existing file is never opened, even if it is not a credential database", async t => {
    const env = fixture(t);
    fs.mkdirSync(path.dirname(env.ADMIN_DATABASE_PATH), { recursive: true });
    fs.writeFileSync(env.ADMIN_DATABASE_PATH, "sentinel");
    const result = await bootstrapAdmin(env, { createStore: () => { throw new Error("Must not open"); } });
    assert.equal(result.code, "EXISTS");
    assert.equal(fs.readFileSync(env.ADMIN_DATABASE_PATH, "utf8"), "sentinel");
});
