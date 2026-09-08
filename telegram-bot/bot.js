require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;
const storageGroupId = process.env.STORAGE_GROUP_ID;
const mappingApiSecret = process.env.MAPPING_API_SECRET;
const mappingBackendUrl = (process.env.BACKEND_URL || "http://localhost:3000").replace(/\/+$/, "");
// Invalid entries are ignored; an empty/missing list authorizes nobody.
const authorizedTelegramUserIds = new Set(
    (process.env.AUTHORIZED_TELEGRAM_USER_IDS || "").split(",")
        .map(value => value.trim())
        .filter(positiveId)
        .map(value => String(Number(value)))
);

const bot = new TelegramBot(token, {
    polling: true
});

// Search/details never deliver media; only explicit delivery callbacks do.
const TELEGRAM_MAX_RETRIES = 3;
const TELEGRAM_RETRY_MARGIN_MS = 250;
let telegramPauseUntil = 0;

function isTelegramRateLimit(error) {
    return error?.response?.statusCode === 429 || error?.response?.body?.error_code === 429;
}

async function telegramSend(method, ...args) {
    for (let attempt = 0; ; attempt++) {
        // Recheck after waking: another request may have extended the pause.
        while (telegramPauseUntil > Date.now()) {
            await new Promise(resolve => setTimeout(resolve, telegramPauseUntil - Date.now()));
        }
        try {
            return await bot[method](...args);
        } catch (error) {
            if (!isTelegramRateLimit(error)) throw error;
            const seconds = error.response?.body?.parameters?.retry_after;
            const validDelay = typeof seconds === "number" && Number.isFinite(seconds) &&
                seconds > 0 && seconds <= 3600;
            // Malformed delays get a conservative pause, but no automatic retry.
            const delay = validDelay ? Math.ceil(seconds * 1000) : 1000;
            telegramPauseUntil = Math.max(telegramPauseUntil,
                Date.now() + delay + TELEGRAM_RETRY_MARGIN_MS);
            if (!validDelay || attempt >= TELEGRAM_MAX_RETRIES) throw error;
        }
    }
}

