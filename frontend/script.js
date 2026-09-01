import { API_URL } from "./config.js";

let movies = [];


// Load movies from backend

async function loadMovies() {

    try {

        const response = await fetch(
            API_URL + "/api/movies"
        );

        if (!response.ok) {

            throw new Error(
                "Failed to load movies"
            );

        }

        movies = await response.json();


        const params =
            new URLSearchParams(
                window.location.search
            );

        const type =
            params.get("type");


        if (type === "movie") {

            movies = movies.filter(
                function(movie) {

                    return movie.type === "movie";

                }
            );

        }


        if (type === "series") {

            movies = movies.filter(
                function(movie) {

                    return movie.type === "series";

                }
            );

        }


        displayMovies(movies);

    } catch (error) {

        console.error(error);

        const movieContainer =
            document.querySelector(
                ".movie-container"
            );

        movieContainer.innerHTML = `
            <div class="error-message">

                <h2>Unable to load movies.</h2>

                <p>Please try again later.</p>

            </div>
        `;

    }

}


// Get correct poster URL

function getPosterUrl(poster) {

    if (!poster) {

        return "";

    }

    if (poster.startsWith("/uploads/")) {

        return API_URL + poster;

    }

    return poster;

}


// Display movie cards

function displayMovies(movieList) {

    const movieContainer =
        document.querySelector(
            ".movie-container"
        );

    movieContainer.innerHTML = "";


    movieList.forEach(
        function(movie) {

            const card =
                document.createElement("div");

            card.classList.add(
                "movie-card"
            );

            card.dataset.movieId =
                movie.id;


            // Poster

            const posterLink =
                document.createElement("a");

            posterLink.href =
                "movie.html?id=" + movie.id;

            posterLink.classList.add(
                "poster-link"
            );


            const image =
                document.createElement("img");

            image.src =
                getPosterUrl(movie.poster);

            image.alt =
                movie.title;


            posterLink.appendChild(
                image
            );


            // Quality

            const movieQuality =
                document.createElement("span");

            movieQuality.classList.add(
                "movie-quality"
            );


            const qualities =
                (movie.quality || "").split("/");


            movieQuality.textContent =
                qualities[0].trim();


            posterLink.appendChild(
                movieQuality
            );


            // Rating

            const movieRating =
                document.createElement("span");

            movieRating.classList.add(
                "movie-rating"
            );

            movieRating.textContent =
                movie.rating
                    ? "⭐ " + movie.rating
                    : "";


            posterLink.appendChild(
                movieRating
            );


            card.appendChild(
                posterLink
            );


            // Title

            const movieTitle =
                document.createElement("h1");

            movieTitle.classList.add(
                "movie-title"
            );

            movieTitle.textContent =
                movie.title;


            card.appendChild(
                movieTitle
            );


            // Year

            const movieYear =
                document.createElement("p");

            movieYear.textContent =
                movie.year || "";


            movieYear.style.fontSize =
                "24px";

            movieYear.style.fontWeight =
                "bold";


            card.appendChild(
                movieYear
            );


            // Genres

           const movieGenres =
                document.createElement("p");

           movieGenres.textContent =
                movie.genres || "";

           card.appendChild(
               movieGenres
            );


            // Watch Now

            const watchLink =
                document.createElement("a");

            watchLink.textContent =
                "Watch Now";

            watchLink.href =
                movie.link || "#";

            watchLink.target =
                "_blank";


            card.appendChild(
                watchLink
            );


            movieContainer.appendChild(
                card
            );

        }
    );

}
// Current selected category

let selectedCategory = "all";

// Search elements

const searchInput =
    document.getElementById(
        "searchInput"
    );

const searchBtn =
    document.getElementById(
        "searchBtn"
    );

const noResults =
    document.getElementById(
        "noResults"
    );

const searchTerm =
    document.getElementById(
        "searchTerm"
    );


// Search button

searchBtn.addEventListener(
    "click",
    function() {

        searchMovies();

    }
);


// Live search

searchInput.addEventListener(
    "input",
    function() {

        searchMovies();

    }
);


// Search movies

function searchMovies() {

    const searchText =
        searchInput.value
            .toLowerCase()
            .trim();


    const filteredMovies =
        movies.filter(
            function(movie) {

                // Check category

                const categories =
                    (movie.categories || "")
                        .split(", ")
                        .map(function(category) {

                            return category.trim();

                        });


                const categoryMatch =
                    selectedCategory === "all" ||
                    categories.includes(
                        selectedCategory
                    );


                // Check search

                const searchMatch =
                    searchText === "" ||

                    (movie.title || "")
                        .toLowerCase()
                        .includes(searchText)

                    ||

                    (movie.genres || "")
                        .toLowerCase()
                        .includes(searchText)

                    ||

                    (movie.categories || "")
                        .toLowerCase()
                        .includes(searchText)

                    ||

                    String(movie.year || "")
                        .includes(searchText);


                return (
                    categoryMatch &&
                    searchMatch
                );

            }
        );


    displayMovies(
        filteredMovies
    );


    if (
        filteredMovies.length === 0
    ) {

        noResults.style.display =
            "block";

        searchTerm.textContent =
            searchInput.value;

    } else {

        noResults.style.display =
            "none";

    }

}

// Category filter

const categoryButtons =
    document.querySelectorAll(
        ".category-filter button"
    );


categoryButtons.forEach(
    function(button) {

        button.addEventListener(
            "click",
            function() {

                selectedCategory =
                    button.dataset.category;


                searchMovies();

            }
        );

    }
);


categoryButtons.forEach(
    function(button) {

        button.addEventListener(
            "click",
            function() {

                const selectedCategory =
                    button.dataset.category;


                if (
                    selectedCategory === "all"
                ) {

                    displayMovies(movies);

                    return;

                }


                const filteredMovies =
                    movies.filter(
                        function(movie) {

                            const categories =
                                (movie.categories || "")
                                    .split(", ")
                                    .map(function(category) {

                                        return category.trim();

                                    });


                            return categories.includes(
                                selectedCategory
                            );

                        }
                    );


                displayMovies(
                    filteredMovies
                );

            }
        );

    }
);


// Start loading movies

loadMovies();