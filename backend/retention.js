import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const backend = path.dirname(fileURLToPath(import.meta.url));
const repository = path.dirname(backend);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function canonical(value) {
    const absolute = path.resolve(value);
    try { return fs.realpathSync(absolute); }
    catch (error) {
        if (error.code !== "ENOENT") throw error;
        try { fs.lstatSync(absolute); throw new Error(); }
        catch (e) { if (e.code !== "ENOENT") throw e; }
        const parent = path.dirname(absolute);
        if (parent === absolute) throw new Error();
        return path.join(canonical(parent), path.basename(absolute));
    }
}
function inside(a, b) {
    if (process.platform === "win32") { a = a.toLowerCase(); b = b.toLowerCase(); }
    const relative = path.relative(b, a);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}
export function validateRoot(root, env = {}) {
    try {
        if (typeof root !== "string" || !root.trim() || /^(?:\\\\\?\\)?e:/i.test(root)) throw new Error();
        const actual = canonical(root);
        if (/^(?:\\\\\?\\)?e:/i.test(actual)) throw new Error();
        const roots = [repository, "C:\\NemoMovieData", path.resolve(backend, env.UPLOADS_DIR || "uploads"),
            path.dirname(path.resolve(backend, env.DATABASE_PATH || "movies.db")),
            path.dirname(path.resolve(backend, env.SESSION_DATABASE_PATH || "sessions.db"))];
        if (env.ADMIN_DATABASE_PATH) roots.push(path.dirname(path.resolve(env.ADMIN_DATABASE_PATH)));
        if (roots.some(p => inside(actual, canonical(p)))) throw new Error();
        const stat = fs.lstatSync(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
        return actual;
    } catch { throw new Error("Retention root is unavailable or unsafe."); }
}
function regular(file) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error();
    return info;
}
export function isoWeek(timestamp) {
    const d = new Date(timestamp);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const year = d.getUTCFullYear();
    const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
    return `${year}-W${String(week).padStart(2, "0")}`;
}

export function previewRetention({ root = "C:\\NemoMovieBackups", env = {}, now = Date.now() } = {}) {
    root = validateRoot(root, env);
    if (!Number.isFinite(now)) throw new Error("Invalid preview time.");
    const entries = fs.readdirSync(root).sort(compare).map(name => {
        const item = { name, classification: "KEEP/REVIEW", timestamp: null, reasons: [] };
        if (name.startsWith(".partial-")) return { ...item, classification: "IGNORE", reasons: ["incomplete snapshot"] };
        try {
            const directory = path.join(root, name);
            const stat = fs.lstatSync(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(canonical(directory), root)) throw new Error();
            regular(path.join(directory, "COMPLETE"));
            const manifestPath = path.join(directory, "manifest.json");
            if (regular(manifestPath).size > 1024 * 1024) throw new Error();
            const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            if (manifest.backupVersion !== 1 || manifest.verificationSuccess !== true) throw new Error();
            const stamp = manifest.timestamp;
            if (typeof stamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(stamp) ||
                !Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString() !== stamp || Date.parse(stamp) > now) throw new Error();
            item.timestamp = stamp;
            const prefix = stamp.replace(/[:.]/g, "-");
            if (!new RegExp("^" + prefix + "-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$").test(name)) throw new Error();
            try { regular(path.join(directory, "PROTECTED")); item.reasons.push("protected"); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            item.classification = "WOULD DELETE";
        } catch { item.reasons = ["unrecognized, malformed or unsafe snapshot; inspect manually"]; }
        return item;
    });
    const candidates = entries.filter(e => e.classification === "WOULD DELETE")
        .sort((a, b) => compare(b.timestamp, a.timestamp) || compare(a.name, b.name));
    if (candidates.length) candidates[0].reasons.push("newest verified", ...(candidates.length === 1 ? ["only verified"] : []));
    for (const [reason, limit, key] of [["daily", 7, s => s.slice(0, 10)],
        ["weekly", 4, isoWeek], ["monthly", 3, s => s.slice(0, 7)]]) {
        const buckets = new Set();
        for (const item of candidates) {
            const bucket = key(item.timestamp);
            if (!buckets.has(bucket) && buckets.size < limit) {
                buckets.add(bucket); item.reasons.push(reason);
            }
        }
    }
    for (const item of candidates) {
        if (item.reasons.length) item.classification = "KEEP";
        else item.reasons.push("outside all retention selections");
    }
    return entries;
}

export function formatPreview(entries) {
    // JSON escaping prevents filenames from injecting terminal control sequences.
    const counts = { KEEP: 0, "WOULD DELETE": 0, "KEEP/REVIEW": 0, IGNORE: 0 };
    const lines = ["MODE: DRY RUN — preview only; no changes"];
    for (const entry of entries) {
        counts[entry.classification]++;
        lines.push(`${entry.classification} ${JSON.stringify(entry.name)} ${entry.timestamp || ""} — ${entry.reasons.join("; ")}`);
    }
    lines.push("Summary: " + Object.entries(counts).map(([key, value]) => `${key}: ${value}`).join(", "));
    return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.slice(2).some(arg => arg !== "--dry-run")) throw new Error();
        let configured = {};
        try { configured = dotenv.parse(fs.readFileSync(path.join(backend, ".env"))); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        const env = { ...configured, ...process.env };
        console.log(formatPreview(previewRetention({ root: env.RETENTION_ROOT || "C:\\NemoMovieBackups", env })));
    } catch { console.error("Retention preview refused: check root, configuration and arguments. No changes made."); process.exitCode = 1; }
}
