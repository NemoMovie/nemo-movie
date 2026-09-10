import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import express from "express";

test("global headers and scoped no-store cover successes and early errors", async t => {
    const source = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
    // Execute the production header middleware without starting production or opening databases.
    const app = vm.runInNewContext(source.slice(source.indexOf("const app = express();"),
        source.indexOf("if (isProduction) app.set")) + "\napp;", { express });
    app.use(express.static(fileURLToPath(new URL("../frontend", import.meta.url))));
    app.use((req, res) => res.status(Number(req.get("test-status")) || 200).json({ ok: true }));
    app.use((err, req, res, next) => res.status(400).json({ message: "Invalid request body" }));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    async function request(route, method = "GET", status = 200, body) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
            method, headers: { "test-status": String(status), "Content-Type": "application/json" }, body
        });
        await response.text();
        assert.equal(response.headers.get("x-powered-by"), null);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
        assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'");
        return response;
    }
    const sensitive = [["POST", "/api/login"], ["POST", "/api/logout"],
        ["GET", "/api/admin/check"], ["GET", "/api/admin/account"], ["PUT", "/api/admin/account"],
        ["GET", "/api/admin/movies"], ["GET", "/api/admin/movies/1"],
        ["PUT", "/api/admin/movies/1/telegram"], ["DELETE", "/api/admin/series/2/episodes/1"],
        ["PUT", "/api/admin/series/2/episodes/1"], ["POST", "/api/movies"],
        ["PUT", "/api/movies/1"], ["DELETE", "/api/movies/1"], ["POST", "/api/upload"],
        ["GET", "/api/movies/1/telegram"], ["GET", "/api/series/2/episodes/1/telegram"],
        ["PUT", "/api/internal/movies/1/telegram"], ["PUT", "/api/internal/series/2/episodes/1/telegram"],
        ["GET", "/API/ADMIN/CHECK/"]];
    for (const [method, route] of sensitive) {
        for (const status of [200, 400, 401, 403, 404, 429, 500, 503]) {
            const result = await request(route, method, status);
            assert.equal(result.status, status);
            assert.equal(result.headers.get("cache-control"), "no-store", `${method} ${route}`);
        }
    }
    const malformed = await request("/api/login", "POST", 200, "{");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get("cache-control"), "no-store");
    for (const route of ["/api/movies", "/api/movies/1", "/api/series/2/episodes", "/uploads/test.webp"]) {
        assert.equal((await request(route)).headers.get("cache-control"), null);
    }
    assert.equal((await request("/login.css")).headers.get("cache-control"), "public, max-age=0");
});
