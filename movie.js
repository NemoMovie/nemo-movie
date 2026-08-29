import { movies } from "./movies.js";

function showMovie() {

    const params = new URLSearchParams(window.location.search);

    const movieId = Number(params.get("id"));

    const selectedMovie = movies.find(function(movie) {
        return movie.id === movieId;
    });

    if (!selectedMovie) {
        document.body.innerHTML = "<h1>Movie not found</h1>";
        return;
    }

    const movieTitle = document.getElementById("movieTitle");
    movieTitle.textContent = selectedMovie.title;

    const movieYear = document.getElementById("movieYear");
    movieYear.textContent = selectedMovie.year;
    movieYear.style.fontSize = "24px";
    movieYear.style.fontWeight = "bold";

    const movieReview = document.getElementById("movieReview");
    movieReview.textContent = selectedMovie.review;

    const moviePoster = document.getElementById("moviePoster");
    moviePoster.src = selectedMovie.poster;

    const movieCategory = document.getElementById("movieCategory");
    movieCategory.textContent = selectedMovie.category;

    const watchButton = document.getElementById("watchButton");
    watchButton.href = selectedMovie.link;

    const movieFileSize = document.getElementById("movieFileSize");
    const movieQuality = document.getElementById("movieQuality");
    const movieDuration = document.getElementById("movieDuration");
    const movieRating = document.getElementById("movieRating");
    const saveButton = document.getElementById("saveButton");

    movieFileSize.textContent = selectedMovie.fileSize;
    movieQuality.textContent = selectedMovie.quality;
    movieDuration.textContent = selectedMovie.duration;
    movieRating.textContent = selectedMovie.rating;


    // Check if movie is already saved

    let savedMovies = JSON.parse(localStorage.getItem("savedMovies")) || [];

    if (savedMovies.includes(selectedMovie.id)) {
        saveButton.textContent = "🔖 Saved";
    } else {
        saveButton.textContent = "🔖 Save Movie";
    }


    // Save / Unsave movie

    saveButton.addEventListener("click", function() {

        let savedMovies = JSON.parse(localStorage.getItem("savedMovies")) || [];

        if (savedMovies.includes(selectedMovie.id)) {

            savedMovies = savedMovies.filter(function(movieId) {
                return movieId !== selectedMovie.id;
            });

            localStorage.setItem("savedMovies", JSON.stringify(savedMovies));

            saveButton.textContent = "🔖 Save Movie";

        } else {

            savedMovies.push(selectedMovie.id);

            localStorage.setItem("savedMovies", JSON.stringify(savedMovies));

            saveButton.textContent = "🔖 Saved";
        }

    });

}

showMovie();


const backButton = document.getElementById("backButton");

backButton.addEventListener("click", function() {
    history.back();
});