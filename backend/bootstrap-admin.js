import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createAdminAuth } from "./admin-auth.js";

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(backendDir);

function canonical(filename) {
    const absolute = path.resolve(filename);
    const resolved = fs.existsSync(absolute) ? fs.realpathSync(absolute)
        : path.join(canonical(path.dirname(absolute)), path.basename(absolute));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function inside(filename, directory) {
    const relative = path.relative(directory, filename);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

export function validateDatabasePath(env) {
    const value = env.ADMIN_DATABASE_PATH;
    if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) throw new Error("Invalid configuration.");
    const filename = path.resolve(value);
    const target = canonical(filename);
    const protectedFiles = [
        path.resolve(backendDir, env.DATABASE_PATH || "movies.db"),
        path.resolve(backendDir, env.SESSION_DATABASE_PATH || "sessions.db"),
        path.join(backendDir, "movies.db"), path.join(backendDir, "sessions.db")
    ];
    const forbiddenRoots = [projectDir, path.resolve(backendDir, env.UPLOADS_DIR || "uploads")];
    if (forbiddenRoots.some(root => inside(target, canonical(root))) ||
        protectedFiles.some(file => target === canonical(file)) ||
        ["movies.db", "sessions.db"].includes(path.basename(target).toLowerCase())) throw new Error("Invalid configuration.");
    // Existing paths, including hardlinks and symlinks, are refused by bootstrap before opening SQLite.
    return filename;
}

export async function bootstrapAdmin(env, { createStore = createAdminAuth } = {}) {
    let store;
    let result;
    try {
        if (typeof env.ADMIN_USERNAME !== "string" || !env.ADMIN_USERNAME.trim() ||
            typeof env.ADMIN_PASSWORD !== "string" || !env.ADMIN_PASSWORD.length) throw new Error();
        const filename = validateDatabasePath(env);
        if (fs.existsSync(filename)) return { ok: false, code: "EXISTS", message: "Admin credential bootstrap refused: database already exists." };
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        // Revalidate after directory creation and reserve atomically to prevent competing bootstraps.
        validateDatabasePath(env);
        let descriptor;
        try { descriptor = fs.openSync(filename, "wx", 0o600); }
        catch (error) {
            if (error.code === "EEXIST") return { ok: false, code: "EXISTS", message: "Admin credential bootstrap refused: database already exists." };
            throw error;
        }
        fs.closeSync(descriptor);
        store = createStore({ filename });
        await store.initializeCredential(env.ADMIN_USERNAME, env.ADMIN_PASSWORD);
        const verified = await store.verifyCredential(env.ADMIN_USERNAME, env.ADMIN_PASSWORD);
        const row = store.getCredential();
        if (!verified || !row || !Number.isSafeInteger(row.credential_version) || row.credential_version <= 0) throw new Error();
        result = { ok: true, code: "OK", message: "Admin credential bootstrap verified successfully." };
    } catch {
        // Never attach raw errors: database and crypto errors may contain sensitive data.
        result = { ok: false, code: "FAILED", message: "Admin credential bootstrap failed." };
    } finally {
        try { store?.close(); } catch {
            result = { ok: false, code: "FAILED", message: "Admin credential bootstrap failed." };
        }
    }
    return result;
}

// Importing this module in tests neither loads production secrets nor runs bootstrap.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const loaded = dotenv.config({ path: path.join(backendDir, ".env"), quiet: true });
        if (loaded.error) throw new Error();
        const result = await bootstrapAdmin(process.env);
        console.log(result.message);
        process.exitCode = result.ok ? 0 : 1;
    } catch {
        console.error("Admin credential bootstrap failed.");
        process.exitCode = 1;
    }
}
