import fs from "node:fs";
import path from "node:path";

function canonical(filename) {
    try {
        return fs.realpathSync(filename);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        // Reject dangling links rather than treating them as nonexistent files.
        try { fs.lstatSync(filename); throw new Error(); }
        catch (statError) { if (statError.code !== "ENOENT") throw statError; }
        const parent = path.dirname(filename);
        if (parent === filename) throw new Error();
        return path.join(canonical(parent), path.basename(filename));
    }
}

function inside(filename, root) {
    if (process.platform === "win32") {
        filename = filename.toLowerCase();
        root = root.toLowerCase();
    }
    const relative = path.relative(root, filename);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." &&
        !relative.startsWith(".." + path.sep));
}

export function resolveMovieDatabasePath(backendDir, env = process.env) {
    try {
        const filename = path.resolve(backendDir, env.DATABASE_PATH || "movies.db");
        const roots = [path.resolve(backendDir, "../frontend"),
            path.resolve(backendDir, env.UPLOADS_DIR || "uploads")];
        const target = canonical(filename);
        if (roots.some(root => inside(filename, root) || inside(target, canonical(root)))) throw new Error();
        return filename;
    } catch {
        throw new Error("Invalid movie database configuration.");
    }
}
