import "dotenv/config";
import express from "express";
import session from "express-session";
import Database from "better-sqlite3";
import path from "path";
import multer from "multer";
import fs from "fs";
import { fileURLToPath } from "url";
import { timingSafeEqual } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const databasePath = path.resolve(__dirname, process.env.DATABASE_PATH || "movies.db");
const uploadsDir = path.resolve(__dirname, process.env.UPLOADS_DIR || "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
const isProduction = process.env.NODE_ENV === "production";

const app = express();

app.use(express.json());

if (isProduction) app.set("trust proxy", 1);

app.use(
    session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: isProduction,
            httpOnly: true,
            sameSite: "lax"
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

const storage = multer.diskStorage({

    destination: function(req, file, cb) {

        cb(
            null,
            uploadsDir
        );

    },

    filename: function(req, file, cb) {

        cb(
            null,
            Date.now() + "-" + file.originalname
        );

    }

});

const upload = multer({
    storage: storage
});


// Admin login

app.post("/api/login", function(req, res) {

    const {
        username,
        password
    } = req.body;

    if (
        username !== process.env.ADMIN_USERNAME ||
        password !== process.env.ADMIN_PASSWORD
    ) {

        return res.status(401).json({
            message: "Invalid username or password"
        });

    }

    req.session.isAdmin = true;

    res.json({
        message: "Login successful"
    });

});


// Check admin login

app.get("/api/admin/check", function(req, res) {

    if (!req.session.isAdmin) {

        return res.status(401).json({
            message: "Not logged in"
        });

    }

    res.json({
        message: "Admin authenticated"
    });

});


// Admin logout

app.post("/api/logout", function(req, res) {

    req.session.destroy(function(err) {

        if (err) {

            return res.status(500).json({
                message: "Logout failed"
            });

        }

        res.json({
            message: "Logout successful"
        });

    });

});


// Protect admin routes

function requireAdmin(req, res, next) {

    if (!req.session.isAdmin) {

        return res.status(401).json({
            message: "Admin login required"
        });

    }

    next();

}


// GET movies with search, type, category, and pagination

app.get("/api/movies", function(req, res) {

    const page =
        Number(req.query.page) || 1;

    const limit =
        Number(req.query.limit) || 20;

    const search =
        (req.query.search || "").trim();

    const type =
        (req.query.type || "").trim();

    const category =
        (req.query.category || "").trim();


    const offset =
        (page - 1) * limit;


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
                SELECT *
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
            "SELECT * FROM movies WHERE id = ?"
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

app.get("/api/movies/:id/telegram", function(req, res) {

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

app.get("/api/series/:seriesId/episodes/:episodeNumber/telegram", function(req, res) {
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
    requireAdmin,
    upload.single("poster"),
    function(req, res) {

        if (!req.file) {

            return res.status(400).json({
                message: "No image uploaded"
            });

        }

        res.json({

            message:
                "Image uploaded successfully",

            posterUrl:
                "/uploads/" +
                req.file.filename

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

app.put("/api/admin/series/:seriesId/episodes/:episodeNumber", requireAdmin, requireSeriesEpisode, function(req, res) {
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

app.delete("/api/admin/series/:seriesId/episodes/:episodeNumber", requireAdmin, requireSeriesEpisode, function(req, res) {
    const result = db.prepare(`
        DELETE FROM series_episodes WHERE series_id = ? AND episode_number = ?
    `).run(res.locals.seriesId, res.locals.episodeNumber);

    if (result.changes === 0) {
        return res.status(404).json({ message: "Episode not found" });
    }
    res.json({ message: "Episode mapping deleted" });
});

// Update movie Telegram mapping independently of metadata

app.put("/api/admin/movies/:id/telegram", requireAdmin, function(req, res) {
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
            oldMovie.poster &&
            oldMovie.poster.startsWith(
                "/uploads/"
            ) &&
            oldMovie.poster !== poster
        ) {

            const oldPosterPath =
                path.join(
                    uploadsDir,
                    oldMovie.poster.replace(
                        "/uploads/",
                        ""
                    )
                );


            if (
                fs.existsSync(oldPosterPath)
            ) {

                fs.unlinkSync(
                    oldPosterPath
                );

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


const PORT =
    process.env.PORT || 3000;


app.listen(
    PORT,
    function() {

        console.log(
            `Server is running on port ${PORT}`
        );

    }
);
