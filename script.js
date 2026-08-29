import { movies } from "./movies.js";
import { createMovieCard } from "./movie-card.js";
const title = document.getElementById("title");


title.style.cursor = "pointer";
const searchBtn = document.getElementById("searchBtn");
const searchInput = document.getElementById("searchInput");
let movieCards = document.querySelectorAll(".movie-card");
const noResults = document.getElementById("noResults");
const searchTerm = document.getElementById("searchTerm");

searchBtn.addEventListener("click", function() {

    const searchText = searchInput.value.toLowerCase();
    let found = false;

    movieCards.forEach(function(card) {

        const title = card.querySelector(".movie-title").textContent.toLowerCase();

        if (title.includes(searchText)) {
            card.style.display = "block";
            found = true;
        } else {
            card.style.display = "none";
        }

    });

    if (found) {
        noResults.style.display = "none";
    } else {
        noResults.style.display = "block";
        searchTerm.textContent = searchInput.value;
    }

});

searchInput.addEventListener("input", function() {

    const searchText = searchInput.value.toLowerCase();
    let found = false;

    movieCards.forEach(function(card) {

const title = card.querySelector(".movie-title").textContent.toLowerCase();
const category = card.querySelector("p").textContent.toLowerCase();

const movieId = Number(card.dataset.movieId);

const movie = movies.find(function(movie) {
    return movie.id === movieId;
});

if (
    title.includes(searchText) ||
    category.includes(searchText) ||
    movie.year.toString().includes(searchText)
) {
            card.style.display = "block";
            found = true;
        } else {
            card.style.display = "none";
        }

    });

    if (searchText === "") {
        movieCards.forEach(function(card) {
            card.style.display = "block";
        });

        noResults.style.display = "none";
        return;
    }

    if (found) {
        noResults.style.display = "none";
    } else {
        noResults.style.display = "block";
        searchTerm.textContent = searchInput.value;
    }

});



for (let movie of movies) {
    createMovieCard(movie);     
}
 movieCards = document.querySelectorAll(".movie-card");

const movieContainer = document.querySelector(".movie-container");

movieContainer.addEventListener("click", function(event) {

    const card = event.target.closest(".movie-card");

    if (!card) {
        return;
    }

    if (event.target.closest("a")) {
        return;
    }

    movieCards.forEach(function(otherCard) {
        otherCard.classList.remove("selected-movie");
    });

    card.classList.add("selected-movie");

    let movieId = Number(card.dataset.movieId);

    window.location.href = "movie.html?id=" + movieId;
});
