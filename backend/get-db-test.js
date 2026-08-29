async function testGet() {
    const response = await fetch("http://localhost:3000/api/movies");

    const result = await response.json();

    console.log(result);
}

testGet();