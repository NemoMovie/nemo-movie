import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { encodePackage, decodePackage, verifyBytes, variableStructure, validateRecoveryRoot,
    createRecovery, restoreTest, syntheticFiles, readSources, ageTransform } from "./env-recovery.js";

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-env-test-"));
    t.after(() => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert(path.basename(root).startsWith("nemo-env-test-"));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}
// NOT encryption: isolated process-boundary mock, never used by production CLI.
const mockTransform = async (operation, input) => {
    if (operation === "encrypt") return Buffer.concat([Buffer.from("MOCK:"), input]);
    if (!input.subarray(0, 5).equals(Buffer.from("MOCK:"))) throw new Error("mock rejection");
    return Buffer.from(input.subarray(5));
};

test("bounded exact package, binary equality and names-only structural output", () => {
    const files = syntheticFiles();
    const payload = encodePackage(files);
    verifyBytes(payload, files);
    assert.deepEqual(decodePackage(payload), files);
    assert(variableStructure(files).every(s => s.requiredNamesPass));
    assert(!JSON.stringify(variableStructure(files)).includes("fake"));
    assert.throws(() => verifyBytes(payload, [Buffer.from("different"), files[1]]));
    assert.throws(() => encodePackage([Buffer.alloc(300000), files[1]]));
});

for (const [name, mutate] of [
    ["version", p => p.version = 2], ["unexpected entry", p => p.entries.push(p.entries[0])],
    ["duplicate", p => p.entries[1] = p.entries[0]], ["traversal", p => p.entries[0].name = "../.env"],
    ["absolute", p => p.entries[0].name = "C:/live/.env"], ["manifest", p => p.manifest = null],
    ["missing backend", p => p.entries.shift()], ["missing bot", p => p.entries.pop()],
    ["hash mismatch", p => p.manifest.content.files[0].sha256 = "bad"]
]) {
    test(`reject ${name}`, () => {
        const p = JSON.parse(encodePackage(syntheticFiles())); mutate(p);
        assert.throws(() => decodePackage(Buffer.from(JSON.stringify(p))), /refused or failed/);
    });
}

test("malformed and truncated package rejected without printing input", () => {
    assert.throws(() => decodePackage(Buffer.from("SECRET_MALFORMED")), error => !error.message.includes("SECRET_MALFORMED"));
    const p = encodePackage(syntheticFiles());
    assert.throws(() => decodePackage(p.subarray(0, p.length - 10)));
});

test("mock create, verify, safe metadata, isolated restore and successful cleanup", async t => {
    const root = fixture(t), files = syntheticFiles();
    const metadata = await createRecovery({ files, root }, { transform: mockTransform });
    assert.deepEqual(Object.keys(metadata).sort(), ["ciphertextSha256", "createdAt", "formatVersion", "packageFilename", "verified"]);
    assert(!JSON.stringify(metadata).includes("fake"));
    assert(!fs.readdirSync(root).some(n => n.startsWith(".nemo-env")));
    const result = await restoreTest({ root, packageFile: path.join(root, metadata.packageFilename) }, { transform: mockTransform });
    assert(result.every(s => s.requiredNamesPass));
    assert.equal(fs.readdirSync(root).length, 2);
});

test("output collision preserves existing file and cleans work folder", async t => {
    const root = fixture(t);
    await assert.rejects(createRecovery({ files: syntheticFiles(), root }, { transform: mockTransform,
        io: { ...fs, copyFileSync(from, to, flags) {
            fs.writeFileSync(to, "EXISTING"); fs.copyFileSync(from, to, flags);
        } } }));
    const entries = fs.readdirSync(root);
    assert.equal(entries.length, 1);
    assert.equal(fs.readFileSync(path.join(root, entries[0]), "utf8"), "EXISTING");
});

test("encryption/decryption rejection and partial-write failure never publish verified metadata", async t => {
    const root = fixture(t);
    for (const failAt of ["encrypt", "decrypt"]) {
        await assert.rejects(createRecovery({ files: syntheticFiles(), root }, {
            transform: async (op, input) => { if (op === failAt) throw new Error("SENSITIVE_PROVIDER_ERROR"); return mockTransform(op, input); }
        }), error => !error.message.includes("SENSITIVE_PROVIDER_ERROR"));
        assert.equal(fs.readdirSync(root).length, 0);
    }
    await assert.rejects(createRecovery({ files: syntheticFiles(), root }, { transform: mockTransform,
        io: { ...fs, writeFileSync() { throw new Error("disk full"); } } }));
    assert.equal(fs.readdirSync(root).length, 0);
});

test("wrong-passphrase/corrupt/truncated transform failures write no plaintext", async t => {
    const root = fixture(t), file = path.join(root, "test.age"); fs.writeFileSync(file, "BAD");
    for (const transform of [mockTransform, async () => { throw new Error("wrong passphrase"); }, async () => Buffer.from("{")]) {
        await assert.rejects(restoreTest({ root, packageFile: file }, { transform }));
        assert.deepEqual(fs.readdirSync(root), ["test.age"]);
    }
});

