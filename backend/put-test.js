async function updateMovie() {

    const response = await fetch("http://localhost:3000/api/movies/2", {

        method: "PUT",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({
            title: "The Super Mario Galaxy 2"
        })

    });

    const updatedMovie = await response.json();

    console.log("Updated movie:", updatedMovie);

}

updateMovie();