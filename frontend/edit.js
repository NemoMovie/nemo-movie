import { API_URL } from "./config.js";

function getPosterUrl(poster) {

    if (poster.startsWith("/uploads/")) {

       return API_URL + poster;

    }

    return poster;

}
// Get movie ID from the URL

const params =
    new URLSearchParams(window.location.search);

const movieId =
    params.get("id");


// Store the current poster

let currentPoster = "";


// Load movie data

async function loadMovie() {

    const response = await fetch(
        API_URL + "/api/movies/" + movieId
    );

    const movie = await response.json();

    console.log(movie);


    // Store current poster

    currentPoster = movie.poster;
    // Show current poster
    
    const posterPreview =
    document.getElementById("posterPreview");

   posterPreview.src =
     getPosterUrl(movie.poster);


    // Put movie data into the form

    document.getElementById("type").value =
        movie.type;

    document.getElementById("title").value =
        movie.title;

    document.getElementById("category").value =
        movie.category;

    document.getElementById("year").value =
        movie.year;

    document.getElementById("link").value =
        movie.link;

    document.getElementById("review").value =
        movie.review;

    document.getElementById("fileSize").value =
        movie.fileSize;

    document.getElementById("quality").value =
        movie.quality;

    document.getElementById("duration").value =
        movie.duration || "";

    document.getElementById("rating").value =
        movie.rating;

    document.getElementById("episodes").value =
        movie.episodes || "";

}
// Preview new poster

const posterInput =
    document.getElementById("poster");

const posterPreview =
    document.getElementById("posterPreview");


posterInput.addEventListener("change", function() {

    const file =
        posterInput.files[0];

    if (!file) {
        return;
    }

    posterPreview.src =
        URL.createObjectURL(file);

});

// Save changes

const editForm =
    document.getElementById("editForm");


editForm.addEventListener(
    "submit",
    async function(event) {

        event.preventDefault();


        // Check for a new poster

        const posterFile =
            document.getElementById("poster").files[0];


        let posterUrl =
            currentPoster;


        // Upload new poster if selected

        if (posterFile) {

            const formData =
                new FormData();

            formData.append(
                "poster",
                posterFile
            );


            const uploadResponse =
                await fetch(
                    API_URL + "/api/upload",
                    {

                        method: "POST",

                        body: formData

                    }
                );


            const uploadResult =
                await uploadResponse.json();


            console.log(uploadResult);


            if (!uploadResponse.ok) {

                alert("Poster upload failed.");

                return;

            }


            posterUrl =
                uploadResult.posterUrl;

        }


        // Movie data

        const movieData = {

            type:
                document.getElementById("type").value,

            poster:
                posterUrl,

            title:
                document.getElementById("title").value,

            category:
                document.getElementById("category").value,

            year:
                Number(
                    document.getElementById("year").value
                ),

            link:
                document.getElementById("link").value,

            review:
                document.getElementById("review").value,

            fileSize:
                document.getElementById("fileSize").value,

            quality:
                document.getElementById("quality").value,

            duration:
                document.getElementById("type").value === "movie"
                    ? document.getElementById("duration").value
                    : null,

            rating:
                document.getElementById("rating").value,

            episodes:
                document.getElementById("type").value === "series"
                    ? Number(
                        document.getElementById("episodes").value
                    )
                    : null

        };


        // Update movie

        const response =
            await fetch(
                API_URL + "/api/movies/" + movieId,
                {

                    method: "PUT",

                    headers: {

                        "Content-Type":
                            "application/json"

                    },

                    body:
                        JSON.stringify(movieData)

                }
            );


        const result =
            await response.json();

        console.log(result);


        if (!response.ok) {

            alert("Movie could not be updated.");

            return;

        }


        window.location.href =
            "admin.html";

    }
);


// Start

loadMovie();