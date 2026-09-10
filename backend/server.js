import "dotenv/config";
import express from "express";
import session from "express-session";
import SQLiteSessionStore from "./session-store.js";
import { createAdminAuth, validateNewUsername } from "./admin-auth.js";
import { validateDatabasePath } from "./bootstrap-admin.js";
import Database from "better-sqlite3";
import path from "path";
import multer from "multer";
import fs from "fs";
import { fileURLToPath } from "url";
import { timingSafeEqual, randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const databasePath = path.resolve(__dirname, process.env.DATABASE_PATH || "movies.db");
let adminAuth;
try {
    adminAuth = createAdminAuth({ filename: validateDatabasePath(process.env), requireExisting: true });
} catch {
    console.error("Admin credential storage is unavailable.");
    process.exit(1);
}
const uploadsDir = path.resolve(__dirname, process.env.UPLOADS_DIR || "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
const isProduction = process.env.NODE_ENV === "production";
let publicOrigin;
if (isProduction) {
    try {
        const configuredOrigin = new URL(process.env.PUBLIC_ORIGIN);
        if (!["http:", "https:"].includes(configuredOrigin.protocol)) throw new Error();
        publicOrigin = configuredOrigin.origin;
    } catch {
        console.error("Public origin is not configured correctly.");
        process.exit(1);
    }
}

const app = express();
app.disable("x-powered-by");

app.use(function(req, res, next) {
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // Before parsing/authentication so sensitive error responses are also uncached.
    const sensitiveApi = /^\/api\/(?:admin|internal)(?:\/|$)/i.test(req.path) ||
        /^\/api\/(?:login|logout)\/?$/i.test(req.path) ||
        /^\/api\/(?:movies\/[^/]+|series\/[^/]+\/episodes\/[^/]+)\/telegram\/?$/i.test(req.path);
    const adminMutation = ["POST", "PUT", "DELETE"].includes(req.method) &&
        /^\/api\/(?:movies(?:\/[^/]+)?|upload)\/?$/i.test(req.path);
    if (sensitiveApi || adminMutation) res.setHeader("Cache-Control", "no-store");
    next();
});

app.use(express.json());

if (isProduction) app.set("trust proxy", 1);

function requireSameOrigin(req, res, next) {
    const origin = req.get("Origin");
    if (origin === undefined) return next();
    try {
        // req.protocol respects the existing trusted proxy's HTTPS header.
        const expected = isProduction ? publicOrigin
            : new URL(`${req.protocol}://${req.get("Host")}`).origin;
        const supplied = new URL(origin);
        if (["http:", "https:"].includes(supplied.protocol) &&
            origin === supplied.origin && supplied.origin === expected) return next();
    } catch {
        // Malformed/null origins are rejected without exposing request values.
    }
    return res.status(403).json({ message: "Request origin rejected" });
}

let sessionStore;
try {
    const sessionDatabasePath = path.resolve(__dirname, process.env.SESSION_DATABASE_PATH || "sessions.db");
    const relativeTo = root => path.relative(path.resolve(root), sessionDatabasePath);
    for (const root of [uploadsDir, path.join(__dirname, "../frontend")]) {
        const relative = relativeTo(root);
        if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
            throw new Error();
        }
    }
    sessionStore = new SQLiteSessionStore({ filename: sessionDatabasePath, movieDatabasePath: databasePath });
} catch {
    console.error("Session store could not be initialized.");
    process.exit(1);
}

app.use(
    session({
        store: sessionStore,
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: isProduction,
            httpOnly: true,
            sameSite: "lax",
            maxAge: 8 * 60 * 60 * 1000
        }
    })
);

app.use(
    "/uploads",
    express.static(
        uploadsDir
    )
);

app.use(
    express.static(
        path.join(__dirname, "../frontend")
    )
);


// Database

const db = new Database(
    databasePath
);
const columns = db
    .prepare("PRAGMA table_info(movies)")
    .all();

const hasTelegramChatId = columns.some(function(column) {
    return column.name === "telegram_chat_id";
});

if (!hasTelegramChatId) {
    db.exec(`
        ALTER TABLE movies
        ADD COLUMN telegram_chat_id TEXT
    `);

    console.log("Telegram chat ID column added!");
}