function positiveId(value) {
    return /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

async function searchFeedback(chatId, text, options) {
    try {
        await telegramSend("sendMessage", chatId, text, options);
    } catch {
        console.error("Search/detail feedback could not be sent.");
    }
}

async function readBackend(path) {
    const response = await fetch(mappingBackendUrl + path, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
        const error = new Error("Backend request failed.");
        error.status = response.status;
        throw error;
    }
    return response.json();
}

function validTitle(movie) {
    return movie && positiveId(movie.id) && typeof movie.title === "string" &&
        movie.title.trim() && ["movie", "series"].includes(movie.type);
}

function catalogueRows(data) {
    if (!data || !Array.isArray(data.movies) || !data.movies.every(validTitle)) {
        throw new Error("Invalid catalogue response.");
    }
    return data.movies;
}

function normalizeTitle(text) {
    return text.toLowerCase().trim().replace(/\s+/g, " ");
}

function titleSimilarity(first, second) {
    const a = normalizeTitle(first).slice(0, 150);
    const b = normalizeTitle(second).slice(0, 150);
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) {
            row[j] = Math.min(row[j - 1] + 1, previous[j] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previous = row;
    }
    return 1 - previous[b.length] / Math.max(a.length, b.length, 1);
}

function resultKeyboard(movies) {
    return movies.map(movie => [{
        text: `${movie.title.slice(0, 90)}${movie.year ? ` (${movie.year})` : ""} · ${movie.type === "series" ? "Series" : "Movie"}`,
        callback_data: `detail_${movie.id}`
    }]);
}

bot.on("message", async function(msg) {
    if (msg.chat.type === "private" && typeof msg.text !== "string") {
        await searchFeedback(msg.chat.id,
            "Please type a movie or series title to search. Photos, videos, and files are not accepted here.");
        return;
    }
    if (msg.chat.type !== "private" || typeof msg.text !== "string" ||
        msg.caption || msg.video || msg.document || msg.photo ||
        msg.text.trim().startsWith("/") ||
        (msg.entities || []).some(entity => entity.type === "bot_command")) return;
    const query = msg.text.trim();
    if (!query) return;
    if (query.length > 150) {
        await searchFeedback(msg.chat.id, "Please enter a shorter movie or series title.");
        return;
    }
    try {
        let results;
        if (query.length <= 3) {
            results = [];
            const exactTitle = query.toLowerCase();
            // Scan pages so partial matches cannot crowd out an exact title.
            for (let page = 1; ; page++) {
                const data = await readBackend(`/api/movies?page=${page}&limit=100`);
                const rows = catalogueRows(data);
                results.push(...rows.filter(movie => movie.title.trim().toLowerCase() === exactTitle));
                if (results.length >= 5 || rows.length < 100 || page * 100 >= data.total) break;
            }
            results = results.slice(0, 5);
        } else {
            results = catalogueRows(await readBackend(`/api/movies?search=${encodeURIComponent(query)}&page=1&limit=5`)).slice(0, 5);
        }
        let heading = "Choose a movie or series:";
        if (!results.length && query.length >= 4) {
            const candidates = catalogueRows(await readBackend("/api/movies?page=1&limit=500")).slice(0, 500);
            results = candidates.map(movie => ({ movie, score: titleSimilarity(query, movie.title) }))
                .filter(item => item.score >= 0.75)
                .sort((a, b) => b.score - a.score).slice(0, 3).map(item => item.movie);
            heading = "No exact match found.\n\nDid you mean:";
        }
        await searchFeedback(msg.chat.id, results.length ? heading : "No movie or series found.",
            results.length ? { reply_markup: { inline_keyboard: resultKeyboard(results) } } : undefined);
    } catch {
        console.error("Title search failed.");
        await searchFeedback(msg.chat.id, "Could not search right now. Please try again.");
    }
});

function detailPosterUrl(poster) {
    if (typeof poster !== "string" || !poster.trim()) return null;
    try {
        const url = new URL(poster.trim(), mappingBackendUrl + "/");
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
        return url.href;
    } catch {
        return null;
    }
}

async function sendDetail(chatId, poster, text, keyboard) {
    const options = { reply_markup: { inline_keyboard: keyboard } };
    const url = detailPosterUrl(poster);
    if (url) {
        try {
            if (text.length <= 1024) {
                await telegramSend("sendPhoto", chatId, url, { ...options, caption: text });
                return;
            }
            await telegramSend("sendPhoto", chatId, url);
        } catch (error) {
            // Do not log URLs or Telegram error objects, which may contain credentials.
            if (isTelegramRateLimit(error)) throw error;
            console.error("Detail poster could not be sent; using text details.");
        }
    }
    // Preserve the full review, including emoji, without exceeding message limits.
    let remaining = text;
    while (remaining.length) {
        let end = Math.min(4000, remaining.length);
        if (end < remaining.length) {
            const newline = remaining.lastIndexOf("\n", end - 1);
            if (newline >= end / 2) end = newline + 1;
            const last = remaining.charCodeAt(end - 1);
            if (last >= 0xD800 && last <= 0xDBFF) end--;
        }
        await telegramSend("sendMessage", chatId, remaining.slice(0, end),
            end === remaining.length ? options : undefined);
        remaining = remaining.slice(end);
    }
}

async function showDetail(chatId, id, page = 1, showWatchButton = true) {
    const movie = await readBackend(`/api/movies/${id}`);
    if (!validTitle(movie) || Number(movie.id) !== Number(id)) throw new Error("Invalid detail response.");
    const lines = [movie.title.slice(0, 250)];
    const add = (label, value) => {
        if (value !== null && value !== undefined && String(value).trim() !== "") {
            lines.push(`${label}: ${String(value).slice(0, 200)}`);
        }
    };
    add("Year", movie.year);
    add("Type", movie.type === "series" ? "Series" : "Movie");
    add("Genres", movie.genres);
    add("Rating", movie.rating);
    add("Quality", movie.quality);
    let keyboard;
    if (movie.type === "movie") {
        add("Duration", movie.duration);
        keyboard = showWatchButton ? [[{ text: "Watch Movie", callback_data: `watch_movie_${id}` }]] : [];
    } else {
        add("Status", movie.series_status === "ongoing" ? "Ongoing" : movie.series_status === "completed" ? "Completed" : "Status not set");
        add("Planned episodes", positiveId(movie.episodes) ? movie.episodes : "Not set");
        const episodes = await readBackend(`/api/series/${id}/episodes`);
        if (!Array.isArray(episodes) || !episodes.every(ep => ep && positiveId(ep.episode_number))) {
            throw new Error("Invalid episode response.");
        }
        const numbers = [...new Set(episodes.map(ep => Number(ep.episode_number)))].sort((a, b) => a - b);
        add("Available episodes", numbers.length);
        const pages = Math.max(1, Math.ceil(numbers.length / 20));
        page = Math.min(page, pages);
        keyboard = [];
        const visible = numbers.slice((page - 1) * 20, page * 20);
        for (let i = 0; i < visible.length; i += 2) {
            keyboard.push(visible.slice(i, i + 2).map(number => ({
                text: `Ep ${number}`, callback_data: `watch_series_${id}_ep_${number}`
            })));
        }
        const navigation = [];
        if (page > 1) navigation.push({ text: "Previous", callback_data: `episodes_${id}_page_${page - 1}` });
        if (page < pages) navigation.push({ text: "Next", callback_data: `episodes_${id}_page_${page + 1}` });
        if (navigation.length) keyboard.push(navigation);
        if (pages > 1) lines.push(`Episode page ${page} / ${pages}`);
        if (!numbers.length) lines.push("Episodes not available yet.");
    }
    if (typeof movie.review === "string" && movie.review.trim()) {
        lines.push("", movie.review);
    }
    await sendDetail(chatId, movie.poster, lines.join("\n"), keyboard);
}

bot.on("callback_query", async function(query) {
    try {
        await bot.answerCallbackQuery(query.id);
    } catch {
        console.error("Callback acknowledgement failed.");
    }
    const chat = query.message && query.message.chat;
    if (!chat || chat.type !== "private" || String(chat.id) !== String(query.from.id)) return;
    const data = typeof query.data === "string" ? query.data : "";
    const detail = data.match(/^detail_(\d+)$/);
    const movie = data.match(/^watch_movie_(\d+)$/);
    const episode = data.match(/^watch_series_(\d+)_ep_(\d+)$/);
    const pagination = data.match(/^episodes_(\d+)_page_(\d+)$/);
    const match = detail || movie || episode || pagination;
    if (!match || !match.slice(1).every(positiveId)) {
        await searchFeedback(chat.id, "Invalid selection. Please search again.");
        return;
    }
    try {
        if (detail || pagination) await showDetail(chat.id, match[1], pagination ? Number(match[2]) : 1);
        else if (movie) await deliverMovie(chat.id, match[1]);
        else await deliverEpisode(chat.id, match[1], match[2]);
    } catch (error) {
        console.error("Search selection failed.");
        await searchFeedback(chat.id, error.status === 404 ? "Movie or series not found." : "Could not load this selection. Please try again.");
    }
});

bot.onText(/^\/myid\s*$/, async function(msg) {
    if (msg.chat.type !== "private" || !msg.from || !positiveId(msg.from.id)) return;
    await searchFeedback(msg.chat.id, `Your Telegram User ID: ${msg.from.id}`);
});

bot.onText(/^\/start series_(\d+)_ep_(\d+)\s*$/, async function(msg, match) {
    await deliverEpisode(msg.chat.id, match[1], match[2]);
});

bot.onText(/\/start movie_(\d+)/, async function(msg, match) {
    await deliverMovie(msg.chat.id, match[1], true);
});

bot.on("message", async function(msg) {
    if (msg.chat.type === "private") return;
    if (!storageGroupId || !mappingApiSecret ||
        !["group", "supergroup"].includes(msg.chat.type) ||
        String(msg.chat.id) !== storageGroupId ||
        !(msg.video || msg.document)) {
        return;
    }

    // Anonymous/on-behalf-of-chat posts cannot establish an authorized user.
    if (msg.sender_chat || !msg.from || !positiveId(msg.from.id) ||
        !authorizedTelegramUserIds.has(String(Number(msg.from.id)))) {
        try {
            await telegramSend("sendMessage", msg.chat.id, "🔒 You are not authorized to map media.",
                { reply_to_message_id: msg.message_id });
        } catch {
            console.error("Mapping authorization reply failed.");
        }
        return;
    }

    const caption = typeof msg.caption === "string" ? msg.caption.trim() : "";
    const movieMatch = caption.match(/^movie_(\d+)$/);
    const seriesMatch = caption.match(/^series_(\d+)_ep_(\d+)$/);
    if (!movieMatch && !seriesMatch) {
        try {
            await telegramSend("sendMessage", msg.chat.id,
                "⚠️ Invalid mapping caption.\nUse:\nmovie_<id>\nor\nseries_<seriesId>_ep_<episodeNumber>\n\nExample:\nmovie_41\nseries_26_ep_1",
                { reply_to_message_id: msg.message_id });
        } catch {
            console.error("Invalid mapping caption reply failed.");
        }
        return;
    }

    const contentId = Number((movieMatch || seriesMatch)[1]);
    const episodeNumber = seriesMatch ? Number(seriesMatch[2]) : null;
    let feedback;

    if (!Number.isSafeInteger(contentId) || contentId <= 0 ||
        (seriesMatch && (!Number.isSafeInteger(episodeNumber) || episodeNumber <= 0))) {
        feedback = "Mapping failed: content ID and episode number must be positive safe integers.";
    } else {
        const endpoint = movieMatch
            ? `/api/internal/movies/${contentId}/telegram`
            : `/api/internal/series/${contentId}/episodes/${episodeNumber}/telegram`;
        try {
            const response = await fetch(mappingBackendUrl + endpoint, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${mappingApiSecret}`
                },
                body: JSON.stringify({
                    telegram_chat_id: String(msg.chat.id),
                    telegram_message_id: msg.message_id
                })
            });

            if (!response.ok) {
                const errors = {
                    400: "Invalid mapping values or content type.",
                    401: "Mapping authentication rejected.",
                    403: "Storage group rejected.",
                    404: "Content not found.",
                    503: "Automatic mapping is not configured on the backend."
                };
                feedback = "Mapping failed: " + (errors[response.status] || "Backend could not save the mapping.");
                console.error("Automatic mapping rejected. HTTP status:", response.status);
            } else {
                feedback = movieMatch
                    ? `✅ Movie ${contentId} mapped.`
                    : `✅ Series ${contentId} Episode ${episodeNumber} mapped.`;
                console.log("Automatic mapping saved.");
            }
        } catch {
            feedback = "Mapping could not be confirmed. Check the backend and retry the upload.";
            console.error("Automatic mapping request failed.");
        }
    }

    try {
        await telegramSend("sendMessage", msg.chat.id, feedback, { reply_to_message_id: msg.message_id });
    } catch {
        console.error("Automatic mapping feedback reply failed.");
    }
});
const deliveryStates = new Map();
const deliveryQueue = [];
const DELIVERY_CONCURRENCY = 5;
const MAX_QUEUED_DELIVERIES = 100;
const DELIVERY_COOLDOWN_MS = 30000;
let runningDeliveries = 0;

function drainDeliveries() {
    while (runningDeliveries < DELIVERY_CONCURRENCY && deliveryQueue.length) {
        const { operation, resolve, reject } = deliveryQueue.shift();
        runningDeliveries++;
        Promise.resolve().then(operation).then(resolve, reject).finally(() => {
            runningDeliveries--;
            drainDeliveries();
        });
    }
}

async function protectedDelivery(chatId, contentKey, operation) {
    const key = `${chatId}:${contentKey}`;
    const state = deliveryStates.get(key);
    if (state && (state.active || state.until > Date.now())) {
        await searchFeedback(chatId, state.active
            ? "⏳ This title is already being delivered. Please wait."
            : "⏳ This title was just sent. Please wait a moment before requesting it again.");
        return;
    }
    if (deliveryQueue.length >= MAX_QUEUED_DELIVERIES) {
        await searchFeedback(chatId, "⏳ Delivery is busy. Please try again shortly.");
        return;
    }
    const entry = { active: true, until: 0 };
    deliveryStates.set(key, entry);
    let delivered = false;
    try {
        delivered = await new Promise((resolve, reject) => {
            deliveryQueue.push({ operation, resolve, reject });
            drainDeliveries();
        });
    } catch {
        console.error("Queued delivery failed.");
        await searchFeedback(chatId, "Something went wrong. Please try again.");
    } finally {
        if (delivered === true) {
            entry.active = false;
            entry.until = Date.now() + DELIVERY_COOLDOWN_MS;
            const cleanup = setTimeout(() => {
                if (deliveryStates.get(key) === entry) deliveryStates.delete(key);
            }, DELIVERY_COOLDOWN_MS);
            cleanup.unref();
        } else {
            deliveryStates.delete(key);
        }
    }
}

async function deliverMovie(chatId, movieId, includeDetail = false) {
    return protectedDelivery(chatId, `movie:${Number(movieId)}`, async () => {
        if (includeDetail) {
            try {
                await showDetail(chatId, movieId, 1, false);
            } catch {
                console.error("Movie deep-link detail failed.");
            }
        }
        return sendMovie(chatId, movieId);
    });
}

async function deliverEpisode(chatId, seriesId, episodeNumber) {
    return protectedDelivery(chatId, `series:${Number(seriesId)}:episode:${Number(episodeNumber)}`,
        () => sendEpisode(chatId, seriesId, episodeNumber));
}

async function sendEpisode(chatId, seriesId, episodeNumber) {

    try {
        const response = await fetch(
            `${mappingBackendUrl}/api/series/${seriesId}/episodes/${episodeNumber}/telegram`
        );

        if (response.status === 404) {
            await telegramSend("sendMessage", chatId, "Episode not found.");
            return;
        }

        if (!response.ok) {
            throw new Error(`Episode lookup failed: ${response.status}`);
        }

        const episode = await response.json();

        const seriesResponse = await fetch(
           `${mappingBackendUrl}/api/movies/${seriesId}`
        );

        if (!seriesResponse.ok) {
             throw new Error("Series details could not be loaded.");
        }

        const series = await seriesResponse.json();

        const isFinalEpisode =
              series.series_status === "completed" &&
              Number(series.episodes) === Number(episodeNumber);

        const caption =
             `${series.title} (${series.year}) _Ep_${episodeNumber}` +
             (isFinalEpisode ? "_End" : "");

        await telegramSend("copyMessage",
             chatId,
             Number(episode.telegram_chat_id),
             episode.telegram_message_id,
            {
                caption: caption
            }
        );

        console.log("Episode sent: Series ID:", seriesId, "Episode number:", episodeNumber);
        return true;
    } catch {
        console.error("Episode lookup or delivery failed. Series ID:", seriesId, "Episode number:", episodeNumber);
        await searchFeedback(
            chatId,
            "Something went wrong. Please try again."
        );
    }
}

async function sendMovie(chatId, movieId) {

    console.log("Requested Movie ID:", movieId);

    try {

        const response = await fetch(
            `${mappingBackendUrl}/api/movies/${movieId}/telegram`
        );

        if (!response.ok) {

            await searchFeedback(
                chatId,
                "Movie not found."
            );

            return;
        }

        const movie = await response.json();

        if (
            !movie.telegram_chat_id ||
            !movie.telegram_message_id
        ) {

            await searchFeedback(
                chatId,
                "This movie is not available yet."
            );

            return;
        }
        const movieDetailsResponse = await fetch(
            `${mappingBackendUrl}/api/movies/${movieId}`
        );

        if (!movieDetailsResponse.ok) {
           throw new Error("Movie details could not be loaded.");
        }

       const movieDetails = await movieDetailsResponse.json();

       const caption =
          `${movieDetails.title} (${movieDetails.year})`;

        await telegramSend("copyMessage",
            chatId,
            Number(movie.telegram_chat_id),
            movie.telegram_message_id,
            {
                caption: caption
            }
        );

        console.log(
            "Movie sent:",
            movie.title
        );
        return true;

    } catch {

        console.error(
            "Movie lookup or delivery failed. Movie ID:",
            movieId
        );

        await searchFeedback(
            chatId,
            "Something went wrong. Please try again."
        );

    }

}
