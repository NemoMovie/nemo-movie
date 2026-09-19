import { API_URL } from "./config.js";

const element = id => document.getElementById(id);
const message = element("usersMessage");
const rows = element("usersRows");
const retry = element("retryButton");
const previous = element("previousPage");
const next = element("nextPage");
const search = element("userSearch");
const status = element("userStatus");
const sort = element("userSort");
const dialog = element("userDialog");
const detailMessage = element("detailMessage");
const detailRetry = element("detailRetry");
const details = element("userDetails");
const logout = element("logoutButton");
const PAGE_SIZE = 24;
const dates = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Yangon", year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true
});
let page = 1;
let pages = 1;
let version = 0;
let detailVersion = 0;
let selectedId;
let debounce;
let authenticated = false;
let loggingOut = false;

function dateText(value) {
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? dates.format(time) + " MMT" : "—";
}
function usernameText(value) { return value ? "@" + value.replace(/^@/, "") : "—"; }
function statusBadge(value) {
    const badge = document.createElement("span");
    badge.className = "membership-status " + (value === "ACTIVE" ? "is-active" : "is-expired");
    badge.textContent = value === "ACTIVE" ? "Active" : value === "EXPIRED" ? "Expired" : "Not Premium";
    return badge;
}
async function requestJson(path) {
    const response = await fetch(API_URL + path, { credentials: "include" });
    if (response.status === 401) {
        authenticated = false;
        window.location.href = "login.html";
        throw new Error("Authentication required");
    }
    if (!response.ok) throw new Error("Request failed");
    return response.json();
}
function resetResults() {
    rows.replaceChildren();
    previous.disabled = true;
    next.disabled = true;
    retry.hidden = true;
    element("pageIndicator").textContent = "Page —";
    message.classList.remove("error");
}
function renderRows(users) {
    for (const user of users) {
        const row = document.createElement("tr");
        for (const value of [user.telegram_user_id, usernameText(user.username), dateText(user.start_at), dateText(user.expires_at)]) {
            const cell = document.createElement("td");
            cell.textContent = value;
            row.append(cell);
        }
        const state = document.createElement("td");
        state.append(statusBadge(user.status));
        const action = document.createElement("td");
        const view = document.createElement("a");
        view.className = "users-button";
        view.textContent = "View";
        view.setAttribute("aria-label", "View Premium user " + user.telegram_user_id);
        view.href = "premium-user-details.html?telegramUserId=" + encodeURIComponent(user.telegram_user_id);
        action.append(view);
        row.append(state, action);
        rows.append(row);
    }
}
async function loadUsers() {
    if (!authenticated || loggingOut) return;
    const request = ++version;
    resetResults();
    message.textContent = "Loading Premium users…";
    element("usersResults").setAttribute("aria-busy", "true");
    const query = new URLSearchParams({ page, limit: PAGE_SIZE, search: search.value.trim(), status: status.value, sort: sort.value });
    try {
        const data = await requestJson("/api/admin/premium/users?" + query);
        if (request !== version) return;
        if (!data || !Array.isArray(data.users) || !Number.isSafeInteger(data.total) || data.total < 0 ||
            data.users.length > PAGE_SIZE || data.users.some(user => !user ||
                !Number.isSafeInteger(user.telegram_user_id) || user.telegram_user_id <= 0 ||
                !["ACTIVE", "EXPIRED"].includes(user.status) ||
                (user.username != null && typeof user.username !== "string"))) throw new Error("Invalid users response");
        pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
        if (page > pages) { page = pages; await loadUsers(); return; }
        renderRows(data.users);
        message.textContent = data.users.length ? data.total.toLocaleString("en-US") + " Premium users" : "No Premium users found.";
        element("pageIndicator").textContent = `Page ${page} of ${pages}`;
        previous.disabled = page <= 1;
        next.disabled = page >= pages;
    } catch {
        if (request !== version) return;
        rows.replaceChildren();
        message.textContent = "Could not load Premium users. Please try again.";
        message.classList.add("error");
        retry.hidden = false;
    } finally {
        if (request === version) element("usersResults").setAttribute("aria-busy", "false");
    }
}
async function initialize() {
    const request = ++version;
    clearTimeout(debounce);
    ++detailVersion;
    if (dialog.open) dialog.close();
    authenticated = false;
    resetResults();
    message.textContent = "Checking Admin session…";
    try {
        await requestJson("/api/admin/check");
        if (request !== version || loggingOut) return;
        authenticated = true;
        await loadUsers();
    } catch {
        if (request !== version) return;
        message.textContent = "Could not verify Admin session. Please try again.";
        message.classList.add("error");
        retry.hidden = false;
        element("usersResults").setAttribute("aria-busy", "false");
    }
}
function criteriaChanged(delay = 0) {
    page = 1;
    clearTimeout(debounce);
    if (!authenticated || loggingOut) return;
    ++version; // Invalidate the old response immediately, before the debounce fires.
    resetResults();
    message.textContent = "Loading Premium users…";
    element("usersResults").setAttribute("aria-busy", "true");
    debounce = setTimeout(loadUsers, delay);
}
function remainingText(expiry) {
    const time = typeof expiry === "string" ? Date.parse(expiry) : NaN;
    if (!Number.isFinite(time)) return "—";
    const remaining = time - Date.now();
    if (remaining <= 0) return "0 days";
    const hours = Math.floor(remaining / 3600000);
    return hours ? `${Math.floor(hours / 24)} days ${hours % 24} hours` : "Less than 1 hour";
}
async function loadDetail() {
    const request = ++detailVersion;
    details.replaceChildren();
    detailRetry.hidden = true;
    detailMessage.classList.remove("error");
    detailMessage.textContent = "Loading user details…";
    try {
        const data = await requestJson("/api/admin/premium/users/" + encodeURIComponent(selectedId));
        if (request !== detailVersion || !dialog.open) return;
        if (!data?.user || data.user.telegram_user_id !== selectedId ||
            !["ACTIVE", "EXPIRED", "NON_PREMIUM"].includes(data.status)) throw new Error("Invalid detail response");
        const user = data.user;
        const membership = data.membership;
        const fields = [
            ["Telegram ID", user.telegram_user_id], ["Username", usernameText(user.username)],
            ["Name", [user.first_name, user.last_name].filter(Boolean).join(" ") || "—"],
            ["Premium Status", statusBadge(data.status)], ["Start Date", dateText(membership?.start_at)],
            ["Expiry Date", dateText(membership?.expires_at)], ["Remaining", remainingText(membership?.expires_at)]
        ];
        for (const [label, value] of fields) {
            const term = document.createElement("dt");
            term.textContent = label;
            const description = document.createElement("dd");
            if (label === "Premium Status") description.append(value);
            else description.textContent = value;
            details.append(term, description);
        }
        detailMessage.textContent = "Dates shown in Myanmar Time (MMT). Remaining time is calculated when loaded.";
    } catch {
        if (request !== detailVersion || !dialog.open) return;
        details.replaceChildren();
        detailMessage.textContent = "Could not load user details. Please try again.";
        detailMessage.classList.add("error");
        detailRetry.hidden = false;
    }
}
search.addEventListener("input", () => criteriaChanged(300));
status.addEventListener("change", () => criteriaChanged());
sort.addEventListener("change", () => criteriaChanged());
element("usersFilters").addEventListener("submit", event => { event.preventDefault(); criteriaChanged(); });
previous.addEventListener("click", () => { if (page > 1) { --page; loadUsers(); } });
next.addEventListener("click", () => { if (page < pages) { ++page; loadUsers(); } });
retry.addEventListener("click", () => authenticated ? loadUsers() : initialize());
detailRetry.addEventListener("click", loadDetail);
dialog.addEventListener("close", () => { ++detailVersion; details.replaceChildren(); });
logout.addEventListener("click", async () => {
    loggingOut = true;
    ++version;
    ++detailVersion;
    clearTimeout(debounce);
    logout.disabled = true;
    resetResults();
    if (dialog.open) dialog.close();
    message.textContent = "Logging out…";
    element("usersResults").setAttribute("aria-busy", "false");
    try {
        const response = await fetch(API_URL + "/api/logout", { method: "POST", credentials: "include" });
        if (!response.ok && response.status !== 401) throw new Error("Logout failed");
        window.location.href = "login.html";
    } catch {
        message.textContent = "Could not log out. Please try Logout again.";
        message.classList.add("error");
        loggingOut = false;
        logout.disabled = false;
        retry.hidden = false;
    }
});
window.addEventListener("pageshow", initialize);
