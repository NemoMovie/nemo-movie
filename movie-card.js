export function createMovieCard(movie) {


  let card = document.createElement("div");

     card.classList.add("movie-card");
     card.dataset.movieId = movie.id;
    
     document.querySelector(".movie-container").appendChild(card);


  let posterLink = document.createElement("a");

     posterLink.href = "movie.html?id=" + movie.id;

     posterLink.classList.add("poster-link");

  let image = document.createElement("img");

     image.src = movie.poster;

     posterLink.appendChild(image);

  let movieRating = document.createElement("span");

     movieRating.classList.add("movie-rating");
     movieRating.textContent = "⭐ " + movie.rating;

     posterLink.appendChild(movieRating);

     card.appendChild(posterLink);


    let movieTitle = document.createElement("h1");

     movieTitle.classList.add("movie-title");

     movieTitle.textContent = movie.title;
     card.appendChild(movieTitle);

    let movieYear = document.createElement("p");

     movieYear.textContent = movie.year;
     movieYear.style.fontSize = "24px";
     movieYear.style.fontWeight = "bold";
     card.appendChild(movieYear);

    let movieCategory = document.createElement("p");

     movieCategory.textContent = movie.category;
     card.appendChild(movieCategory);


    let watchLink = document.createElement("a");

     watchLink.textContent = "Watch Now";

     watchLink.href = movie.link;

     card.appendChild(watchLink);

}
