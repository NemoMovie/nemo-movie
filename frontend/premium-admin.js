import { API_URL } from "./config.js";

const keys = ["totalPremiumUsers", "activePremium", "expiredPremium", "totalIncome"];
const message = document.getElementById("dashboardMessage");
const retry = document.getElementById("retryButton");
const logout = document.getElementById("logoutButton");
const stats = document.getElementById("stats");
const numbers = new Intl.NumberFormat("en-US");
let version = 0;

function clearValues() {
    for (const key of keys) document.getElementById(key).textContent = "—";
}
function showError(text) {
    message.textContent = text;
    message.classList.add("error");
}
async function loadDashboard() {
    const request = ++version;
    clearValues();
    retry.hidden = true;
    stats.setAttribute("aria-busy", "true");
    message.classList.remove("error");
    message.textContent = "Checking Admin session…";
    try {
        const auth = await fetch(API_URL + "/api/admin/check", { credentials: "include" });
        if (request !== version) return;
        if (auth.status === 401) { window.location.href = "login.html"; return; }
        if (!auth.ok) throw new Error("Session check failed");
        message.textContent = "Loading Premium statistics…";
        const response = await fetch(API_URL + "/api/admin/premium/stats", { credentials: "include" });
        if (request !== version) return;
        if (response.status === 401) { window.location.href = "login.html"; return; }
        if (!response.ok) throw new Error("Stats request failed");
        const data = await response.json();
        if (request !== version) return;
        if (!data || keys.some(key => !Number.isSafeInteger(data[key]) || data[key] < 0)) throw new Error("Invalid statistics");
        for (const key of keys) {
            document.getElementById(key).textContent = numbers.format(data[key]) + (key === "totalIncome" ? " MMK" : "");
        }
        message.textContent = "Statistics loaded.";
    } catch {
        if (request !== version) return;
        clearValues();
        showError("Could not load Premium statistics. Please try again.");
        retry.hidden = false;
    } finally {
        if (request === version) stats.setAttribute("aria-busy", "false");
    }
}
retry.addEventListener("click", loadDashboard);
logout.addEventListener("click", async () => {
    ++version;
    logout.disabled = true;
    retry.hidden = true;
    clearValues();
    stats.setAttribute("aria-busy", "false");
    try {
        const response = await fetch(API_URL + "/api/logout", { method: "POST", credentials: "include" });
        if (!response.ok && response.status !== 401) throw new Error("Logout failed");
        window.location.href = "login.html";
    } catch {
        showError("Could not log out. Please try Logout again.");
        logout.disabled = false;
    }
});
window.addEventListener("pageshow", loadDashboard);
