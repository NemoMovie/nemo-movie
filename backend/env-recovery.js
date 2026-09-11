import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import dotenv from "dotenv";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const names = ["backend/.env", "telegram-bot/.env"];
const MAX_FILE = 256 * 1024;
const MAX_PACKAGE = 2 * 1024 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = () => new Error("Environment recovery operation refused or failed.");
const fold = p => process.platform === "win32" ? p.toLowerCase() : p;
const forbiddenDrive = p => /^(?:\\\\\?\\)?e:/i.test(p);

function inside(a, b) {
    const relative = path.relative(fold(b), fold(a));
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

// Reject directory links before following them, including existing ancestors.
function checkedPath(value) {
    if (typeof value !== "string" || !value.trim() || forbiddenDrive(value)) throw fail();
    const absolute = path.resolve(value);
    if (forbiddenDrive(absolute)) throw fail();
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) throw fail();
        } catch (error) { if (error.code !== "ENOENT") throw fail(); }
    }
    let ancestor = absolute, suffix = [];
    while (!fs.existsSync(ancestor)) {
        suffix.unshift(path.basename(ancestor));
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw fail();
        ancestor = parent;
    }
    const result = path.join(fs.realpathSync(ancestor), ...suffix);
    if (forbiddenDrive(result)) throw fail();
    return result;
}

export function validateRecoveryRoot(root, extraForbidden = []) {
    try {
        if (/(?:^|[\\/])OneDrive(?:[^\\/]*)?(?:[\\/]|$)/i.test(root)) throw fail();
        const actual = checkedPath(root);
        const blocked = [repository, "C:\\NemoMovieData", "C:\\NemoMovieBackups", ...extraForbidden,
            ...[process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].filter(Boolean)];
        if (blocked.some(p => inside(actual, checkedPath(p)))) throw fail();
        return actual;
    } catch { throw fail(); }
}

export function encodePackage(files, timestamp = new Date().toISOString()) {
    if (!Array.isArray(files) || files.length !== 2) throw fail();
    const entries = names.map((name, i) => {
        if (!Buffer.isBuffer(files[i]) || files[i].length > MAX_FILE) throw fail();
        return { name, data: files[i].toString("base64") };
    });
    const manifest = { version: 1, timestamp, files: names.map((name, i) => ({ name, bytes: files[i].length, sha256: hash(files[i]) })) };
    return Buffer.from(JSON.stringify({ version: 1, entries,
        manifest: { name: "recovery-manifest.json", content: manifest } }));
}

export function decodePackage(bytes) {
    try {
        if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PACKAGE) throw fail();
        const p = JSON.parse(bytes.toString("utf8"));
        if (p.version !== 1 || Object.keys(p).sort().join() !== "entries,manifest,version" ||
            !Array.isArray(p.entries) || p.entries.length !== 2 || p.manifest.name !== "recovery-manifest.json") throw fail();
        const m = p.manifest.content;
        if (Object.keys(p.manifest).sort().join() !== "content,name" ||
            Object.keys(m).sort().join() !== "files,timestamp,version" || m.version !== 1 ||
            typeof m.timestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(m.timestamp) ||
            new Date(m.timestamp).toISOString() !== m.timestamp || !Array.isArray(m.files) || m.files.length !== 2) throw fail();
        return names.map((name, i) => {
            const e = p.entries[i], info = m.files[i];
            if (Object.keys(e).sort().join() !== "data,name" || e.name !== name ||
                Object.keys(info).sort().join() !== "bytes,name,sha256" || info.name !== name ||
                typeof e.data !== "string" || e.data.length > MAX_FILE * 2) throw fail();
            const value = Buffer.from(e.data, "base64");
            if (value.toString("base64") !== e.data || value.length > MAX_FILE || info.bytes !== value.length || hash(value) !== info.sha256) throw fail();
            return value;
        });
    } catch { throw fail(); }
}

export function verifyBytes(payload, originals) {
    const restored = decodePackage(payload);
    try { if (restored.some((b, i) => !b.equals(originals[i]))) throw fail(); }
    finally { restored.forEach(b => b.fill(0)); }
}

export function variableStructure(files) {
    const required = [["SESSION_SECRET", "ADMIN_DATABASE_PATH", "MAPPING_READ_SECRET", "MAPPING_WRITE_SECRET"],
        ["BOT_TOKEN", "BACKEND_URL", "STORAGE_GROUP_ID", "MAPPING_READ_SECRET", "MAPPING_WRITE_SECRET"]];
    return files.map((bytes, i) => {
        const found = new Set();
        // Only assignment names are captured; values are never parsed or returned.
        for (const line of bytes.toString("utf8").split(/\r?\n/)) {
            const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
            if (match) found.add(match[1]);
        }
        return { count: found.size, requiredNamesPass: required[i].every(n => found.has(n)) };
    });
}

