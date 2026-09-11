const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture() {
    const requests = [], sends = [], messages = [];
    class MockBot {
        on(event, handler) { if (event === "message") messages.push(handler); }
        onText() {}
        async sendMessage() {}
        async copyMessage(...args) { sends.push(args); }
    }
    const context = vm.createContext({
        require: name => {
            if (name === "dotenv") return { config() {} };
            if (name === "node-telegram-bot-api") return MockBot;
            throw new Error("Unexpected dependency");
        },
        process: { env: { BACKEND_URL: "https://backend.invalid", MAPPING_READ_SECRET: "synthetic-test-secret",
            MAPPING_WRITE_SECRET: "synthetic-write-secret", STORAGE_GROUP_ID: "-100", AUTHORIZED_TELEGRAM_USER_IDS: "1" } },
        console: { log() {}, error() {} }, AbortSignal, URL, setTimeout,
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            const data = url.endsWith("/telegram")
                ? { telegram_chat_id: "-100", telegram_message_id: 123 }
                : { title: "Test Title", year: 2020, series_status: "completed", episodes: 3 };
            return { ok: true, status: 200, json: async () => data };
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "bot.js"), "utf8"), context);
    return { context, requests, sends, messages };
}

for (const [name, call, mappingPath, caption] of [
    ["movie", "sendMovie(1, 8)", "/api/movies/8/telegram", "Test Title (2020)"],
    ["episode", "sendEpisode(1, 26, 3)", "/api/series/26/episodes/3/telegram", "Test Title (2020) _Ep_3_End"]
]) {
    test(`${name} delivery authenticates only mapping fetch and preserves caption`, async () => {
        const f = fixture();
        assert.equal(await vm.runInContext(call, f.context), true);
        assert.equal(f.requests.length, 2);
        assert.equal(f.requests[0].url, "https://backend.invalid" + mappingPath);
        assert.equal(f.requests[0].options.headers.Authorization, "Bearer synthetic-test-secret");
        assert.equal(f.requests[1].options.headers, undefined);
        assert.equal(f.sends.length, 1);
        assert.equal(f.sends[0][3].caption, caption);
    });
}

test("shared public search/detail reader never attaches mapping authorization", async () => {
    const f = fixture();
    for (const route of ["/api/movies?search=love", "/api/movies?limit=500", "/api/movies/8", "/api/series/26/episodes"]) {
        await vm.runInContext(`readBackend(${JSON.stringify(route)})`, f.context);
    }
    assert.equal(f.requests.length, 4);
    for (const request of f.requests) assert.equal(request.options.headers, undefined);
    assert.equal(f.sends.length, 0);
});

test("automatic movie and episode uploads use only the write secret", async () => {
    const f = fixture();
    for (const caption of ["movie_8", "series_26_ep_3"]) {
        for (const handler of f.messages) {
            await handler({ chat: { id: -100, type: "supergroup" }, from: { id: 1 },
                video: { file_id: "synthetic" }, message_id: 123, caption });
        }
    }
    assert.equal(f.requests.length, 2);
    for (const request of f.requests) {
        assert.match(request.url, /\/api\/internal\//);
        assert.equal(request.options.method, "PUT");
        assert.equal(request.options.headers.Authorization, "Bearer synthetic-write-secret");
    }
});
