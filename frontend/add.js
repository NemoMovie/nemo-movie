import { API_URL } from "./config.js";

const typeSelect = document.getElementById("type");

const durationGroup =
    document.getElementById("durationGroup");

const episodesGroup =
    document.getElementById("episodesGroup");


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


    // Movie data

    const movieData = {

        type: typeSelect.value,

        poster: uploadResult.posterUrl,

        title: document.getElementById("title").value,

        category: document.getElementById("category").value,

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