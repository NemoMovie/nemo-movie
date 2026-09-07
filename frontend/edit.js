import { API_URL } from "./config.js";

function getPosterUrl(poster) {

    if (poster.startsWith("/uploads/")) {

       return API_URL + poster;

    }

    return poster;

}
// Get movie ID from the URL

const params =
    new URLSearchParams(window.location.search);

const movieId =
    params.get("id");


// Store the current poster

let currentPoster = "";
let currentLegacyLink = null;

const telegramMappingSection = document.getElementById("telegramMappingSection");
const telegramMappingForm = document.getElementById("telegramMappingForm");
const telegramMappingMessage = document.getElementById("telegramMappingMessage");
const contentTypeSelect = document.getElementById("type");

function updateTelegramMappingVisibility() {
    telegramMappingSection.hidden = contentTypeSelect.value !== "movie";
}

contentTypeSelect.addEventListener("change", updateTelegramMappingVisibility);

telegramMappingForm.addEventListener("submit", async function(event) {
    event.preventDefault();
    telegramMappingMessage.textContent = "";

    const chatId = document.getElementById("telegramChatId").value.trim();
    const messageId = Number(document.getElementById("telegramMessageId").value);

    if (!chatId || !Number.isSafeInteger(messageId) || messageId <= 0) {
        telegramMappingMessage.textContent = "Enter a chat ID and a positive integer message ID.";
        return;
    }

    try {
        const response = await fetch(API_URL + "/api/admin/movies/" + movieId + "/telegram", {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                telegram_chat_id: chatId,
                telegram_message_id: messageId
            })
        });
        const result = await response.json();
        telegramMappingMessage.textContent = response.ok
            ? "Telegram mapping saved."
            : result.message || "Could not save Telegram mapping.";
    } catch (error) {
        console.error(error);
        telegramMappingMessage.textContent = "Could not save Telegram mapping. Please try again.";
    }
});


// Manage episodes separately from movie mapping and metadata

const episodeManagementSection = document.getElementById("episodeManagementSection");
const mappedEpisodeList = document.getElementById("mappedEpisodeList");
const episodeMappingForm = document.getElementById("episodeMappingForm");
const episodeManagementMessage = document.getElementById("episodeManagementMessage");
let persistedSeries = false;
let persistedPlannedTotal = null;
let episodeLoadVersion = 0;
const episodeAvailabilitySummary = document.getElementById("episodeAvailabilitySummary");
const episodeAvailabilityNotice = document.getElementById("episodeAvailabilityNotice");
document.getElementById("refreshEpisodesButton").addEventListener("click", loadMappedEpisodes);

function updateEpisodeManagementVisibility() {
    episodeManagementSection.hidden = !persistedSeries || contentTypeSelect.value !== "series";
}

contentTypeSelect.addEventListener("change", updateEpisodeManagementVisibility);

async function episodeRequest(url, options = {}) {
    const response = await fetch(API_URL + url, { ...options, credentials: "include" });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.message || "Episode request failed.");
    }
    return result;
}

