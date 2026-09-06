require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;

const bot = new TelegramBot(token, {
    polling: true
});

bot.on("message", function(msg) {
    console.log("Group ID:", msg.chat.id);
    console.log("Message ID:", msg.message_id);

    if (msg.video) {
        console.log("Video File ID:", msg.video.file_id);

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

    } catch (error) {

        console.error(
            "Movie request error:",
            error
        );

        bot.sendMessage(
            msg.chat.id,
            "Something went wrong. Please try again."
        );

    }

});