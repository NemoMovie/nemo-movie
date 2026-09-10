import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { resolveMovieDatabasePath } from "./movie-database-path.js";

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-db-path-"));
    const backend = path.join(root, "backend");
    for (const name of ["backend/uploads", "frontend", "private"]) fs.mkdirSync(path.join(root, name), { recursive: true });
    t.after(() => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert(path.basename(root).startsWith("nemo-db-path-"));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, backend, resolve: env => resolveMovieDatabasePath(backend, env) };
}

test("default/private and similarly named sibling paths remain allowed without creating files", t => {
    const f = fixture(t);
    for (const value of [undefined, "movies.db", "../private/catalogue.db", "uploads-private/movies.db", "../frontend-private/movies.db"]) {
        const result = f.resolve({ DATABASE_PATH: value });
        assert.equal(result, path.resolve(f.backend, value || "movies.db"));
        assert.equal(fs.existsSync(result), false);
    }
});

test("public roots, nested paths, traversal and custom uploads rejected", t => {
    const f = fixture(t);
    for (const value of ["../frontend", "../frontend/movies.db", "../frontend/nested/movies.db",
        "uploads", "uploads/nested/movies.db", "../private/../frontend/movies.db", "uploads/../uploads/movies.db"]) {
        assert.throws(() => f.resolve({ DATABASE_PATH: value }), /^Error: Invalid movie database configuration\.$/);
    }
    const custom = path.join(f.root, "custom-public");
    assert.throws(() => f.resolve({ UPLOADS_DIR: custom, DATABASE_PATH: path.join(custom, "nested/movies.db") }));
    assert.equal(fs.existsSync(custom), false);
    assert.equal(f.resolve({ UPLOADS_DIR: custom }), path.join(f.backend, "movies.db"));
});

test("Windows case differences cannot bypass roots", { skip: process.platform !== "win32" }, t => {
    const f = fixture(t);
    for (const value of ["../FRONTEND/MOVIES.DB", "UPLOADS/nested/MOVIES.DB"]) {
        assert.throws(() => f.resolve({ DATABASE_PATH: value }));
    }
});

test("junction/symlink ancestors resolve before containment checks", t => {
    const f = fixture(t);
    const alias = path.join(f.root, "alias");
    try { fs.symlinkSync(path.join(f.root, "frontend"), alias, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
        if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Link creation unavailable");
        throw error;
    }
    assert.throws(() => f.resolve({ DATABASE_PATH: path.join(alias, "new/nested/movies.db") }));
    const publicAlias = path.join(f.root, "public-alias");
    fs.symlinkSync(path.join(f.root, "private"), publicAlias, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => f.resolve({ UPLOADS_DIR: publicAlias, DATABASE_PATH: "../private/movies.db" }));
});

test("both entry points validate before any SQLite open", t => {
    const f = fixture(t);
    for (const name of ["server.js", "database.js"]) {
        const url = new URL(name, import.meta.url);
        const source = fs.readFileSync(url, "utf8");
        const end = source.indexOf("const databasePath = resolveMovieDatabasePath(__dirname);") +
            "const databasePath = resolveMovieDatabasePath(__dirname);".length;
        assert(end > 60);
        assert(source.indexOf("new Database(") > end);
        const prefix = source.slice(0, end).replace(/^import .*;\r?\n/gm, "")
            .replaceAll("import.meta.url", JSON.stringify(url.href));
        let opens = 0;
        assert.throws(() => vm.runInNewContext(prefix + "\nnew Database(databasePath);", {
            path, fileURLToPath,
            resolveMovieDatabasePath: () => f.resolve({ DATABASE_PATH: "../frontend/rejected.db" }),
            Database: function() { opens++; }
        }), /Invalid movie database configuration/);
        assert.equal(opens, 0);
        assert.equal(fs.existsSync(path.join(f.root, "frontend/rejected.db")), false);
    }
});
