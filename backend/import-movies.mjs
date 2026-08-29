import Database from "better-sqlite3";
import { movies } from "./movies-data.mjs";

const db = new Database("movies.db");

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
        rating
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const movie of movies) {

    addMovie.run(
        movie.poster,
        movie.title,
        movie.category,
        movie.year,
        movie.link,
        movie.review,
        movie.fileSize,
        movie.quality,
        movie.duration,
        movie.rating
    );

}

console.log("Movies imported successfully!");