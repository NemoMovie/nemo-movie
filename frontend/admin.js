import { API_URL } from "./config.js";


// Check admin login

async function checkAdmin() {

    try {
        const response = await fetch(API_URL + "/api/admin/check", { credentials: "include" });
        if (response.status === 401) window.location.href = "login.html";
        else if (!response.ok) showAdminError("Could not check Admin session. Please retry.");
    } catch {
        showAdminError("Could not check Admin session. Please retry.");
    }

}

checkAdmin();

// Open Account Settings

const accountSettingsButton =
    document.getElementById(
        "accountSettingsButton"
    );

accountSettingsButton.addEventListener(
    "click",
    function() {

        window.location.href =
            "account.html";

    }
);


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

const moviesPerPage = 24;

let requestVersion = 0;
let searchTimer;
const sortValues = { newest: "newest", oldest: "oldest", titleAZ: "title-asc",
    titleZA: "title-desc", yearHigh: "year-desc", yearLow: "year-asc" };
const listMessage = document.createElement("div");
listMessage.setAttribute("role", "status");
document.getElementById("adminMovieList").before(listMessage);

function showAdminError(message) {
    listMessage.textContent = message + " ";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry loading list";
    retry.addEventListener("click", () => loadAdminMovies());
    listMessage.appendChild(retry);
}

async function loadAdminMovies() {
    clearTimeout(searchTimer);
    const version = ++requestVersion;
    const params = new URLSearchParams({ page: currentPage, limit: moviesPerPage,
        search: document.getElementById("searchInput").value.trim(),
        type: document.getElementById("typeFilter").value,
        sort: sortValues[document.getElementById("sortFilter").value] });
    try {
        const response = await fetch(API_URL + "/api/admin/movies?" + params, { credentials: "include" });
        if (version !== requestVersion) return;
        if (response.status === 401) {
            window.location.href = "login.html";
            return;
        }
        if (!response.ok) throw new Error("List failed");
        const result = await response.json();
        if (version !== requestVersion) return;
        const lastPage = Math.max(1, Math.ceil(result.total / moviesPerPage));
        if (currentPage > lastPage) {
            currentPage = lastPage;
            return loadAdminMovies();
        }
        listMessage.textContent = result.total ? "" : "No movies or series found.";
        for (const key of ["totalContent", "totalMovies", "totalSeries"]) {
            document.getElementById(key).textContent = result.stats[key];
        }
        displayMovies(result.movies, result.total);
    } catch {
        if (version === requestVersion) showAdminError("Could not load Admin list. Please retry.");
    }
}

// Display movies

function displayMovies(movieList, total) {

    const adminMovieList =
        document.getElementById(
            "adminMovieList"
        );

    adminMovieList.innerHTML = "";


    const startIndex =
        (currentPage - 1) *
        moviesPerPage;


    movieList.forEach(
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


            // Movie ID
            const movieId = document.createElement("span");
            movieId.textContent = movie.id;
            if (movie.type === "movie") {
                const helper = document.createElement("span");
                helper.className = "caption-helper";
                const caption = document.createElement("code");
                caption.textContent = "movie_" + movie.id;
                helper.appendChild(caption);
                const copyButton = document.createElement("button");
                copyButton.type = "button";
                copyButton.className = "caption-copy";
                copyButton.textContent = "Copy";
                copyButton.setAttribute("aria-label", "Copy Telegram caption " + caption.textContent);
                copyButton.addEventListener("click", async function() {
                    try {
                        await navigator.clipboard.writeText(caption.textContent);
                        copyButton.textContent = "Copied!";
                        copyButton.title = "";
                    } catch {
                        copyButton.textContent = "Copy failed";
                        copyButton.title = "Select the caption text and copy it manually.";
                    }
                });
                helper.appendChild(copyButton);
                movieId.appendChild(helper);
            }
            movieItem.appendChild(movieId);

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


                    try {
                        const response = await fetch(API_URL + "/api/movies/" + movie.id, {
                            method: "DELETE", credentials: "include"
                        });
                        if (response.status === 401) {
                            window.location.href = "login.html";
                            return;
                        }
                        if (!response.ok) throw new Error("Delete failed");
                        await loadAdminMovies();
                    } catch {
                        showAdminError("Could not delete this title. Refresh the list before trying again.");
                    }

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
        total
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

                loadAdminMovies();

            }

        }
    );


    pagination.appendChild(
        previousButton
    );


    // Page numbers

    for (
        let page = Math.max(1, currentPage - 2);
        page <= Math.min(totalPages, currentPage + 2);
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

                loadAdminMovies();

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

                loadAdminMovies();

            }

        }
    );


    pagination.appendChild(
        nextButton
    );

}


// Invalidate in-flight responses immediately, including during debounce.
function criteriaChanged(delay = 0) {
    currentPage = 1;
    ++requestVersion;
    clearTimeout(searchTimer);
    if (delay) searchTimer = setTimeout(loadAdminMovies, delay);
    else loadAdminMovies();
}
const searchInput = document.getElementById("searchInput");
searchInput.addEventListener("input", () => criteriaChanged(300));
searchInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        event.preventDefault();
        criteriaChanged();
    }
});
document.getElementById("typeFilter").addEventListener("change", () => criteriaChanged());
document.getElementById("sortFilter").addEventListener("change", () => criteriaChanged());

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