const hasTelegramMessageId = columns.some(function(column) {
    return column.name === "telegram_message_id";
});

if (!hasTelegramMessageId) {
    db.exec(`
        ALTER TABLE movies
        ADD COLUMN telegram_message_id INTEGER
    `);

    console.log("Telegram message ID column added!");
}


// Image upload settings

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});

function posterExtension(buffer) {
    if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return ".jpg";
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
    if (buffer.length >= 16 && buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP" &&
        ["VP8 ", "VP8L", "VP8X"].includes(buffer.toString("ascii", 12, 16))) return ".webp";
    return null;
}

function receivePoster(req, res, next) {
    upload.single("poster")(req, res, error => {
        if (error) return res.status(400).json({ message: "Upload a JPEG, PNG or WebP poster no larger than 10 MB." });
        next();
    });
}


// Admin login

const loginFailures = new Map();
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const accountFailures = new Map();
const ACCOUNT_FAILURE_LIMIT = 5;
const ACCOUNT_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const loginCleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of loginFailures) {
        if (record.expiresAt <= now) loginFailures.delete(ip);
    }
}, 60 * 1000);
loginCleanup.unref();
const accountCleanup = setInterval(() => {

    const now = Date.now();

    for (const [ip, record] of accountFailures) {

        if (record.expiresAt <= now) {
            accountFailures.delete(ip);
        }

    }

}, 60 * 1000);

accountCleanup.unref();

app.post("/api/login", requireSameOrigin, async function(req, res) {
    const ip = req.ip;
    const now = Date.now();
    let failures = loginFailures.get(ip);
    if (failures && failures.expiresAt <= now) {
        loginFailures.delete(ip);
        failures = undefined;
    }
    if (failures && failures.count >= LOGIN_FAILURE_LIMIT) {
        return res.status(429).json({ message: "Too many login attempts. Please try again later." });
    }

    const {
        username,
        password
    } = req.body || {};

    let verified = false;
    let credentialVersion;
    if (typeof username === "string" && username.trim() !== "" &&
        typeof password === "string" && password.length > 0) {
        try {
            credentialVersion = adminAuth.getCredential().credential_version;
            verified = await adminAuth.verifyCredential(username, password);
            if (adminAuth.getCredential().credential_version !== credentialVersion) verified = false;
        } catch {
            return res.status(500).json({ message: "Login failed" });
        }
    }

    if (!verified) {
        // Scrypt yields; use the latest failure record instead of a stale pre-await snapshot.
        failures = loginFailures.get(ip);
        const failureTime = Date.now();
        if (failures && failures.expiresAt <= failureTime) failures = undefined;
        if (failures && failures.count >= LOGIN_FAILURE_LIMIT) {
            return res.status(429).json({ message: "Too many login attempts. Please try again later." });
        }
        if (!failures) {
            failures = { count: 0, expiresAt: failureTime + LOGIN_FAILURE_WINDOW_MS };
            loginFailures.set(ip, failures);
        }
        failures.count++;

        return res.status(401).json({
            message: "Invalid username or password"
        });

    }

    loginFailures.delete(ip);
    req.session.regenerate(function(err) {
        if (err) {
            return res.status(500).json({ message: "Login failed" });
        }
        try {
            if (adminAuth.getCredential().credential_version !== credentialVersion) {
                return res.status(401).json({ message: "Invalid username or password" });
            }
        } catch {
            return res.status(500).json({ message: "Login failed" });
        }
        req.session.isAdmin = true;
        req.session.credentialVersion = credentialVersion;
        res.json({
            message: "Login successful"
        });
    });

});


// Check admin login

function validAdminSession(req) {
    return req.session?.isAdmin === true &&
        Number.isSafeInteger(req.session.credentialVersion) && req.session.credentialVersion > 0 &&
        req.session.credentialVersion === adminAuth.getCredential().credential_version;
}

app.get("/api/admin/check", function(req, res) {

    if (!validAdminSession(req)) {

        return res.status(401).json({
            message: "Not logged in"
        });

    }

    res.json({
        message: "Admin authenticated"
    });

});
// Get current Admin account

