require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;
const storageGroupId = process.env.STORAGE_GROUP_ID;
const mappingApiSecret = process.env.MAPPING_API_SECRET;
const mappingBackendUrl = (process.env.BACKEND_URL || "http://localhost:3000").replace(/\/+$/, "");

const bot = new TelegramBot(token, {
    polling: true
});

bot.on("message", async function(msg) {
    console.log("Group ID:", msg.chat.id);
    console.log("Message ID:", msg.message_id);

    if (msg.video) {
        console.log("Video File ID:", msg.video.file_id);

    }
    if (!storageGroupId || !mappingApiSecret ||
        !["group", "supergroup"].includes(msg.chat.type) ||
        String(msg.chat.id) !== storageGroupId ||
        !(msg.video || msg.document)) {
        return;
    }

    const caption = typeof msg.caption === "string" ? msg.caption.trim() : "";
    const movieMatch = caption.match(/^movie_(\d+)$/);
    const seriesMatch = caption.match(/^series_(\d+)_ep_(\d+)$/);
    if (!movieMatch && !seriesMatch) {
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
                console.error("Automatic mapping rejected:", caption, "HTTP status:", response.status);
            } else {
                feedback = movieMatch
                    ? `Movie ${contentId} mapped.`
                    : `Series ${contentId} Episode ${episodeNumber} mapped.`;
                console.log("Automatic mapping saved:", caption, "Group ID:", msg.chat.id, "Message ID:", msg.message_id);
            }
        } catch {
            feedback = "Mapping could not be confirmed. Check the backend and retry the upload.";
            console.error("Automatic mapping request failed:", caption);
        }
    }

    try {
        await bot.sendMessage(msg.chat.id, feedback, { reply_to_message_id: msg.message_id });
    } catch {
        console.error("Automatic mapping feedback reply failed:", caption, "Message ID:", msg.message_id);
    }
});
bot.onText(/^\/start series_(\d+)_ep_(\d+)\s*$/, async function(msg, match) {
    const seriesId = match[1];
    const episodeNumber = match[2];

    try {
        const response = await fetch(
            `http://localhost:3000/api/series/${seriesId}/episodes/${episodeNumber}/telegram`
        );

        if (response.status === 404) {
            await bot.sendMessage(msg.chat.id, "Episode not found.");
            return;
        }

        if (!response.ok) {
            throw new Error(`Episode lookup failed: ${response.status}`);
        }

        const episode = await response.json();

        await bot.copyMessage(
            msg.chat.id,
            Number(episode.telegram_chat_id),
            episode.telegram_message_id
        );

        console.log("Episode sent: Series ID:", seriesId, "Episode number:", episodeNumber);
    } catch {
        console.error("Episode lookup or delivery failed. Series ID:", seriesId, "Episode number:", episodeNumber);
        await bot.sendMessage(
            msg.chat.id,
            "Something went wrong. Please try again."
        );
    }
});

bot.onText(/\/start movie_(\d+)/, async function(msg, match) {

    const movieId = match[1];

    console.log("Requested Movie ID:", movieId);

    try {

        const response = await fetch(
            `http://localhost:3000/api/movies/${movieId}/telegram`
        );

        if (!response.ok) {

            bot.sendMessage(
                msg.chat.id,
                "Movie not found."
            );

            return;
        }

        const movie = await response.json();

        if (
            !movie.telegram_chat_id ||
            !movie.telegram_message_id
        ) {

            bot.sendMessage(
                msg.chat.id,
                "This movie is not available yet."
            );

            return;
        }

        await bot.copyMessage(
            msg.chat.id,
            Number(movie.telegram_chat_id),
            movie.telegram_message_id
        );

        console.log(
            "Movie sent:",
            movie.title
        );

    } catch {

        console.error(
            "Movie lookup or delivery failed. Movie ID:",
            movieId
        );

        bot.sendMessage(
            msg.chat.id,
            "Something went wrong. Please try again."
        );

    }

});