async function loadMappedEpisodes() {
    const loadVersion = ++episodeLoadVersion;
    episodeAvailabilitySummary.textContent = "Loading availability...";
    episodeAvailabilityNotice.textContent = "";
    mappedEpisodeList.textContent = "Loading episodes...";
    try {
        const episodes = await episodeRequest("/api/series/" + movieId + "/episodes");
        if (loadVersion !== episodeLoadVersion) {
            return;
        }
        const plannedTotal = persistedPlannedTotal;
        const hasPlannedTotal = Number.isSafeInteger(plannedTotal) && plannedTotal > 0;
        const mappedNumbers = new Set(episodes.map(function(episode) { return episode.episode_number; }));
        episodeAvailabilitySummary.textContent = hasPlannedTotal
            ? "Available: " + mappedNumbers.size + " / " + plannedTotal
            : "Available: " + mappedNumbers.size + " · Planned total not set";
        if (hasPlannedTotal && plannedTotal > 500) {
            episodeAvailabilityNotice.textContent = "Planned total is too large to display all missing episodes.";
        }
        const episodeNumbers = new Set(mappedNumbers);
        if (hasPlannedTotal && plannedTotal <= 500) {
            for (let number = 1; number <= plannedTotal; number++) {
                episodeNumbers.add(number);
            }
        }
        mappedEpisodeList.textContent = episodeNumbers.size ? "" : "Episodes not available yet.";
        let leftColumn;
        let rightColumn;
        if (hasPlannedTotal && plannedTotal <= 500) {
            const columns = document.createElement("div");
            columns.className = "episode-management-columns";
            leftColumn = document.createElement("div");
            rightColumn = document.createElement("div");
            columns.appendChild(leftColumn);
            columns.appendChild(rightColumn);
            mappedEpisodeList.appendChild(columns);
        }

        Array.from(episodeNumbers).sort(function(a, b) { return a - b; }).forEach(function(number) {
            const rowContainer = leftColumn && number <= plannedTotal
                ? (number <= Math.ceil(plannedTotal / 2) ? leftColumn : rightColumn)
                : mappedEpisodeList;
            const episode = { episode_number: number };
            const available = mappedNumbers.has(number);
            const row = document.createElement("div");
            row.className = "episode-management-row";
            const label = document.createElement("span");
            label.textContent = "Episode " + episode.episode_number + " ";
            row.appendChild(label);
            const helper = document.createElement("span");
            helper.className = "episode-caption-helper";
            const caption = document.createElement("code");
            caption.textContent = "series_" + movieId + "_ep_" + number;
            helper.appendChild(caption);
            const copyButton = document.createElement("button");
            copyButton.type = "button";
            copyButton.textContent = "Copy";
            copyButton.setAttribute("aria-label", "Copy Telegram caption " + caption.textContent);
            copyButton.addEventListener("click", async function() {
                try {
                    await navigator.clipboard.writeText(caption.textContent);
                    copyButton.textContent = "Copied!";
                    copyButton.title = "";
                } catch {
                    copyButton.textContent = "Copy failed";
                    copyButton.title = "Select the caption text and copy it manually.";
                }
            });
            helper.appendChild(copyButton);
            row.appendChild(helper);
            const status = document.createElement("span");
            status.className = "episode-mapping-status";
            status.textContent = available
                ? (hasPlannedTotal && number > plannedTotal ? "Available · Beyond planned total" : "Available")
                : "Missing";
            row.appendChild(status);

            if (!available) {
                const addEpisodeButton = document.createElement("button");
                addEpisodeButton.type = "button";
                addEpisodeButton.textContent = "Add";
                addEpisodeButton.addEventListener("click", function() {
                    document.getElementById("episodeNumber").value = number;
                    document.getElementById("episodeChatId").value = "";
                    document.getElementById("episodeMessageId").value = "";
                    document.getElementById("episodeChatId").focus();
                    episodeManagementMessage.textContent = "Adding Episode " + number;
                });
                row.appendChild(addEpisodeButton);
                rowContainer.appendChild(row);
                return;
            }

            const editEpisodeButton = document.createElement("button");
            editEpisodeButton.type = "button";
            editEpisodeButton.textContent = "Edit";
            editEpisodeButton.addEventListener("click", async function() {
                try {
                    const mapping = await episodeRequest(
                        "/api/series/" + movieId + "/episodes/" + episode.episode_number + "/telegram"
                    );
                    document.getElementById("episodeNumber").value = episode.episode_number;
                    document.getElementById("episodeChatId").value = mapping.telegram_chat_id;
                    document.getElementById("episodeMessageId").value = mapping.telegram_message_id;
                    episodeManagementMessage.textContent = "Editing Episode " + episode.episode_number;
                } catch (error) {
                    episodeManagementMessage.textContent = error.message;
                }
            });
            row.appendChild(editEpisodeButton);

            const deleteEpisodeButton = document.createElement("button");
            deleteEpisodeButton.type = "button";
            deleteEpisodeButton.textContent = "Delete";
            deleteEpisodeButton.addEventListener("click", async function() {
                if (!confirm("Delete the mapping for Episode " + episode.episode_number + "?")) {
                    return;
                }
                try {
                    await episodeRequest(
                        "/api/admin/series/" + movieId + "/episodes/" + episode.episode_number,
                        { method: "DELETE" }
                    );
                    if (Number(document.getElementById("episodeNumber").value) === episode.episode_number) {
                        episodeMappingForm.reset();
                    }
                    episodeManagementMessage.textContent = "Episode mapping deleted.";
                    await loadMappedEpisodes();
                } catch (error) {
                    episodeManagementMessage.textContent = error.message;
                }
            });
            row.appendChild(deleteEpisodeButton);
            rowContainer.appendChild(row);
        });
    } catch (error) {
        if (loadVersion !== episodeLoadVersion) {
            return;
        }
        episodeAvailabilitySummary.textContent = "Availability unavailable.";
        episodeAvailabilityNotice.textContent = "";
        mappedEpisodeList.textContent = "Unable to load episodes. " + error.message;
    }
}