app.get(
    "/api/admin/account",
    requireAdmin,
    function(req, res) {

        const credential =
            adminAuth.getCredential();

        res.setHeader(
            "Cache-Control",
            "no-store"
        );

        res.json({
            username:
                credential.username
        });

    }
);
app.put(
    "/api/admin/account",
    requireSameOrigin,
    requireAdmin,
    async function(req, res) {

        const ip = req.ip;
        const now = Date.now();

        let failures =
            accountFailures.get(ip);

        if (
            failures &&
            failures.expiresAt <= now
        ) {
            accountFailures.delete(ip);
            failures = undefined;
        }

        if (
            failures &&
            failures.count >= ACCOUNT_FAILURE_LIMIT
        ) {
            return res.status(429).json({
                message:
                    "Too many password attempts. Please try again later."
            });
        }


        const {
            currentPassword,
            newUsername,
            newPassword,
            confirmNewPassword
        } = req.body || {};


        if (
            typeof currentPassword !== "string" ||
            currentPassword.length === 0
        ) {
            return res.status(400).json({
                message:
                    "Current password is required"
            });
        }


        const wantsUsernameChange =
            newUsername !== undefined &&
            newUsername !== "";

        const wantsPasswordChange =
            newPassword !== undefined &&
            newPassword !== "";


        if (
            !wantsUsernameChange &&
            !wantsPasswordChange
        ) {
            return res.status(400).json({
                message:
                    "Enter a new username or password"
            });
        }


        if (
            wantsUsernameChange &&
            !validateNewUsername(newUsername)
        ) {
            return res.status(400).json({
                message:
                    "Invalid new username"
            });
        }


       if (wantsPasswordChange) {

    if (
        typeof newPassword !== "string" ||
        newPassword.length < 12
    ) {
        return res.status(400).json({
            message:
                "New password must be at least 12 characters"
        });
    }

    if (
        typeof confirmNewPassword !== "string" ||
        newPassword !== confirmNewPassword
    ) {
        return res.status(400).json({
            message:
                "New passwords do not match"
        });
    }

}


        try {

            const credential =
                adminAuth.getCredential();


            const currentPasswordValid =
                await adminAuth.verifyCredential(
                    credential.username,
                    currentPassword
                );


            if (!currentPasswordValid) {

                failures =
                    accountFailures.get(ip);

                const failureTime =
                    Date.now();


                if (
                    failures &&
                    failures.expiresAt <= failureTime
                ) {
                    failures = undefined;
                }


                if (
                    failures &&
                    failures.count >= ACCOUNT_FAILURE_LIMIT
                ) {
                    return res.status(429).json({
                        message:
                            "Too many password attempts. Please try again later."
                    });
                }


                if (!failures) {

                    failures = {
                        count: 0,
                        expiresAt:
                            failureTime +
                            ACCOUNT_FAILURE_WINDOW_MS
                    };

                    accountFailures.set(
                        ip,
                        failures
                    );

                }


                failures.count++;


                return res.status(401).json({
                    message:
                        "Current password is incorrect"
                });

            }


            accountFailures.delete(ip);


            await adminAuth.updateCredential({

                expectedVersion:
                    credential.credential_version,

                newUsername:
                    wantsUsernameChange
                        ? newUsername
                        : undefined,

                newPassword:
                    wantsPasswordChange
                        ? newPassword
                        : undefined

            });


            req.session.destroy(function(err) {

                if (err) {

                    return res.status(500).json({
                        message:
                            "Account updated, but logout failed"
                    });

                }


                res.clearCookie(
                    "connect.sid",
                    {
                        path: "/",
                        secure: isProduction,
                        httpOnly: true,
                        sameSite: "lax"
                    }
                );


                res.json({
                    message:
                        "Admin account updated. Please log in again."
                });

            });


        } catch (error) {

            if (error.code === "NO_CHANGE") {

                return res.status(400).json({
                    message:
                        "No account changes detected"
                });

            }


            if (error.code === "STALE_VERSION") {

                return res.status(409).json({
                    message:
                        "Admin account changed. Please log in again."
                });

            }


            return res.status(500).json({
                message:
                    "Admin account update failed"
            });

        }

    }
);

// Admin logout

