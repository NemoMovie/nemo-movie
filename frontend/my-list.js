import { API_URL } from "./config.js";

function getPosterUrl(poster) {

    if (poster.startsWith("/uploads/")) {

        return API_URL + poster;
    }

    return poster;

}
async function loadMyList() {

    const savedMovies =
        JSON.parse(localStorage.getItem("savedMovies")) || [];


    const movieContainer =
        document.getElementById("myList");

    const emptyMessage =
        document.getElementById("emptyMessage");


    if (savedMovies.length === 0) {

        emptyMessage.style.display = "block";

        return;
    }


    const response = await fetch(
        API_URL + "/api/movies"
    );

    const data = await response.json();

    const movies = data.movies;


    const savedMovieList = movies.filter(function(movie) {

        return savedMovies.includes(movie.id);

    });


    if (savedMovieList.length === 0) {

        emptyMessage.style.display = "block";

        return;
    }


    emptyMessage.style.display = "none";


    savedMovieList.forEach(function(movie) {

        const card = document.createElement("div");

        card.classList.add("movie-card");


        // Poster
        const posterLink = document.createElement("a");

        posterLink.href = "movie.html?id=" + movie.id;
        posterLink.classList.add("poster-link");


        const image = document.createElement("img");

        image.src = getPosterUrl(movie.poster);
        image.alt = movie.title;

        posterLink.appendChild(image);


        // Rating
        const rating = document.createElement("span");

        rating.classList.add("movie-rating");
        rating.textContent = "⭐ " + movie.rating;

        posterLink.appendChild(rating);

        card.appendChild(posterLink);


        // Title
        const title = document.createElement("h1");

        title.classList.add("movie-title");
        title.textContent = movie.title;

        card.appendChild(title);


        // Year
        const year = document.createElement("p");

        year.textContent = movie.year;

        card.appendChild(year);


        // Category
        const category = document.createElement("p");

        category.textContent = movie.category;

        card.appendChild(category);


        movieContainer.appendChild(card);

    });

}


loadMyList();

