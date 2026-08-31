import { API_URL } from "./config.js";

const typeSelect = document.getElementById("type");

const durationGroup =
    document.getElementById("durationGroup");

const episodesGroup =
    document.getElementById("episodesGroup");

// Poster preview

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

function updateFields() {

    if (typeSelect.value === "movie") {

        durationGroup.style.display = "block";
        episodesGroup.style.display = "none";

    } else {

        durationGroup.style.display = "none";
        episodesGroup.style.display = "block";

    }

}


typeSelect.addEventListener("change", function() {

    updateFields();

});


updateFields();


const addForm =
    document.getElementById("addForm");


addForm.addEventListener("submit", async function(event) {

    event.preventDefault();


    // Get selected poster

    const posterFile =
        document.getElementById("poster").files[0];


    if (!posterFile) {

        alert("Please choose a poster.");

        return;

    }


    // Upload poster

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
    // Get selected genres

const selectedGenres =
    Array.from(
        document.querySelectorAll(
            "#genreGroup input:checked"
        )
    ).map(function(checkbox) {

        return checkbox.value;

    });


// Get selected categories

const selectedCategories =
    Array.from(
        document.querySelectorAll(
            "#categoryGroup input:checked"
        )
    ).map(function(checkbox) {

        return checkbox.value;

    });


    // Movie data

    const movieData = {

        type: typeSelect.value,

        poster: uploadResult.posterUrl,

        title: document.getElementById("title").value,

       genres: selectedGenres.join(", "),

       categories: selectedCategories.join(", "),

       year: Number(
            document.getElementById("year").value
        ),

        link: document.getElementById("link").value,

        review: document.getElementById("review").value,

        fileSize: document.getElementById("fileSize").value,

        quality: document.getElementById("quality").value,

        duration:
            typeSelect.value === "movie"
                ? document.getElementById("duration").value
                : null,

        rating: document.getElementById("rating").value,

        episodes:
            typeSelect.value === "series"
                ? Number(
                    document.getElementById("episodes").value
                )
                : null

    };


    // Save movie data

      const response =
         await fetch(
            API_URL + "/api/movies",
            {

                method: "POST",

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

        alert("Movie could not be added.");

        return;

    }


    window.location.href =
        "admin.html";

});