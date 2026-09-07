import { API_URL } from "./config.js";

function getPosterUrl(poster) {

    if (poster.startsWith("/uploads/")) {

        return API_URL + poster;

    }

    return poster;

}
async function showMovie() {

    function showLoadError(message) {
        const movieInfo = document.querySelector(".movie-info");
        Array.from(movieInfo.children).forEach(function(element) {
            if (element.id !== "backButton") {
                element.style.display = "none";
            }
        });
        document.getElementById("moviePoster").style.display = "none";
        const errorMessage = document.createElement("p");
        errorMessage.textContent = message;
        errorMessage.setAttribute("role", "alert");
        movieInfo.insertBefore(errorMessage, movieInfo.firstChild);
    }

    const params = new URLSearchParams(window.location.search);

    const movieId = Number(params.get("id"));

    if (!Number.isSafeInteger(movieId) || movieId <= 0) {
        showLoadError("Movie or series not found.");
        return;
    }

    let selectedMovie;
    try {
        const response = await fetch(API_URL + "/api/movies/" + movieId);
        if (!response.ok) {
            showLoadError(response.status === 404
                ? "Movie or series not found."
                : "Could not load this title.");
            return;
        }
        selectedMovie = await response.json();
        if (!selectedMovie || selectedMovie.id !== movieId) {
            showLoadError("Could not load this title.");
            return;
        }
    } catch {
        showLoadError("Could not load this title.");
        return;
    }


    // Title
    const movieTitle = document.getElementById("movieTitle");

    movieTitle.textContent = selectedMovie.title;


    // Year
    const movieYear = document.getElementById("movieYear");

    movieYear.textContent = selectedMovie.year;

    movieYear.style.fontSize = "24px";
    movieYear.style.fontWeight = "bold";


    // Category
    const movieGenre = document.getElementById("movieGenre");

    movieGenre.textContent = selectedMovie.genres;


    // Review
    const movieReview = document.getElementById("movieReview");

    movieReview.textContent = selectedMovie.review;


    // Poster
    const moviePoster = document.getElementById("moviePoster");

    moviePoster.src = getPosterUrl(selectedMovie.poster);

    moviePoster.alt = selectedMovie.title;


    // Watch Now
    const watchButton = document.getElementById("watchButton");

    watchButton.href = `https://t.me/nemomovie_Bot?start=movie_${selectedMovie.id}`;

    watchButton.target = "_blank";

    function seriesSummary(availability) {
        const status = selectedMovie.series_status === "ongoing" ? "Ongoing"
            : selectedMovie.series_status === "completed" ? "Completed" : "Status not set";
        const planned = Number(selectedMovie.episodes);
        return status + " · " + availability + (planned > 0 ? " · " + planned + " planned" : "");
    }

    if (selectedMovie.type === "series") {
        watchButton.style.display = "none";

        const episodeContainer = document.getElementById("episodeContainer");
        episodeContainer.hidden = false;
        episodeContainer.textContent = "Loading episodes...";

        fetch(API_URL + "/api/series/" + selectedMovie.id + "/episodes")
            .then(function(response) {
                if (!response.ok) {
                    throw new Error("Failed to load episodes");
                }
                return response.json();
            })
            .then(function(episodes) {
                document.getElementById("movieDuration").textContent = seriesSummary(episodes.length + " episodes available");
                episodeContainer.textContent = "";

                if (episodes.length === 0) {
                    episodeContainer.textContent = "Episodes not available yet.";
                    return;
                }

                episodes.forEach(function(episode) {
                    const episodeLink = document.createElement("a");
                    episodeLink.textContent = "Episode " + episode.episode_number;
                    episodeLink.href = `https://t.me/nemomovie_Bot?start=series_${selectedMovie.id}_ep_${episode.episode_number}`;
                    episodeLink.target = "_blank";
                    episodeLink.rel = "noopener noreferrer";
                    episodeContainer.appendChild(episodeLink);
                });
            })
            .catch(function(error) {
                console.error(error);
                document.getElementById("movieDuration").textContent = seriesSummary("Availability unavailable");
                episodeContainer.textContent = "Unable to load episodes. Please try again later.";
            });
    }


    // Movie information
    const movieFileSize = document.getElementById("movieFileSize");
    const movieQuality = document.getElementById("movieQuality");
    const movieDuration = document.getElementById("movieDuration");
    const movieRating = document.getElementById("movieRating");
    const movieDurationLabel =
    document.getElementById("movieDurationLabel");

       movieFileSize.textContent = selectedMovie.fileSize;
       movieQuality.textContent = selectedMovie.quality;
       movieRating.textContent = selectedMovie.rating;

     if (selectedMovie.type === "series") {

       movieDurationLabel.textContent = "Episodes";
       movieDuration.textContent = seriesSummary("Loading availability...");

    } else {

       movieDurationLabel.textContent = "Duration";
       movieDuration.textContent = selectedMovie.duration;

    }


    // Save Movie
    const saveButton = document.getElementById("saveButton");

    let savedMovies =
        JSON.parse(localStorage.getItem("savedMovies")) || [];


   const contentType =
    selectedMovie.type === "series"
        ? "Series"
        : "Movie";


      if (savedMovies.includes(selectedMovie.id)) {

         saveButton.textContent = "✅ " + contentType + " Saved!";

    } else {

      saveButton.textContent = "🔖 Save " + contentType;

    }


    saveButton.addEventListener("click", function() {

        let savedMovies =
            JSON.parse(localStorage.getItem("savedMovies")) || [];


        if (savedMovies.includes(selectedMovie.id)) {

            savedMovies = savedMovies.filter(function(movieId) {

                return movieId !== selectedMovie.id;

            });

            localStorage.setItem(
                "savedMovies",
                JSON.stringify(savedMovies)
            );

           saveButton.textContent = "🔖 Save " + contentType;


        } else {

            savedMovies.push(selectedMovie.id);

            localStorage.setItem(
                "savedMovies",
                JSON.stringify(savedMovies)
            );

            saveButton.textContent = "✅ " + contentType + " Saved!";

        }

    });

}


showMovie();


// Back button
const backButton = document.getElementById("backButton");

backButton.addEventListener("click", function() {

    history.back();

});
