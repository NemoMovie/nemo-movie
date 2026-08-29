import Database from "better-sqlite3";

const db = new Database("movies.db");

const columns = db
    .prepare("PRAGMA table_info(movies)")
    .all();

const hasType = columns.some(function(column) {
    return column.name === "type";
});

if (!hasType) {
    db.exec(`
        ALTER TABLE movies
        ADD COLUMN type TEXT DEFAULT 'movie'
    `);

    console.log("Type column added!");
}

const hasEpisodes = columns.some(function(column) {
    return column.name === "episodes";
});

if (!hasEpisodes) {
    db.exec(`
        ALTER TABLE movies
        ADD COLUMN episodes INTEGER
    `);

    console.log("Episodes column added!");
}

console.log("Movies database ready!");