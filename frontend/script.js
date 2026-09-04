import { API_URL } from "./config.js";

let movies = [];

let allMovies = [];

let currentPage = 1;

// 24 movies per page

const moviesPerPage = 24;

let totalMovies = 0;


// Highlight the current navigation link

const navLinks =
    document.querySelectorAll(".nav-links a");

const currentType =
    new URLSearchParams(window.location.search).get("type");

const currentPageName =
    window.location.pathname.split("/").pop();


navLinks.forEach(function(link) {

    const href =
        link.getAttribute("href");
        if (
                currentPageName === "index.html" &&
            !currentType &&
              href === "index.html"
        ) {

            link.classList.add("active");

        }


    if (
        currentPageName === "my-list.html" &&
        href === "my-list.html"
    ) {

        link.classList.add("active");

    }


    if (
        currentPageName === "index.html" &&
        currentType === "movie" &&
        href.includes("type=movie")
    ) {

        link.classList.add("active");

    }


    if (
        currentPageName === "index.html" &&
        currentType === "series" &&
        href.includes("type=series")
    ) {

        link.classList.add("active");

    }

});


// Load movies from backend

async function loadMovies() {

    try {

        const searchText =
            searchInput.value
                .trim();


        // Get type from URL

        const params =
            new URLSearchParams(
                window.location.search
            );

        const type =
            params.get("type");


        let url =
            API_URL +
            "/api/movies?page=" +
            currentPage +
            "&limit=" +
            moviesPerPage;


        // Add search

        if (searchText !== "") {

            url +=
                "&search=" +
                encodeURIComponent(
                    searchText
                );

        }


        // Add movie/series type

        if (type === "movie" ||
            type === "series") {

            url +=
                "&type=" +
                encodeURIComponent(
                    type
                );

        }


        // Add category

        if (
            selectedCategory !== "all"
        ) {

            url +=
                "&category=" +
                encodeURIComponent(
                    selectedCategory
                );

        }


        const response =
            await fetch(
                url
            );


        if (!response.ok) {

            throw new Error(
                "Failed to load movies"
            );

        }


        const data =
            await response.json();


        // Store this page's movies

        movies =
            data.movies;


        // Store total number of movies

        totalMovies =
            data.total;


        displayMovies(
            movies
        );

        displayPagination();


        // Show or hide no-results message

        if (
            movies.length === 0
        ) {

            noResults.style.display =
                "block";

            searchTerm.textContent =
                searchInput.value;

        } else {

            noResults.style.display =
                "none";

        }


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

                movieYear.classList.add("movie-year");


               movieYear.textContent =
                movie.year || "";

               

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
// Display pagination buttons

function displayPagination() {

    const pagination =
        document.getElementById(
            "pagination"
        );

    pagination.innerHTML = "";


    const totalPages =
        Math.ceil(
            totalMovies /
            moviesPerPage
        );


    if (totalPages <= 1) {

        return;

    }


    // Previous button

    const previousButton =
        document.createElement(
            "button"
        );

    previousButton.textContent =
        "Previous";

    previousButton.disabled =
        currentPage === 1;


    previousButton.addEventListener(
        "click",
        function() {

            if (currentPage > 1) {

                currentPage--;

                loadMovies();
                window.scrollTo({
                  top: 0,
                  behavior: "smooth"
                });

            }

        }
    );


    pagination.appendChild(
        previousButton
    );


    // Page numbers

    for (
        let page = 1;
        page <= totalPages;
        page++
    ) {

        const pageButton =
            document.createElement(
                "button"
            );

        pageButton.textContent =
            page;


        if (
            page === currentPage
        ) {

            pageButton.disabled =
                true;

        }


        pageButton.addEventListener(
            "click",
            function() {

                currentPage =
                    page;

                 loadMovies();
                 window.scrollTo({
                     top: 0,
                   behavior: "smooth"
               });

            }
        );


        pagination.appendChild(
            pageButton
        );

    }


    // Next button

    const nextButton =
        document.createElement(
            "button"
        );

    nextButton.textContent =
        "Next";


    nextButton.disabled =
        currentPage === totalPages;


    nextButton.addEventListener(
        "click",
        function() {

            if (
                currentPage <
                totalPages
            ) {

                currentPage++;

                loadMovies();
                window.scrollTo({
                    top: 0,
                    behavior: "smooth"
                });

            }

        }
    );


    pagination.appendChild(
        nextButton
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

async function searchMovies() {

    const searchText =
        searchInput.value
            .toLowerCase()
            .trim();


    // When searching, ask the backend to search ALL movies

    if (searchText !== "") {

        currentPage = 1;


        const response =
            await fetch(
                API_URL +
                "/api/movies?page=" +
                currentPage +
                "&limit=" +
                moviesPerPage +
                "&search=" +
                encodeURIComponent(searchText)
            );


        const data =
            await response.json();


        movies =
            data.movies;

        totalMovies =
            data.total;


        displayMovies(
            movies
        );

        displayPagination();


        if (
            movies.length === 0
        ) {

            noResults.style.display =
                "block";

            searchTerm.textContent =
                searchInput.value;

        } else {

            noResults.style.display =
                "none";

        }


        return;

    }


    // No search text
    // Keep the current page movies

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


                return categoryMatch;

            }
        );


    displayMovies(
        filteredMovies
    );


    displayPagination();


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
                    categoryButtons.forEach(function(button) {

                     button.classList.remove("active");

                });

                   button.classList.add("active");


                    currentPage = 1;


                   loadMovies();

            }
        );

    }
);

// Start loading movies

loadMovies();