episodeMappingForm.addEventListener("submit", async function(event) {
    event.preventDefault();
    if (!persistedSeries || contentTypeSelect.value !== "series") {
        return;
    }
    const episodeNumber = Number(document.getElementById("episodeNumber").value);
    const chatId = document.getElementById("episodeChatId").value.trim();
    const messageId = Number(document.getElementById("episodeMessageId").value);
    if (!Number.isSafeInteger(episodeNumber) || episodeNumber <= 0 ||
        !chatId || !Number.isSafeInteger(messageId) || messageId <= 0) {
        episodeManagementMessage.textContent = "Enter positive integer episode/message IDs and a chat ID.";
        return;
    }
    try {
        await episodeRequest("/api/admin/series/" + movieId + "/episodes/" + episodeNumber, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ telegram_chat_id: chatId, telegram_message_id: messageId })
        });
        episodeManagementMessage.textContent = "Episode mapping saved.";
        await loadMappedEpisodes();
    } catch (error) {
        episodeManagementMessage.textContent = error.message;
    }
});

function updateSeriesStatusVisibility() {
    document.getElementById("seriesStatusGroup").hidden = contentTypeSelect.value !== "series";
    document.getElementById("durationGroup").hidden = contentTypeSelect.value === "series";
    document.getElementById("episodesGroup").hidden = contentTypeSelect.value !== "series";
}

contentTypeSelect.addEventListener("change", updateSeriesStatusVisibility);

// Load movie data

async function loadMovie() {

    const response = await fetch(
        API_URL + "/api/movies/" + movieId
    );

    const movie = await response.json();

    console.log(movie);


    // Store current poster

    currentPoster = movie.poster;
    // Show current poster
    
    const posterPreview =
    document.getElementById("posterPreview");

   posterPreview.src =
     getPosterUrl(movie.poster);


    // Put movie data into the form

    document.getElementById("type").value =
        movie.type;

    document.getElementById("telegramChatId").value = movie.telegram_chat_id ?? "";
    document.getElementById("telegramMessageId").value = movie.telegram_message_id ?? "";
    updateTelegramMappingVisibility();
    document.getElementById("seriesStatus").value = movie.series_status ?? "";
    updateSeriesStatusVisibility();

    persistedSeries = movie.type === "series";
    persistedPlannedTotal = movie.episodes;
    updateEpisodeManagementVisibility();
    if (persistedSeries) {
        loadMappedEpisodes();
    }

    document.getElementById("title").value =
        movie.title;

    // Select saved genres

    const savedGenres =
    movie.genres
        ? movie.genres.split(", ")
        : [];


   document.querySelectorAll(
    "#genreGroup input"
   ).forEach(function(checkbox) {

    checkbox.checked =
        savedGenres.includes(
            checkbox.value
        );

 });


 // Select saved categories

    const savedCategories =
    movie.categories
        ? movie.categories.split(", ")
        : [];


   document.querySelectorAll(
    "#categoryGroup input"
  ).forEach(function(checkbox) {

    checkbox.checked =
        savedCategories.includes(
            checkbox.value
        );

 });
       

    document.getElementById("year").value =
        movie.year;

    currentLegacyLink = movie.link;

    document.getElementById("review").value =
        movie.review;

    document.getElementById("fileSize").value =
        movie.fileSize;

    document.getElementById("quality").value =
        movie.quality;

    document.getElementById("duration").value =
        movie.duration || "";

    document.getElementById("rating").value =
        movie.rating;

    document.getElementById("episodes").value =
        movie.episodes ?? "";

}
// Preview new poster

