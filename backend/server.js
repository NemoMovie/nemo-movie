import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import path from "path";
import multer from "multer";
import fs from "fs";

const app = express();

app.use(express.json());
app.use(cors());
app.use(
    "/uploads",
    express.static(path.join(process.cwd(), "uploads"))
);
// Image upload settings

const storage = multer.diskStorage({

    destination: function(req, file, cb) {

        cb(null, "uploads/");

    },

    filename: function(req, file, cb) {

        cb(null, Date.now() + "-" + file.originalname);

    }

});

const upload = multer({
    storage: storage
});
const db = new Database("movies.db");

// GET all movies
app.get("/api/movies", function(req, res) {

    const movies = db
        .prepare("SELECT * FROM movies")
        .all();

    res.json(movies);

});

// GET one movie
app.get("/api/movies/:id", function(req, res) {

    const movieId = Number(req.params.id);

    if (!Number.isInteger(movieId) || movieId <= 0) {

        return res.status(400).json({
            message: "Invalid movie ID"
        });

    }

    const movie = db
        .prepare("SELECT * FROM movies WHERE id = ?")
        .get(movieId);

    if (!movie) {

        return res.status(404).json({
            message: "Movie not found"
        });

    }

    res.json(movie);

});

// POST movie or series
app.post("/api/movies", function(req, res) {

    const {
        poster,
        title,
        category,
        year,
        link,
        review,
        fileSize,
        quality,
        duration,
        rating,
        type,
        episodes
    } = req.body;
    if (!title || title.trim() === "") {

    return res.status(400).json({
        message: "Title is required"
    });

}
if (!poster || poster.trim() === "") {

    return res.status(400).json({
        message: "Poster is required"
    });

}

    const addMovie = db.prepare(`
        INSERT INTO movies (
            poster,
            title,
            category,
            year,
            link,
            review,
            fileSize,
            quality,
            duration,
            rating,
            type,
            episodes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = addMovie.run(
        poster,
        title,
        category,
        year,
        link,
        review,
        fileSize,
        quality,
        duration,
        rating,
        type,
        episodes
    );

    const newMovie = db
        .prepare("SELECT * FROM movies WHERE id = ?")
        .get(result.lastInsertRowid);

    res.status(201).json(newMovie);

});
// Upload poster image

app.post("/api/upload", upload.single("poster"), function(req, res) {

    if (!req.file) {

        return res.status(400).json({
            message: "No image uploaded"
        });

    }

    res.json({

        message: "Image uploaded successfully",

        posterUrl: "/uploads/" + req.file.filename

    });

});
// PUT movie or series
app.put("/api/movies/:id", function(req, res) {

    const {
        poster,
        title,
        category,
        year,
        link,
        review,
        fileSize,
        quality,
        duration,
        rating,
        type,
        episodes
    } = req.body;
    const oldMovie =
    db
        .prepare("SELECT * FROM movies WHERE id = ?")
        .get(req.params.id);

    const updateMovie = db.prepare(`
        UPDATE movies
        SET
            poster = ?,
            title = ?,
            category = ?,
            year = ?,
            link = ?,
            review = ?,
            fileSize = ?,
            quality = ?,
            duration = ?,
            rating = ?,
            type = ?,
            episodes = ?
        WHERE id = ?
    `);

    const result = updateMovie.run(
        poster,
        title,
        category,
        year,
        link,
        review,
        fileSize,
        quality,
        duration,
        rating,
        type,
        episodes,
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
    oldMovie.poster.startsWith("/uploads/") &&
    oldMovie.poster !== poster
) {

   const oldPosterPath =
    path.join(
        process.cwd(),
        "uploads",
        oldMovie.poster.replace("/uploads/", "")
    );

    if (fs.existsSync(oldPosterPath)) {

        fs.unlinkSync(oldPosterPath);

    }

}

    const updatedMovie = db
        .prepare("SELECT * FROM movies WHERE id = ?")
        .get(req.params.id);

    res.json(updatedMovie);

});

// DELETE movie
app.delete("/api/movies/:id", function(req, res) {

    const deleteMovie = db.prepare(`
        DELETE FROM movies
        WHERE id = ?
    `);

    const result = deleteMovie.run(req.params.id);

    if (result.changes === 0) {
        return res.status(404).json({
            message: "Movie not found"
        });
    }

    res.json({
        message: "Movie deleted successfully"
    });

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, function() {
    console.log(`Server is running on port ${PORT}`);
});