app.post("/api/logout", requireSameOrigin, function(req, res) {

    req.session.destroy(function(err) {

        if (err) {

            return res.status(500).json({
                message: "Logout failed"
            });

        }

        res.clearCookie("connect.sid", {
            path: "/",
            secure: isProduction,
            httpOnly: true,
            sameSite: "lax"
        });
        res.json({
            message: "Logout successful"
        });

    });

});


// Protect admin routes

function requireAdmin(req, res, next) {

    if (!validAdminSession(req)) {

        return res.status(401).json({
            message: "Admin login required"
        });

    }

    next();

}


// GET movies with search, type, category, and pagination

function requireMappingRead(req, res, next) {
    const secret = process.env.MAPPING_API_SECRET;
    if (!secret) {
        return res.status(503).json({ message: "Mapping API is not configured" });
    }
    if (validAdminSession(req)) {
        res.set("Cache-Control", "no-store");
        return next();
    }
    const supplied = Buffer.from(req.get("Authorization") || "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return res.status(401).json({ message: "Mapping authentication required" });
    }
    res.set("Cache-Control", "no-store");
    next();
}

const PUBLIC_MOVIE_FIELDS = "id, poster, title, genres, year, review, fileSize, quality, duration, rating, type, episodes, categories, series_status";

app.get("/api/movies", function(req, res) {

    const parsePositiveInteger = (value, fallback) => {
        if (value === undefined) return fallback;
        if (typeof value !== "string" || !/^\d+$/.test(value)) return NaN;
        const number = Number(value);
        return Number.isSafeInteger(number) && number > 0 ? number : NaN;
    };
    const page = parsePositiveInteger(req.query.page, 1);
    const limit = parsePositiveInteger(req.query.limit, 20);
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(limit) || limit > 500) {
        return res.status(400).json({ message: "Invalid page or limit" });
    }
    for (const field of ["search", "type", "category"]) {
        if (req.query[field] !== undefined && typeof req.query[field] !== "string") {
            return res.status(400).json({ message: "Invalid search or filter" });
        }
    }
    const search = (req.query.search ?? "").trim();
    const type = (req.query.type ?? "").trim();
    const category = (req.query.category ?? "").trim();
    if (search.length > 150) {
        return res.status(400).json({ message: "Search must not exceed 150 characters" });
    }
    const offset = (page - 1) * limit;
    if (!Number.isSafeInteger(offset) || offset < 0) {
        return res.status(400).json({ message: "Invalid pagination offset" });
    }


    // Build filter conditions

    const conditions = [];

    const values = [];


    // Search

    if (search) {

        const searchText =
            "%" + search + "%";


        conditions.push(`
            (
                title LIKE ?
                OR genres LIKE ?
                OR categories LIKE ?
                OR CAST(year AS TEXT) LIKE ?
            )
        `);


        values.push(
            searchText,
            searchText,
            searchText,
            searchText
        );

    }


    // Movie / Series

    if (
        type === "movie" ||
        type === "series"
    ) {

        conditions.push(
            "type = ?"
        );


        values.push(
            type
        );

    }


    // Country / Category

    if (category) {

        conditions.push(
            "categories LIKE ?"
        );


        values.push(
            "%" + category + "%"
        );

    }


    // Create WHERE clause

    const whereClause =
        conditions.length > 0
            ? "WHERE " + conditions.join(" AND ")
            : "";


    // Get movies for this page

    const movies =
        db
            .prepare(`
                SELECT ${PUBLIC_MOVIE_FIELDS}
                FROM movies
                ${whereClause}
                ORDER BY id DESC
                LIMIT ? OFFSET ?
            `)
            .all(
                ...values,
                limit,
                offset
            );


    // Get total matching movies

    const total =
        db
            .prepare(`
                SELECT COUNT(*) AS count
                FROM movies
                ${whereClause}
            `)
            .get(
                ...values
            )
            .count;


    res.json({

        movies: movies,

        total: total

    });

});
// Admin movie list

app.get("/api/admin/movies", requireAdmin, function(req, res) {

    const movies = db
        .prepare("SELECT * FROM movies")
        .all();

    res.json(movies);

});


// GET one movie