export function ageVersion() {
    try {
        const version = execFileSync("age", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (!/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw fail();
        return version;
    } catch { throw new Error("age unavailable: install the official Windows package with winget install --id FiloSottile.age"); }
}

// Only age owns passphrase prompting. No passphrase argument, variable or IPC API.
export function ageTransform(operation, input, { spawnProcess = spawn, report = message => console.error(message) } = {}) {
    return new Promise((resolve, reject) => {
        if (!["encrypt", "decrypt"].includes(operation) || input.length > MAX_PACKAGE) return reject(fail());
        // age owns CONIN$/CONOUT$ on Windows. Do not read/resume Node stdin here.
        // Its native encryption prompt cannot be changed or disable generation by flag.
        report(operation === "encrypt"
            ? "Encryption: enter a NON-EMPTY passphrase, then confirm it in age. Nemo Movie does not support the blank/autogenerate option. Use Ctrl+C to cancel."
            : "Verification/decryption: enter the SAME non-empty passphrase you chose for encryption. This is a new age prompt; blank input is not accepted.");
        const args = operation === "encrypt" ? ["--passphrase"] : ["--decrypt"];
        const child = spawnProcess("age", args, { stdio: ["pipe", "pipe", "inherit"], shell: false });
        const chunks = [];
        let size = 0, failed = false;
        const abort = () => { failed = true; child.kill(); };
        child.on("error", () => { failed = true; reject(fail()); });
        child.stdin.on("error", abort);
        child.stdout.on("data", chunk => { size += chunk.length; if (size > MAX_PACKAGE) abort(); else chunks.push(chunk); });
        child.on("close", code => {
            const result = !failed && code === 0 ? Buffer.concat(chunks) : null;
            chunks.forEach(c => c.fill(0));
            if (result) resolve(result);
            else {
                report(operation === "encrypt"
                    ? "Encryption did not complete. No recovery package will be published."
                    : "Verification/decryption did not complete. Empty, incorrect or unavailable terminal input cannot produce a successful recovery package.");
                reject(fail());
            }
        });
        child.stdin.end(input);
    });
}

function restrictDirectory(directory) {
    if (process.platform !== "win32") { fs.chmodSync(directory, 0o700); return; }
    try {
        const identity = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const sid = identity.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
        if (!sid) throw fail();
        execFileSync("icacls", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { stdio: "ignore" });
    } catch { throw fail(); }
}

export function readSources(sourceRepository = repository) {
    try {
        const base = checkedPath(sourceRepository);
        return names.map(name => {
            const file = checkedPath(path.join(base, name));
            if (!inside(file, checkedPath(path.join(base, path.dirname(name))))) throw fail();
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) throw fail();
            if (execFileSync("git", ["ls-files", "--", name], { cwd: base, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) throw fail();
            execFileSync("git", ["check-ignore", "-q", "--", name], { cwd: base, stdio: "ignore" });
            return fs.readFileSync(file);
        });
    } catch { throw fail(); }
}

export async function createRecovery({ files, root = "C:\\NemoMovieSecretsRecovery", extraForbidden = [] },
    { transform = ageTransform, io = fs } = {}) {
    let work, payload, decrypted;
    try {
        root = validateRecoveryRoot(root, extraForbidden);
        // Root may exist, but every operation gets a fresh private working directory.
        fs.mkdirSync(root, { recursive: true });
        work = fs.mkdtempSync(path.join(root, ".nemo-env-recovery-work-"));
        restrictDirectory(work);
        const timestamp = new Date().toISOString();
        const base = "nemo-env-" + timestamp.replace(/[:.]/g, "-") + "-" + randomUUID();
        payload = encodePackage(files, timestamp);
        const ciphertext = await transform("encrypt", payload);
        const partial = path.join(work, base + ".partial");
        io.writeFileSync(partial, ciphertext, { flag: "wx", mode: 0o600 });
        decrypted = await transform("decrypt", fs.readFileSync(partial));
        verifyBytes(decrypted, files);
        const metadata = { formatVersion: 1, createdAt: timestamp, packageFilename: base + ".age",
            ciphertextSha256: hash(ciphertext), verified: true };
        const metaPartial = path.join(work, base + ".metadata.json");
        io.writeFileSync(metaPartial, JSON.stringify(metadata, null, 2), { flag: "wx", mode: 0o600 });
        // Exclusive copies do not replace existing packages. Metadata publishes last.
        io.copyFileSync(partial, path.join(root, base + ".age"), fs.constants.COPYFILE_EXCL);
        io.copyFileSync(metaPartial, path.join(root, base + ".metadata.json"), fs.constants.COPYFILE_EXCL);
        return metadata;
    } catch { throw fail(); }
    finally {
        payload?.fill(0); decrypted?.fill(0);
        if (work) {
            try { io.rmSync(work, { recursive: true, force: true }); }
            catch { throw new Error(`Recovery working-folder cleanup failed: ${work}`); }
        }
    }
}

export async function restoreTest({ packageFile, root = "C:\\NemoMovieSecretsRecovery", extraForbidden = [] },
    { transform = ageTransform, io = fs } = {}) {
    let work, payload, files;
    try {
        root = validateRecoveryRoot(root, extraForbidden);
        const source = checkedPath(packageFile);
        const stat = fs.lstatSync(source);
        if (!stat.isFile() || stat.size > MAX_PACKAGE) throw fail();
        payload = await transform("decrypt", fs.readFileSync(source));
        files = decodePackage(payload); // Full authentication/validation before plaintext writes.
        root = validateRecoveryRoot(root, [...extraForbidden, ...configuredForbidden(files)]);
        const structure = variableStructure(files);
        if (structure.some(s => !s.requiredNamesPass)) throw fail();
        fs.mkdirSync(root, { recursive: true });
        work = fs.mkdtempSync(path.join(root, ".nemo-env-recovery-work-"));
        restrictDirectory(work);
        for (const [i, name] of ["backend.env", "telegram-bot.env"].entries()) {
            io.writeFileSync(path.join(work, name), files[i], { flag: "wx", mode: 0o600 });
            if (!fs.readFileSync(path.join(work, name)).equals(files[i])) throw fail();
        }
        return structure;
    } catch { throw fail(); }
    finally {
        payload?.fill(0); files?.forEach(b => b.fill(0));
        if (work) {
            try { io.rmSync(work, { recursive: true, force: true }); }
            catch { throw new Error(`Plaintext cleanup failed; inspect this exact disposable folder: ${work}`); }
        }
    }
}

export function syntheticFiles() {
    return [Buffer.from("SESSION_SECRET=fake\nADMIN_DATABASE_PATH=fake\nMAPPING_READ_SECRET=fake-read\nMAPPING_WRITE_SECRET=fake-write\n"),
        Buffer.from("BOT_TOKEN=fake\nBACKEND_URL=https://example.invalid\nSTORAGE_GROUP_ID=fake\nMAPPING_READ_SECRET=fake-read\nMAPPING_WRITE_SECRET=fake-write\n")];
}

function configuredForbidden(files) {
    const env = { ...dotenv.parse(files[0]), ...process.env };
    return [env.UPLOADS_DIR && path.resolve(repository, "backend", env.UPLOADS_DIR), env.BACKUP_ROOT,
        ...["DATABASE_PATH", "ADMIN_DATABASE_PATH", "SESSION_DATABASE_PATH"].map(k =>
            env[k] && path.dirname(path.resolve(repository, "backend", env[k])))].filter(Boolean);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let files;
    try {
        const [mode, option] = process.argv.slice(2);
        if (!["synthetic", "create-real", "restore-test"].includes(mode) || process.argv.length > 4 ||
            (mode === "create-real" && option !== "--confirm-prompt-tested") || (mode === "synthetic" && option)) throw fail();
        console.log("age version: " + ageVersion()); // Happens before any production source reads.
        if (!process.stdin.isTTY || !process.stderr.isTTY) throw fail();
        const root = process.env.ENV_RECOVERY_ROOT || "C:\\NemoMovieSecretsRecovery";
        if (mode === "restore-test") {
            if (!option) throw fail();
            const result = await restoreTest({ root, packageFile: option });
            console.log(`backend variables: ${result[0].count} names detected\nbot variables: ${result[1].count} names detected\nrequired-name checks: PASS\nDisposable plaintext cleanup: confirmed`);
        } else {
            files = mode === "synthetic" ? syntheticFiles() : readSources();
            // Production values are used only to exclude configured data roots, never logged.
            const extraForbidden = mode === "synthetic" ? [] : configuredForbidden(files);
            await createRecovery({ files, root, extraForbidden });
            console.log("Encrypted package verified and published; no plaintext archive created.");
        }
    } catch (error) {
        // Only locally generated, bounded diagnostics reach the terminal.
        console.error(error.message.startsWith("age unavailable:") || error.message.startsWith("Plaintext cleanup failed;") ||
            error.message.startsWith("Recovery working-folder cleanup failed:") ? error.message : "Environment recovery failed; no success claimed.");
        process.exitCode = 1;
    } finally { files?.forEach(b => b.fill(0)); }
}