const posterInput =
    document.getElementById("poster");

const posterPreview =
    document.getElementById("posterPreview");


posterInput.addEventListener("change", function() {

    const file =
        posterInput.files[0];

    if (!file) {
        return;
    }

    posterPreview.src =
        URL.createObjectURL(file);

});

// Save changes

const editForm =
    document.getElementById("editForm");


editForm.addEventListener(
    "submit",
    async function(event) {

        event.preventDefault();


        // Check for a new poster

        const posterFile =
            document.getElementById("poster").files[0];


        let posterUrl =
            currentPoster;


        // Upload new poster if selected

        if (posterFile) {

            const formData =
                new FormData();

            formData.append(
                "poster",
                posterFile
            );


            const uploadResponse =
                await fetch(
                    API_URL + "/api/upload",
                    {

                        method: "POST",

                        body: formData

                    }
                );


            const uploadResult =
                await uploadResponse.json();


            console.log(uploadResult);


            if (!uploadResponse.ok) {

                alert("Poster upload failed.");

                return;

            }


            posterUrl =
                uploadResult.posterUrl;

        }
          // Get selected genres

       const selectedGenres =
         Array.from(
             document.querySelectorAll(
            "#genreGroup input:checked"
          )
         ).map(function(checkbox) {

         return checkbox.value;

        });


          // Get selected categories

       const selectedCategories =
       Array.from(
          document.querySelectorAll(
            "#categoryGroup input:checked"
          )
          ).map(function(checkbox) {

          return checkbox.value;

       });


        // Movie data

        const movieData = {

            type:
                document.getElementById("type").value,

            poster:
                posterUrl,

            title:
                document.getElementById("title").value,

            genres:
                selectedGenres.join(", "),

            categories:
                selectedCategories.join(", "),

            year:
                Number(
                    document.getElementById("year").value
                ),

            link:
                currentLegacyLink,

            review:
                document.getElementById("review").value,

            fileSize:
                document.getElementById("fileSize").value,

            quality:
                document.getElementById("quality").value,

            duration:
                document.getElementById("type").value === "movie"
                    ? document.getElementById("duration").value
                    : null,

            rating:
                document.getElementById("rating").value,

            ...(contentTypeSelect.value === "series" && document.getElementById("seriesStatus").value !== ""
                ? { series_status: document.getElementById("seriesStatus").value }
                : {}),
            episodes:
                document.getElementById("type").value === "series" && document.getElementById("episodes").value.trim() !== ""
                    ? Number(
                        document.getElementById("episodes").value
                    )
                    : null

        };


        // Update movie

        const response =
            await fetch(
                API_URL + "/api/movies/" + movieId,
                {

                    method: "PUT",

                    headers: {

                        "Content-Type":
                            "application/json"

                    },

                    body:
                        JSON.stringify(movieData)

                }
            );


        const result =
            await response.json();

        console.log(result);


        if (!response.ok) {

            alert("Movie could not be updated.");

            return;

        }


        window.location.href =
            "admin.html";

    }
);


// Start

loadMovie();