app.get("/api/admin/movies/:id", requireAdmin, function(req, res) {
    res.set("Cache-Control", "no-store");
    const movieId = Number(req.params.id);
    if (!Number.isSafeInteger(movieId) || movieId <= 0) {
        return res.status(400).json({ message: "Invalid movie ID" });
    }
    const movie = db.prepare("SELECT * FROM movies WHERE id = ?").get(movieId);
    if (!movie) {
        return res.status(404).json({ message: "Movie not found" });
    }
    res.json(movie);
});

app.get("/api/movies/:id", function(req, res) {

    const movieId =
        Number(req.params.id);

    if (
        !Number.isInteger(movieId) ||
        movieId <= 0
    ) {

        return res.status(400).json({
            message: "Invalid movie ID"
        });

    }

    const movie = db
        .prepare(
            `SELECT ${PUBLIC_MOVIE_FIELDS} FROM movies WHERE id = ?`
        )
        .get(movieId);

    if (!movie) {

        return res.status(404).json({
            message: "Movie not found"
        });

    }

    res.json(movie);

});
// Get Telegram storage info

app.get("/api/movies/:id/telegram", requireMappingRead, function(req, res) {

    const movieId = Number(req.params.id);

    if (
        !Number.isInteger(movieId) ||
        movieId <= 0
    ) {

        return res.status(400).json({
            message: "Invalid movie ID"
        });

    }

    const movie = db
        .prepare(`
            SELECT
                id,
                title,
                telegram_chat_id,
                telegram_message_id
            FROM movies
            WHERE id = ?
        `)
        .get(movieId);

    if (!movie) {

        return res.status(404).json({
            message: "Movie not found"
        });

    }

    res.json(movie);

});

// List available series episodes

app.get("/api/series/:seriesId/episodes", function(req, res) {
    const seriesId = Number(req.params.seriesId);

    if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
        return res.status(400).json({
            message: "Invalid series ID"
        });
    }

    const series = db
        .prepare("SELECT id FROM movies WHERE id = ? AND type = ?")
        .get(seriesId, "series");

    if (!series) {
        return res.status(404).json({
            message: "Series not found"
        });
    }

    const episodes = db
        .prepare(`
            SELECT id, series_id, episode_number
            FROM series_episodes
            WHERE series_id = ?
            ORDER BY episode_number ASC
        `)
        .all(seriesId);

    res.json(episodes);
});

// Get Telegram storage info for one series episode

app.get("/api/series/:seriesId/episodes/:episodeNumber/telegram", requireMappingRead, function(req, res) {
    const seriesId = Number(req.params.seriesId);
    const episodeNumber = Number(req.params.episodeNumber);

    if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
        return res.status(400).json({
            message: "Invalid series ID"
        });
    }

    if (!Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) {
        return res.status(400).json({
            message: "Invalid episode number"
        });
    }

    const series = db
        .prepare("SELECT id FROM movies WHERE id = ? AND type = ?")
        .get(seriesId, "series");

    if (!series) {
        return res.status(404).json({
            message: "Series not found"
        });
    }

    const episode = db
        .prepare(`
            SELECT telegram_chat_id, telegram_message_id
            FROM series_episodes
            WHERE series_id = ? AND episode_number = ?
        `)
        .get(seriesId, episodeNumber);

    if (!episode) {
        return res.status(404).json({
            message: "Episode not found"
        });
    }

    res.json(episode);
});

// Add movie or series
// Protected: admin only

