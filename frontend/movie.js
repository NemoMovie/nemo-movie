import { API_URL } from "./config.js";

function getPosterUrl(poster) {

    if (poster.startsWith("/uploads/")) {

        return API_URL + poster;

    }

    return poster;

}
async function showMovie() {

    const params = new URLSearchParams(window.location.search);

    const movieId = Number(params.get("id"));

    const response = await fetch(
       API_URL + "/api/movies/" + movieId
    );

    const selectedMovie = await response.json();

    if (!selectedMovie) {
        document.body.innerHTML = "<h1>Movie not found</h1>";
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

    watchButton.href = selectedMovie.link;

    watchButton.target = "_blank";


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
       movieDuration.textContent = selectedMovie.episodes;

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