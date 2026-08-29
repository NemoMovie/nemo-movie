async function deleteMovie() {

    const response = await fetch("http://localhost:3000/api/movies/2", {

        method: "DELETE"

    });

    const deletedMovie = await response.json();

    console.log("Deleted movie:", deletedMovie);

}

deleteMovie();