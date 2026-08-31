import { API_URL } from "./config.js";


// Check admin login

async function checkAdmin() {

    const response = await fetch(
        API_URL + "/api/admin/check",
        {
            credentials: "include"
        }
    );

    if (!response.ok) {

        window.location.href =
            "login.html";

        return;

    }

}

checkAdmin();


function getPosterUrl(poster) {

    if (!poster) {

        return "";

    }

    if (poster.startsWith("/uploads/")) {

        return API_URL + poster;

    }

    return poster;

}


// Admin logout

const logoutButton =
    document.getElementById(
        "logoutButton"
    );

logoutButton.addEventListener(
    "click",
    async function() {

        await fetch(
            API_URL + "/api/logout",
            {
                method: "POST",
                credentials: "include"
            }
        );

        window.location.href =
            "login.html";

    }
);


// Pagination

let currentPage = 1;

const moviesPerPage = 20;

let allMovies = [];


// Load admin movies

async function loadAdminMovies() {

     const response = await fetch(
       API_URL + "/api/admin/movies",
      {
           credentials: "include"
      }
    );

    if (!response.ok) {

        window.location.href =
            "login.html";

        return;

    }

    allMovies =
       await response.json();

    updateContentStats();

    sortMovies();

}
// Update content statistics

function updateContentStats() {

    const totalContent =
        document.getElementById("totalContent");

    const totalMovies =
        document.getElementById("totalMovies");

    const totalSeries =
        document.getElementById("totalSeries");


    const movieCount =
        allMovies.filter(function(movie) {

            return movie.type === "movie";

        }).length;


    const seriesCount =
        allMovies.filter(function(movie) {

            return movie.type === "series";

        }).length;


    totalContent.textContent =
        allMovies.length;

    totalMovies.textContent =
        movieCount;

    totalSeries.textContent =
        seriesCount;

}

// Sort movies

function sortMovies() {

    const sortFilter =
        document.getElementById(
            "sortFilter"
        );

    const sortValue =
        sortFilter.value;


    if (sortValue === "newest") {

        allMovies.sort(
            function(a, b) {

                return b.id - a.id;

            }
        );

    }


    if (sortValue === "oldest") {

        allMovies.sort(
            function(a, b) {

                return a.id - b.id;

            }
        );

    }


    if (sortValue === "titleAZ") {

        allMovies.sort(
            function(a, b) {

                return a.title.localeCompare(
                    b.title
                );

            }
        );

    }


    if (sortValue === "titleZA") {

        allMovies.sort(
            function(a, b) {

                return b.title.localeCompare(
                    a.title
                );

            }
        );

    }


    if (sortValue === "yearHigh") {

        allMovies.sort(
            function(a, b) {

                return b.year - a.year;

            }
        );

    }


    if (sortValue === "yearLow") {

        allMovies.sort(
            function(a, b) {

                return a.year - b.year;

            }
        );

    }


    currentPage = 1;

    filterMovies();

}


// Display movies

