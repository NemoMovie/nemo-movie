function getPosterUrl(poster) {

    if (poster.startsWith("/uploads/")) {

        return "http://localhost:3000" + poster;

    }

    return poster;

}
async function loadAdminMovies() {

    const response = await fetch(
        "http://localhost:3000/api/movies"
    );

    const movies = await response.json();
    const sortFilter =
    document.getElementById("sortFilter");

const sortValue =
    sortFilter.value;

if (sortValue === "newest") {

    movies.sort(function(a, b) {
        return b.id - a.id;
    });

}

if (sortValue === "oldest") {

    movies.sort(function(a, b) {
        return a.id - b.id;
    });

}

if (sortValue === "titleAZ") {

    movies.sort(function(a, b) {
        return a.title.localeCompare(b.title);
    });

}

if (sortValue === "titleZA") {

    movies.sort(function(a, b) {
        return b.title.localeCompare(a.title);
    });

}

if (sortValue === "yearHigh") {

    movies.sort(function(a, b) {
        return b.year - a.year;
    });

}

if (sortValue === "yearLow") {

    movies.sort(function(a, b) {
        return a.year - b.year;
    });

}
   
    const adminMovieList =
        document.getElementById("adminMovieList");
        adminMovieList.innerHTML = "";
       
     movies.forEach(function(movie, index) {

    const movieItem = document.createElement("div");

      movieItem.classList.add("admin-movie-item");
      movieItem.dataset.type = movie.type;

      // Poster
    const moviePoster =
       document.createElement("img");

      moviePoster.src =
      getPosterUrl(movie.poster);

     moviePoster.alt =
      movie.title;

     moviePoster.classList.add("admin-poster");

     movieItem.appendChild(moviePoster);


      // Movie title
    const movieTitle =
         document.createElement("span");

      movieTitle.textContent =
     (index + 1) + " - " + movie.title;

      movieItem.appendChild(movieTitle);
      // Type
   const movieType =
    document.createElement("span");

     movieType.textContent =
       movie.type;

     movieItem.appendChild(movieType);
      // Year
    const movieYear =
       document.createElement("span");

     movieYear.textContent =
       movie.year;

     movieItem.appendChild(movieYear);

    // Edit button
   const editButton =
    document.createElement("button");

   editButton.textContent = "Edit";

   editButton.addEventListener("click", function() {

    window.location.href =
        "edit.html?id=" + movie.id;

   });

   movieItem.appendChild(editButton);
    // Delete button
    const deleteButton =
        document.createElement("button");

    deleteButton.textContent = "Delete";

    deleteButton.addEventListener("click", async function() {

    const confirmDelete = confirm(
        "Are you sure you want to delete " + movie.title + "?"
    );

    if (!confirmDelete) {
        return;
    }

    const response = await fetch(
        "http://localhost:3000/api/movies/" + movie.id,
        {
            method: "DELETE"
        }
    );

    const result = await response.json();

      console.log(result);

      loadAdminMovies();
 
     });


    movieItem.appendChild(deleteButton);

    adminMovieList.appendChild(movieItem);

    });
    const addContentButton =
    document.getElementById("addContentButton");

     addContentButton.addEventListener("click", function() {

    window.location.href = "add.html";

   });

   filterMovies();

}

window.addEventListener("pageshow", function() {
    loadAdminMovies();
});
const searchInput =
    document.getElementById("searchInput");

const typeFilter =
    document.getElementById("typeFilter");


function filterMovies() {

    const searchText =
        searchInput.value.toLowerCase();

    const selectedType =
        typeFilter.value;

    const movieItems =
        document.querySelectorAll(".admin-movie-item");


    movieItems.forEach(function(movieItem) {

        const movieText =
            movieItem.textContent.toLowerCase();

        const movieType =
            movieItem.dataset.type;


        const matchesSearch =
            movieText.includes(searchText);

        const matchesType =
            selectedType === "all" ||
            movieType === selectedType;


        if (matchesSearch && matchesType) {

            movieItem.style.display = "";

        } else {

            movieItem.style.display = "none";

        }

    });

}


searchInput.addEventListener(
    "input",
    filterMovies
);


typeFilter.addEventListener(
    "change",
    filterMovies
);
const sortFilter =
    document.getElementById("sortFilter");

sortFilter.addEventListener(
    "change",
    function() {
        loadAdminMovies();
    }
);