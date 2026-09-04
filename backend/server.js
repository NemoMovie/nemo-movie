import "dotenv/config";
import express from "express";
import cors from "cors";
import session from "express-session";
import Database from "better-sqlite3";
import path from "path";
import multer from "multer";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());

app.use(
    cors({
        origin: "http://127.0.0.1:5500",
        credentials: true
    })
);

app.use(
    session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false
    })
);

app.use(
    "/uploads",
    express.static(
        path.join(__dirname, "uploads")
    )
);

app.use(
    express.static(
        path.join(__dirname, "../frontend")
    )
);


// Database

const db = new Database(
    path.join(__dirname, "movies.db")
);


// Image upload settings

const storage = multer.diskStorage({

    destination: function(req, file, cb) {

        cb(
            null,
            path.join(__dirname, "uploads")
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
                categories
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            categories
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
                categories = ?
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
                    __dirname,
                    "uploads",
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