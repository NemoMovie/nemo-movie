async function addMovie() {

    const response = await fetch("http://localhost:3000/api/movies", {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({
            id: 4,
            title: "Pee Nak 5"
        })

    });

    const newMovie = await response.json();

    console.log("New movie:", newMovie);

}

addMovie();