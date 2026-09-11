import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { previewRetention, formatPreview, isoWeek, validateRoot } from "./retention.js";

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-retention-test-"));
    t.after(() => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert(path.basename(root).startsWith("nemo-retention-test-"));
        fs.rmSync(root, { recursive: true, force: true });
    });
    let n = 0;
    function add(stamp, options = {}) {
        const name = options.name || stamp.replace(/[:.]/g, "-") + `-00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        const dir = path.join(root, name); fs.mkdirSync(dir);
        if (!options.noComplete) fs.writeFileSync(path.join(dir, "COMPLETE"), "Verified\n");
        if (!options.noManifest) fs.writeFileSync(path.join(dir, "manifest.json"), options.raw ?? JSON.stringify({ backupVersion: 1, verificationSuccess: true, timestamp: stamp, ...options.manifest }));
        if (options.protected) fs.writeFileSync(path.join(dir, "PROTECTED"), "SECRET_DO_NOT_PRINT");
        return { name, dir };
    }
    return { root, add, preview: () => previewRetention({ root, now: Date.parse("2026-09-11T12:00:00.000Z") }) };
}

test("populated buckets, gaps, multiple daily snapshots and overlapping tiers", t => {
    const f = fixture(t);
    for (let day = 1; day <= 10; day++) f.add(`2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`);
    const newest = f.add("2026-09-10T11:00:00.000Z");
    for (const stamp of ["2026-08-15", "2026-07-15", "2026-06-15", "2025-01-01"]) f.add(stamp + "T00:00:00.000Z");
    const entries = f.preview();
    const top = entries.find(e => e.name === newest.name);
    assert.deepEqual(top.reasons, ["newest verified", "daily", "weekly", "monthly"]);
    assert.equal(entries.filter(e => e.reasons.includes("daily")).length, 7);
    assert.equal(entries.filter(e => e.reasons.includes("weekly")).length, 4);
    assert.equal(entries.filter(e => e.reasons.includes("monthly")).length, 3);
    assert.equal(entries.find(e => e.timestamp === "2026-09-10T10:00:00.000Z").classification, "WOULD DELETE");
    assert.equal(entries.find(e => e.timestamp === "2025-01-01T00:00:00.000Z").classification, "WOULD DELETE");
});

test("ISO year transition, Monday boundary and leap date", t => {
    assert.equal(isoWeek("2021-01-01T00:00:00.000Z"), "2020-W53");
    assert.equal(isoWeek("2021-01-03T23:59:59.999Z"), "2020-W53");
    assert.equal(isoWeek("2021-01-04T00:00:00.000Z"), "2021-W01");
    const f = fixture(t);
    f.add("2024-02-29T00:00:00.000Z"); f.add("2024-03-01T00:00:00.000Z");
    assert.equal(f.preview().filter(e => e.reasons.includes("monthly")).length, 2);
});

test("only/newest, deterministic timestamp ties and protected snapshots", t => {
    const f = fixture(t);
    const first = f.add("2026-09-01T00:00:00.000Z");
    assert(f.preview()[0].reasons.includes("only verified"));
    const second = f.add("2026-09-01T00:00:00.000Z", { protected: true });
    const result = f.preview();
    assert(result.find(e => e.name === first.name).reasons.includes("newest verified"));
    assert(result.find(e => e.name === second.name).reasons.includes("protected"));
    assert.equal(result.find(e => e.name === second.name).classification, "KEEP");
    assert.deepEqual(f.preview(), result);
    assert(!formatPreview(result).includes("SECRET_DO_NOT_PRINT"));
});

test("malformed metadata and missing markers are always kept for review", t => {
    const f = fixture(t);
    for (const options of [{ noComplete: true }, { noManifest: true }, { raw: "{" },
        { manifest: { backupVersion: 9 } }, { manifest: { verificationSuccess: false } },
        { manifest: { timestamp: "2026-02-30T00:00:00.000Z" } },
        { manifest: { timestamp: "2099-01-01T00:00:00.000Z" } },
        { manifest: { timestamp: "2026-09-02T00:00:00.000Z" } }]) {
        f.add("2026-09-01T00:00:00.000Z", options);
    }
    const malformed = f.add("2026-09-01T00:00:00.000Z");
    fs.mkdirSync(path.join(malformed.dir, "PROTECTED"));
    assert(f.preview().every(e => e.classification === "KEEP/REVIEW"));
});

test("partials excluded, unrecognized entries reviewed and preview makes zero changes", t => {
    const f = fixture(t);
    f.add("2026-09-01T00:00:00.000Z", { name: ".partial-test" });
    f.add("2026-09-01T00:00:00.000Z");
    fs.writeFileSync(path.join(f.root, "other.txt"), "do not read");
    const inventory = directory => fs.readdirSync(directory).sort().map(name => {
        const p = path.join(directory, name), s = fs.lstatSync(p);
        return [name, s.mtimeMs, s.isDirectory() ? inventory(p) : fs.readFileSync(p).toString("hex")];
    });
    const before = inventory(f.root);
    const result = f.preview();
    assert.equal(result.find(e => e.name === ".partial-test").classification, "IGNORE");
    assert.equal(result.find(e => e.name === "other.txt").classification, "KEEP/REVIEW");
    assert.deepEqual(inventory(f.root), before);
    assert.match(formatPreview(result), /Summary:/);
});

test("unsafe roots, configured sources, case/traversal and E drive rejected", t => {
    const f = fixture(t);
    for (const root of ["E:\\", "e:\\backups", "\\\\?\\E:\\backups", path.resolve("backend/..")]) {
        assert.throws(() => validateRoot(root), /unsafe/);
    }
    for (const env of [{ UPLOADS_DIR: f.root }, { DATABASE_PATH: path.join(f.root, "movies.db") },
        { ADMIN_DATABASE_PATH: path.join(f.root, "admin.db") }, { SESSION_DATABASE_PATH: path.join(f.root, "sessions.db") }]) {
        assert.throws(() => validateRoot(f.root, env));
    }
    if (process.platform === "win32") assert.throws(() => validateRoot(f.root.toUpperCase(), { UPLOADS_DIR: f.root }));
});

test("linked roots/candidates/markers are not followed as retention candidates", t => {
    const f = fixture(t);
    const valid = f.add("2026-09-01T00:00:00.000Z");
    const link = path.join(f.root, "linked");
    try { fs.symlinkSync(valid.dir, link, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Links unavailable"); throw error; }
    assert.equal(f.preview().find(e => e.name === "linked").classification, "KEEP/REVIEW");
    assert.throws(() => validateRoot(link));
    fs.symlinkSync(valid.dir, path.join(valid.dir, "PROTECTED"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(f.preview().find(e => e.name === valid.name).classification, "KEEP/REVIEW");
});
