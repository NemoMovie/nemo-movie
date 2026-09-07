import { API_URL } from "./config.js";

function getPosterUrl(poster) {

    if (!poster) {
        return "";
    }

    if (poster.startsWith("/uploads/")) {

        return API_URL + poster;
    }

    return poster;

}
async function loadMyList() {

    let storedMovies = [];
    try {
        const parsed = JSON.parse(localStorage.getItem("savedMovies"));
        if (Array.isArray(parsed)) {
            storedMovies = parsed;
        }
    } catch {
        // Invalid saved data is treated as empty without changing localStorage.
    }
    const savedMovies = Array.from(new Set(storedMovies
        .filter(function(id) { return typeof id === "number" || (typeof id === "string" && id.trim() !== ""); })
        .map(Number)
        .filter(function(id) { return Number.isSafeInteger(id) && id > 0; })));


    const movieContainer =
        document.getElementById("myList");

    const emptyMessage =
        document.getElementById("emptyMessage");

    movieContainer.textContent = "";
    emptyMessage.textContent = "Your saved movies will appear here.";


    if (savedMovies.length === 0) {

        emptyMessage.style.display = "block";

        return;
    }


    emptyMessage.style.display = "block";
    emptyMessage.textContent = "Loading saved titles...";

    const savedMovieList = [];
    let failedRequests = 0;
    let missingMovies = 0;

    for (let offset = 0; offset < savedMovies.length; offset += 5) {
        await Promise.all(savedMovies.slice(offset, offset + 5).map(async function(id) {
            try {
                const response = await fetch(API_URL + "/api/movies/" + id);
                if (response.status === 404) {
                    missingMovies++;
                    return;
                }
                if (!response.ok) {
                    throw new Error("Movie request failed");
                }
                const movie = await response.json();
                if (!movie || movie.id !== id || (movie.poster != null && typeof movie.poster !== "string")) {
                    throw new Error("Invalid movie response");
                }
                savedMovieList.push(movie);
            } catch {
                failedRequests++;
            }
        }));
    }

    savedMovieList.sort(function(a, b) { return b.id - a.id; });

    if (savedMovieList.length === 0) {
        emptyMessage.textContent = failedRequests > 0
            ? "Unable to load saved titles. Please try again later."
            : "Your saved titles are no longer available.";
        return;
    }

    if (failedRequests > 0) {
        emptyMessage.textContent = "Some saved titles could not be loaded. Please try again later.";
    } else if (missingMovies > 0) {
        emptyMessage.textContent = "Some saved titles are no longer available.";
    } else {
        emptyMessage.style.display = "none";
    }


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