app.post(
    "/api/movies",
    requireSameOrigin,
    requireAdmin,
    function(req, res) {

        const {
            poster,
            title,
            genres,
            year,
            link,
            review,
            fileSize,
            quality,
            duration,
            rating,
            type,
            episodes,
            categories
        } = req.body;


        if (
            !title ||
            title.trim() === ""
        ) {

            return res.status(400).json({
                message: "Title is required"
            });

        }


        if (
            !poster ||
            poster.trim() === ""
        ) {

            return res.status(400).json({
                message: "Poster is required"
            });

        }


        const requestedStatus = req.body.series_status;
        if (requestedStatus !== undefined && requestedStatus !== "ongoing" && requestedStatus !== "completed") {
            return res.status(400).json({ message: "Invalid series status" });
        }
        const seriesStatus = type === "series" ? requestedStatus ?? null : null;

        const addMovie = db.prepare(`
            INSERT INTO movies (
                poster,
                title,
                genres,
                year,
                link,
                review,
                fileSize,
                quality,
                duration,
                rating,
                type,
                episodes,
                categories,
                series_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);


        const result = addMovie.run(
            poster,
            title,
            genres,
            year,
            link,
            review,
            fileSize,
            quality,
            duration,
            rating,
            type,
            episodes,
            categories,
            seriesStatus
        );


        const newMovie = db
            .prepare(
                "SELECT * FROM movies WHERE id = ?"
            )
            .get(result.lastInsertRowid);


        res.status(201).json(newMovie);

    }
);

// Upload poster
// Protected: admin only

app.post(
    "/api/upload",
    requireSameOrigin,
    requireAdmin,
    receivePoster,
    async function(req, res) {

        if (!req.file) {

            return res.status(400).json({
                message: "No image uploaded"
            });

        }

        const extension = posterExtension(req.file.buffer);
        if (!extension) {
            return res.status(400).json({ message: "Upload a valid JPEG, PNG or WebP poster." });
        }
        const filename = randomUUID() + extension;
        const destination = path.join(uploadsDir, filename);
        try {
            await fs.promises.writeFile(destination, req.file.buffer, { flag: "wx" });
        } catch (error) {
            if (error.code !== "EEXIST") {
                await fs.promises.unlink(destination).catch(() => {});
            }
            return res.status(500).json({ message: "Poster could not be saved." });
        }

        res.json({

            message:
                "Image uploaded successfully",

            posterUrl:
                "/uploads/" +
                filename

        });

    }
);


// Automatic mapping uses a dedicated secret, independently of Admin sessions.
function requireAutomaticMapping(req, res, next) {
    const secret = process.env.MAPPING_API_SECRET;
    const storageGroupId = process.env.STORAGE_GROUP_ID;
    if (!secret || !storageGroupId) {
        return res.status(503).json({ message: "Automatic mapping is not configured" });
    }
    const supplied = Buffer.from(req.get("Authorization") || "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return res.status(401).json({ message: "Mapping authentication required" });
    }
    const { telegram_chat_id: chatId, telegram_message_id: messageId } = req.body || {};
    if (typeof chatId !== "string" || chatId !== storageGroupId) {
        return res.status(403).json({ message: "Storage group rejected" });
    }
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        return res.status(400).json({ message: "Invalid Telegram message ID" });
    }
    next();
}

app.put("/api/internal/movies/:id/telegram", requireAutomaticMapping, function(req, res) {
    const movieId = Number(req.params.id);
    if (!Number.isSafeInteger(movieId) || movieId <= 0) {
        return res.status(400).json({ message: "Invalid movie ID" });
    }
    const movie = db.prepare("SELECT id, type FROM movies WHERE id = ?").get(movieId);
    if (!movie) {
        return res.status(404).json({ message: "Movie not found" });
    }
    if (movie.type !== "movie") {
        return res.status(400).json({ message: "Mapping requires a movie" });
    }
    db.prepare(`
        UPDATE movies SET telegram_chat_id = ?, telegram_message_id = ? WHERE id = ?
    `).run(req.body.telegram_chat_id, req.body.telegram_message_id, movieId);
    res.json({ message: "Movie mapped" });
});

app.put("/api/internal/series/:seriesId/episodes/:episodeNumber/telegram", requireAutomaticMapping, function(req, res) {
    const seriesId = Number(req.params.seriesId);
    const episodeNumber = Number(req.params.episodeNumber);
    if (!Number.isSafeInteger(seriesId) || seriesId <= 0 ||
        !Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) {
        return res.status(400).json({ message: "Invalid series ID or episode number" });
    }
    const series = db.prepare("SELECT id, type FROM movies WHERE id = ?").get(seriesId);
    if (!series) {
        return res.status(404).json({ message: "Series not found" });
    }
    if (series.type !== "series") {
        return res.status(400).json({ message: "Mapping requires a series" });
    }
    db.prepare(`
        INSERT INTO series_episodes (series_id, episode_number, telegram_chat_id, telegram_message_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (series_id, episode_number) DO UPDATE SET
            telegram_chat_id = excluded.telegram_chat_id,
            telegram_message_id = excluded.telegram_message_id
    `).run(seriesId, episodeNumber, req.body.telegram_chat_id, req.body.telegram_message_id);
    res.json({ message: "Episode mapped" });
});

// Validate the parent and episode number for admin episode mutations

function requireSeriesEpisode(req, res, next) {
    const seriesId = Number(req.params.seriesId);
    const episodeNumber = Number(req.params.episodeNumber);

    if (!Number.isSafeInteger(seriesId) || seriesId <= 0 ||
        !Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) {
        return res.status(400).json({ message: "Invalid series ID or episode number" });
    }

    const series = db.prepare("SELECT id, type FROM movies WHERE id = ?").get(seriesId);
    if (!series) {
        return res.status(404).json({ message: "Series not found" });
    }
    if (series.type !== "series") {
        return res.status(400).json({ message: "Episode management requires a series" });
    }

    res.locals.seriesId = seriesId;
    res.locals.episodeNumber = episodeNumber;
    next();
}

app.put("/api/admin/series/:seriesId/episodes/:episodeNumber", requireSameOrigin, requireAdmin, requireSeriesEpisode, function(req, res) {
    const { telegram_chat_id: chatId, telegram_message_id: messageId } = req.body || {};
    if (typeof chatId !== "string" || chatId.trim() === "") {
        return res.status(400).json({ message: "Telegram chat ID must be nonempty text" });
    }
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        return res.status(400).json({ message: "Telegram message ID must be a positive integer" });
    }

    db.prepare(`
        INSERT INTO series_episodes (series_id, episode_number, telegram_chat_id, telegram_message_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (series_id, episode_number) DO UPDATE SET
            telegram_chat_id = excluded.telegram_chat_id,
            telegram_message_id = excluded.telegram_message_id
    `).run(res.locals.seriesId, res.locals.episodeNumber, chatId.trim(), messageId);

    res.json({ message: "Episode mapping saved" });
});

app.delete("/api/admin/series/:seriesId/episodes/:episodeNumber", requireSameOrigin, requireAdmin, requireSeriesEpisode, function(req, res) {
    const result = db.prepare(`
        DELETE FROM series_episodes WHERE series_id = ? AND episode_number = ?
    `).run(res.locals.seriesId, res.locals.episodeNumber);

    if (result.changes === 0) {
        return res.status(404).json({ message: "Episode not found" });
    }
    res.json({ message: "Episode mapping deleted" });
});

// Update movie Telegram mapping independently of metadata

app.put("/api/admin/movies/:id/telegram", requireSameOrigin, requireAdmin, function(req, res) {
    const movieId = Number(req.params.id);
    const { telegram_chat_id: chatId, telegram_message_id: messageId } = req.body || {};

    if (!Number.isSafeInteger(movieId) || movieId <= 0) {
        return res.status(400).json({ message: "Invalid movie ID" });
    }

    const movie = db.prepare("SELECT id, type FROM movies WHERE id = ?").get(movieId);

    if (!movie) {
        return res.status(404).json({ message: "Movie not found" });
    }

    if (movie.type !== "movie") {
        return res.status(400).json({ message: "Telegram mapping requires a movie" });
    }

    if (typeof chatId !== "string" || chatId.trim() === "") {
        return res.status(400).json({ message: "Telegram chat ID must be nonempty text" });
    }

    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        return res.status(400).json({ message: "Telegram message ID must be a positive integer" });
    }

    db.prepare(`
        UPDATE movies
        SET telegram_chat_id = ?, telegram_message_id = ?
        WHERE id = ?
    `).run(chatId.trim(), messageId, movieId);

    res.json({ message: "Telegram mapping saved" });
});

// Edit movie or series
// Protected: admin only

app.put(
    "/api/movies/:id",
    requireSameOrigin,
    requireAdmin,
    function(req, res) {

        const {
            poster,
            title,
            genres,
            year,
            link,
            review,
            fileSize,
            quality,
            duration,
            rating,
            type,
            episodes,
            categories
        } = req.body;


        const oldMovie =
            db
                .prepare(
                    "SELECT * FROM movies WHERE id = ?"
                )
                .get(req.params.id);


        const requestedStatus = req.body.series_status;
        if (requestedStatus !== undefined && requestedStatus !== "ongoing" && requestedStatus !== "completed") {
            return res.status(400).json({ message: "Invalid series status" });
        }
        const seriesStatus = type === "series"
            ? requestedStatus ?? oldMovie?.series_status ?? null
            : null;

        const updateMovie = db.prepare(`
            UPDATE movies
            SET
                poster = ?,
                title = ?,
                genres = ?,
                year = ?,
                link = ?,
                review = ?,
                fileSize = ?,
                quality = ?,
                duration = ?,
                rating = ?,
                type = ?,
                episodes = ?,
                categories = ?,
                series_status = ?
            WHERE id = ?
        `);


        const result =
            updateMovie.run(
                poster,
                title,
                genres,
                year,
                link,
                review,
                fileSize,
                quality,
                duration,
                rating,
                type,
                episodes,
                categories,
                seriesStatus,
                req.params.id
            );


        if (result.changes === 0) {

            return res.status(404).json({
                message: "Movie not found"
            });

        }


        // Delete old uploaded poster

        if (
            oldMovie &&
            typeof oldMovie.poster === "string" &&
            oldMovie.poster.startsWith(
                "/uploads/"
            ) &&
            oldMovie.poster !== poster
        ) {

            const filename = oldMovie.poster.slice("/uploads/".length);
            // Only direct image filenames; reject encoded paths, separators and hidden files.
            if (/^[^./\\%:\x00-\x1f\x7f][^/\\%:\x00-\x1f\x7f]*\.(?:jpe?g|png|webp)$/i.test(filename)) {
                const oldPosterPath = path.resolve(uploadsDir, filename);
                if (path.dirname(oldPosterPath) === path.resolve(uploadsDir) &&
                    fs.existsSync(oldPosterPath)) {
                    const info = fs.lstatSync(oldPosterPath);
                    if (info.isFile() && !info.isSymbolicLink() &&
                        path.dirname(fs.realpathSync(oldPosterPath)) === fs.realpathSync(uploadsDir)) {
                        fs.unlinkSync(oldPosterPath);
                    }
                }
            }

        }


        const updatedMovie =
            db
                .prepare(
                    "SELECT * FROM movies WHERE id = ?"
                )
                .get(req.params.id);


        res.json(updatedMovie);

    }
);


// Delete movie
// Protected: admin only

app.delete(
    "/api/movies/:id",
    requireSameOrigin,
    requireAdmin,
    function(req, res) {

        const deleteMovie = db.prepare(`
            DELETE FROM movies
            WHERE id = ?
        `);


        const result =
            deleteMovie.run(
                req.params.id
            );


        if (result.changes === 0) {

            return res.status(404).json({
                message: "Movie not found"
            });

        }


        res.json({
            message:
                "Movie deleted successfully"
        });

    }
);


// Final fallback: never expose unexpected error details in responses or logs.
app.use(function(err, req, res, next) {
    if (res.headersSent) {
        console.error("Request failed after response started.");
        res.destroy();
        return;
    }
    // Preserve known body-parser client errors without echoing their messages/body.
    const status = err?.type === "entity.parse.failed" && err.status === 400 ? 400
        : err?.type === "entity.too.large" && err.status === 413 ? 413
        : 500;
    console.error("Request failed. HTTP status:", status);
    res.status(status).json({
        message: status === 400 ? "Invalid request body"
            : status === 413 ? "Request body too large"
            : "Internal server error"
    });
});

const PORT =
    process.env.PORT || 3000;


const server = app.listen(
    PORT,
    "127.0.0.1",
    function() {

        console.log(
            `Server is running on port ${PORT}`
        );

    }
);

function shutdown() {
    server.close(() => {
        sessionStore.close(error => {
            if (error) console.error("Session store shutdown failed.");
            let authCloseFailed = false;
            try { adminAuth.close(); } catch {
                authCloseFailed = true;
                console.error("Admin credential store shutdown failed.");
            }
            process.exit(error || authCloseFailed ? 1 : 0);
        });
    });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