function displayMovies(movieList) {

    const adminMovieList =
        document.getElementById(
            "adminMovieList"
        );

    adminMovieList.innerHTML = "";


    const startIndex =
        (currentPage - 1) *
        moviesPerPage;


    const endIndex =
        startIndex +
        moviesPerPage;


    const pageMovies =
        movieList.slice(
            startIndex,
            endIndex
        );


    pageMovies.forEach(
        function(movie, index) {

            const movieItem =
                document.createElement("div");

            movieItem.classList.add(
                "admin-movie-item"
            );

            movieItem.dataset.type =
                movie.type;


            // Poster

            const moviePoster =
                document.createElement("img");

            moviePoster.src =
                getPosterUrl(
                    movie.poster
                );

            moviePoster.alt =
                movie.title;

            moviePoster.classList.add(
                "admin-poster"
            );

            movieItem.appendChild(
                moviePoster
            );


            // Movie title

            const movieTitle =
                document.createElement("span");

            movieTitle.textContent =
                (
                    startIndex +
                    index +
                    1
                ) +
                " - " +
                movie.title;

            movieItem.appendChild(
                movieTitle
            );


            // Type

            const movieType =
                document.createElement("span");

            movieType.textContent =
                movie.type;

            movieItem.appendChild(
                movieType
            );


            // Year

            const movieYear =
                document.createElement("span");

            movieYear.textContent =
                movie.year || "";

            movieItem.appendChild(
                movieYear
            );


            // Edit button

            const editButton =
                document.createElement(
                    "button"
                );

            editButton.textContent =
                "Edit";

            editButton.addEventListener(
                "click",
                function() {

                    window.location.href =
                        "edit.html?id=" +
                        movie.id;

                }
            );

            movieItem.appendChild(
                editButton
            );


            // Delete button

            const deleteButton =
                document.createElement(
                    "button"
                );

            deleteButton.textContent =
                "Delete";


            deleteButton.addEventListener(
                "click",
                async function() {

                    const confirmDelete =
                        confirm(
                            "Are you sure you want to delete " +
                            movie.title +
                            "?"
                        );


                    if (!confirmDelete) {

                        return;

                    }


                    const response =
                        await fetch(
                            API_URL +
                            "/api/movies/" +
                            movie.id,
                            {
                                method: "DELETE",
                                credentials: "include"
                            }
                        );


                    const result =
                        await response.json();


                    console.log(result);


                    loadAdminMovies();

                }
            );


            movieItem.appendChild(
                deleteButton
            );


            adminMovieList.appendChild(
                movieItem
            );

        }
    );


    displayPagination(
        movieList.length
    );

}


// Search and type filter

function filterMovies() {

    const searchInput =
        document.getElementById(
            "searchInput"
        );

    const typeFilter =
        document.getElementById(
            "typeFilter"
        );


    const searchText =
        searchInput.value
            .toLowerCase()
            .trim();


    const selectedType =
        typeFilter.value;


    const filteredMovies =
        allMovies.filter(
            function(movie) {

                const movieText =
                    (
                        (movie.title || "") +
                        " " +
                        (movie.category || "") +
                        " " +
                        (movie.year || "")
                    )
                    .toLowerCase();


                const matchesSearch =
                    movieText.includes(
                        searchText
                    );


                const matchesType =
                    selectedType === "all" ||
                    movie.type === selectedType;


                return (
                    matchesSearch &&
                    matchesType
                );

            }
        );


    const totalPages =
        Math.ceil(
            filteredMovies.length /
            moviesPerPage
        );


    if (
        currentPage > totalPages &&
        totalPages > 0
    ) {

        currentPage =
            totalPages;

    }


    displayMovies(
        filteredMovies
    );

}


// Pagination buttons

function displayPagination(totalItems) {

    const pagination =
        document.getElementById(
            "pagination"
        );


    pagination.innerHTML = "";


    const totalPages =
        Math.ceil(
            totalItems /
            moviesPerPage
        );


    if (totalPages <= 1) {

        return;

    }


    // Previous

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

                filterMovies();

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

                filterMovies();

            }
        );


        pagination.appendChild(
            pageButton
        );

    }


    // Next

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

                filterMovies();

            }

        }
    );


    pagination.appendChild(
        nextButton
    );

}


// Search

const searchInput =
    document.getElementById(
        "searchInput"
    );

searchInput.addEventListener(
    "input",
    function() {

        currentPage = 1;

        filterMovies();

    }
);


// Type filter

const typeFilter =
    document.getElementById(
        "typeFilter"
    );

typeFilter.addEventListener(
    "change",
    function() {

        currentPage = 1;

        filterMovies();

    }
);


// Sort filter

const sortFilter =
    document.getElementById(
        "sortFilter"
    );

sortFilter.addEventListener(
    "change",
    function() {

        sortMovies();

    }
);


// Add content button

const addContentButton =
    document.getElementById(
        "addContentButton"
    );

addContentButton.addEventListener(
    "click",
    function() {

        window.location.href =
            "add.html";

    }
);


// Load movies when page appears

window.addEventListener(
    "pageshow",
    function() {

        loadAdminMovies();

    }
);