test("cleanup failure names only disposable folder; does not claim success", async t => {
    const root = fixture(t);
    const metadata = await createRecovery({ files: syntheticFiles(), root }, { transform: mockTransform });
    await assert.rejects(restoreTest({ root, packageFile: path.join(root, metadata.packageFilename) }, {
        transform: mockTransform, io: { ...fs, rmSync() { throw new Error("denied"); } }
    }), error => error.message.startsWith("Plaintext cleanup failed;") && !error.message.includes("fake"));
    assert(fs.readdirSync(root).some(n => n.startsWith(".nemo-env-recovery-work-")));
});

test("unsafe roots including repository, ordinary backup root, OneDrive and E refused", t => {
    const root = fixture(t);
    for (const candidate of [path.resolve("."), path.resolve("backend"), "C:\\NemoMovieBackups", "E:\\", "e:\\secrets", "\\\\?\\E:\\secrets", path.join(root, "OneDrive", "secrets")]) {
        assert.throws(() => validateRecoveryRoot(candidate));
    }
    assert.throws(() => validateRecoveryRoot(root, [root]));
});

test("source Git tracking and link rejection use synthetic repositories only", t => {
    const root = fixture(t);
    execFileSync("git", ["init", "-q", root]);
    for (const name of ["backend", "telegram-bot"]) { fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, ".env"), "FAKE=fixture\n"); }
    fs.writeFileSync(path.join(root, ".gitignore"), "*.env\n");
    assert.equal(readSources(root).length, 2);
    execFileSync("git", ["-C", root, "add", "-f", "backend/.env"], { stdio: "ignore" });
    assert.throws(() => readSources(root));
    const linked = path.join(root, "alias");
    try { fs.symlinkSync(path.join(root, "backend"), linked, process.platform === "win32" ? "junction" : "dir"); }
    catch (e) { if (["EPERM", "EACCES"].includes(e.code)) return t.skip("Links unavailable"); throw e; }
    assert.throws(() => validateRecoveryRoot(linked));
});

test("real age interactive roundtrip requires operator verification", { skip: "age unavailable on task PATH; native prompt requires operator input, never injected passphrases" }, () => {});

test("production age invocation never supplies a passphrase argument or environment value", () => {
    const source = fs.readFileSync(new URL("./env-recovery.js", import.meta.url), "utf8");
    assert(source.includes('["--passphrase"] : ["--decrypt"]'));
    assert(source.includes('stdio: ["pipe", "pipe", "inherit"], shell: false'));
    assert(!source.includes('AGE_PASSPHRASE'));
});

test("restore rejects decoded custom source root before any plaintext writes", async t => {
    const root = fixture(t), files = syntheticFiles();
    files[0] = Buffer.concat([files[0], Buffer.from(`UPLOADS_DIR=${root}\n`)]);
    const encrypted = await mockTransform("encrypt", encodePackage(files));
    const packageFile = path.join(root, "fixture.age"); fs.writeFileSync(packageFile, encrypted);
    await assert.rejects(restoreTest({ root, packageFile }, { transform: mockTransform }));
    assert.deepEqual(fs.readdirSync(root), ["fixture.age"]);
});

test("age stages use separate prompts, binary payload only and no custom terminal reader", async () => {
    const messages = [], calls = [];
    function spawnProcess(executable, args, options) {
        const child = new EventEmitter();
        child.stdin = new PassThrough(); child.stdout = new PassThrough();
        child.kill = () => {};
        calls.push({ executable, args, options });
        const chunks = [];
        child.stdin.on("data", chunk => chunks.push(chunk));
        child.stdin.on("finish", () => {
            const input = Buffer.concat(chunks);
            child.stdout.write(input); child.stdout.end(); child.emit("close", 0);
        });
        return child;
    }
    const payload = Buffer.from([0, 255, 128, 10]);
    for (const op of ["encrypt", "decrypt"]) {
        assert.deepEqual(await ageTransform(op, payload, { spawnProcess, report: m => messages.push(m) }), payload);
    }
    assert.deepEqual(calls.map(c => c.args), [["--passphrase"], ["--decrypt"]]);
    calls.forEach(c => {
        assert.equal(c.executable, "age");
        assert.deepEqual(c.options, { stdio: ["pipe", "pipe", "inherit"], shell: false });
    });
    assert.match(messages[0], /NON-EMPTY/); assert.match(messages[1], /SAME non-empty/);
});

test("empty/wrong passphrase child failures reject, without returning partial plaintext", async () => {
    for (const operation of ["encrypt", "decrypt"]) {
        const messages = [];
        const spawnProcess = () => {
            const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
            child.stdin.resume();
            child.stdin.on("finish", () => { child.stdout.write("SYNTHETIC_PRIVATE_PARTIAL"); child.emit("close", 1); });
            return child;
        };
        await assert.rejects(ageTransform(operation, Buffer.from("synthetic"), { spawnProcess, report: m => messages.push(m) }));
        assert(!messages.join().includes("SYNTHETIC_PRIVATE_PARTIAL"));
        assert.match(messages.at(-1), /did not complete/);
    }
});
