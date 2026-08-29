import { movies } from "./movies.js";
import { createMovieCard } from "./movie-card.js";

const savedMovies = document.getElementById("savedMovies");
const emptyMessage = document.getElementById("emptyMessage");
const savedMovieIds = JSON.parse(localStorage.getItem("savedMovies")) || [];
if (savedMovieIds.length > 0) {
    emptyMessage.style.display = "none";
}
for (let movieId of savedMovieIds) {

    const movie = movies.find(function(movie) {
        return movie.id === movieId;
    });

    if (movie) {
        createMovieCard(movie);
    }
}
const backButton = document.getElementById("backButton");

backButton.addEventListener("click", function() {
    history.back();
});