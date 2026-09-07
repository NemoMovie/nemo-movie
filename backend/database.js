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

const hasSeriesStatus = columns.some(function(column) {
    return column.name === "series_status";
});

if (!hasSeriesStatus) {
    db.exec(`
        ALTER TABLE movies
        ADD COLUMN series_status TEXT
        CHECK (series_status IN ('ongoing', 'completed'))
    `);
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

db.exec(`
    CREATE TABLE IF NOT EXISTS series_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        series_id INTEGER NOT NULL REFERENCES movies(id),
        episode_number INTEGER NOT NULL CHECK (episode_number > 0),
        telegram_chat_id TEXT NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        UNIQUE (series_id, episode_number)
    );
`);

console.log("Movies database ready!");