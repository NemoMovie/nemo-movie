async function testDelete() {

    const response = await fetch(
        "http://localhost:3000/api/movies/14",
        {
            method: "DELETE"
        }
    );

    const result = await response.json();

    console.log(result);
}

testDelete();