import { API_URL } from "./config.js";

const el = id => document.getElementById(id);
const dialog = el("correctionDialog");
const plans = { MONTH_1: "1 Month", MONTH_3: "3 Months", MONTH_6: "6 Months", YEAR_1: "1 Year" };
const methods = { KBZPAY: "KBZPay", WAVE_MONEY: "Wave Money", AYA_PAY: "AYA Pay" };
const dates = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yangon", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
const PAGE_SIZE = 20;
let userId;
let authenticated = false;
let current = null;
let reviewed = null;
let busy = false;
let version = 0;
let historyVersion = 0;
let page = 1;
let pages = 1;

function notify(id, text, error = false) {
    el(id).textContent = text;
    el(id).classList.toggle("error", error);
}
function dateText(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value)) ? dates.format(new Date(value)) + " MMT" : "—";
}
function display(id, fields) {
    el(id).replaceChildren();
    for (const [label, value] of fields) {
        const dt = document.createElement("dt"), dd = document.createElement("dd");
        dt.textContent = label; dd.textContent = value; el(id).append(dt, dd);
    }
}
function inputTime(value) { return new Date(Date.parse(value) + 390 * 60000).toISOString().slice(0, -1); }
function mmtToUtc(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) throw new Error("Enter valid start and expiry dates in MMT.");
    const full = value.length === 16 ? value + ":00" : value;
    const normalized = full.includes(".") ? full.padEnd(23, "0") : full + ".000";
    const time = Date.parse(full + "+06:30");
    if (!Number.isFinite(time) || new Date(time + 390 * 60000).toISOString().slice(0, -1) !== normalized) throw new Error("Enter valid start and expiry dates in MMT.");
    return new Date(time).toISOString();
}
function remaining(expiry) {
    const time = typeof expiry === "string" ? Date.parse(expiry) : NaN;
    if (!Number.isFinite(time)) return "—";
    const hours = Math.floor(Math.max(0, time - Date.now()) / 3600000);
    return time <= Date.now() ? "0 days" : hours ? `${Math.floor(hours / 24)} days ${hours % 24} hours` : "Less than 1 hour";
}
function hasMembership(data) {
    const m = data?.membership;
    return m && m.telegram_user_id === userId && typeof m.start_at === "string" && typeof m.expires_at === "string" &&
        Number.isFinite(Date.parse(m.start_at)) && Number.isFinite(Date.parse(m.expires_at)) && m.expires_at > m.start_at;
}
async function api(path, options = {}) {
    const response = await fetch(API_URL + path, { ...options, credentials: "include" });
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (response.status === 401) { authenticated = false; window.location.href = "login.html"; }
    if (!response.ok) {
        const messages = { 400: "Invalid correction dates or reason. Check your input.", 401: "Admin session expired. Please sign in again.", 403: "Request origin rejected. Use the approved Nemo Movie site.", 404: "User or membership not found.", 409: "Membership could not be corrected in its current state. Reload the details before continuing." };
        const error = new Error(messages[response.status] || "Could not complete the request. Please try again.");
        error.status = response.status;
        throw error;
    }
    if (!data) throw new Error("Invalid response");
    return data;
}
const userPath = () => "/api/admin/premium/users/" + encodeURIComponent(userId);
async function fetchDetails() {
    const data = await api(userPath());
    if (!data.user || data.user.telegram_user_id !== userId || !["ACTIVE", "EXPIRED", "NON_PREMIUM"].includes(data.status)) throw new Error("Invalid response");
    return data;
}
function renderDetails(data) {
    current = data;
    const u = data.user, m = data.membership;
    display("identityDetails", [["Telegram User ID", u.telegram_user_id], ["Username", u.username ? "@" + u.username.replace(/^@/, "") : "—"], ["First Name", u.first_name || "—"], ["Last Name", u.last_name || "—"]]);
    display("membershipDetails", [["Status", data.status], ["Start Date", dateText(m?.start_at)], ["Expiry Date", dateText(m?.expires_at)], ["Remaining (as of load)", remaining(m?.expires_at)]]);
    el("profile").hidden = false;
    el("openCorrection").disabled = !hasMembership(data) || busy;
    if (!hasMembership(data)) notify("correctionMessage", "Membership unavailable. Correction is disabled.");
}
async function loadHistory() {
    if (!authenticated || !current) return;
    const request = ++historyVersion;
    el("historyRows").replaceChildren(); el("historyRetry").hidden = true;
    el("previousPage").disabled = true; el("nextPage").disabled = true;
    el("pageIndicator").textContent = "Page —";
    el("historyResults").setAttribute("aria-busy", "true");
    notify("historyMessage", "Loading payment history…");
    try {
        const data = await api(userPath() + "/payments?" + new URLSearchParams({ page, limit: PAGE_SIZE }));
        if (request !== historyVersion) return;
        if (!Array.isArray(data.payments) || data.payments.length > PAGE_SIZE || !Number.isSafeInteger(data.total) || data.total < 0 ||
            data.payments.some(p => !p || p.telegram_user_id !== userId || typeof p.payment_request_code !== "string" ||
                !Number.isSafeInteger(p.amount_mmk) || !Object.hasOwn(plans, p.plan) || !Object.hasOwn(methods, p.payment_method) ||
                !["PENDING", "EXPIRED", "CONFIRMED", "CORRECTED", "VOID", "REFUNDED"].includes(p.status))) throw new Error("Invalid history response");
        pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
        if (page > pages) { page = pages; await loadHistory(); return; }
        for (const p of data.payments) {
            const row = document.createElement("tr");
            for (const value of [p.payment_request_code, plans[p.plan], methods[p.payment_method], new Intl.NumberFormat("en-US").format(p.amount_mmk) + " MMK", p.status, dateText(p.payment_at ?? p.confirmed_at ?? p.created_at)]) {
                const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
            }
            el("historyRows").append(row);
        }
        notify("historyMessage", data.payments.length ? `${data.total} payment records` : "No payment records found.");
        el("pageIndicator").textContent = `Page ${page} of ${pages}`;
        el("previousPage").disabled = page <= 1; el("nextPage").disabled = page >= pages;
    } catch (error) {
        if (request === historyVersion) { notify("historyMessage", error.status === 401 ? error.message : "Could not load payment history. Please retry.", true); el("historyRetry").hidden = false; }
    } finally { if (request === historyVersion) el("historyResults").setAttribute("aria-busy", "false"); }
}
async function initialize() {
    if (busy) return;
    const request = ++version;
    ++historyVersion;
    authenticated = false; current = null; reviewed = null;
    if (dialog.open) dialog.close();
    el("profile").hidden = true; el("retryButton").hidden = true; el("correctionForm").hidden = true;
    el("correctionFields").disabled = true;
    notify("correctionMessage", "");
    notify("detailsMessage", "Checking Admin session…");
    try {
        await api("/api/admin/check");
        if (request !== version) return;
        authenticated = true;
        const ids = new URLSearchParams(window.location.search).getAll("telegramUserId");
        const value = ids[0];
        if (ids.length !== 1 || !/^[1-9]\d*$/.test(value || "") || !Number.isSafeInteger(Number(value))) {
            notify("detailsMessage", "A valid Telegram User ID is required in the page URL.", true); return;
        }
        userId = Number(value);
        const data = await fetchDetails();
        if (request !== version) return;
        renderDetails(data); notify("detailsMessage", "User details loaded. Dates shown in Myanmar Time (MMT).");
        page = 1; await loadHistory();
    } catch (error) {
        if (request === version) { notify("detailsMessage", error.status ? error.message : "Could not load user details. Please retry.", true); el("retryButton").hidden = false; }
    }
}
function currentFields(data) {
    return [["Telegram User ID", userId], ["Current Status", data.status], ["Current Start", dateText(data.membership.start_at)], ["Current Expiry", dateText(data.membership.expires_at)]];
}
async function openCorrection() {
    if (busy || !authenticated || !hasMembership(current)) return;
    const request = ++version;
    el("openCorrection").disabled = true;
    el("correctionForm").hidden = true;
    el("correctionFields").disabled = true;
    notify("correctionMessage", "Refreshing current membership…");
    try {
        const data = await fetchDetails();
        if (request !== version) return;
        renderDetails(data);
        if (!hasMembership(data)) return;
        display("currentDetails", currentFields(data));
        el("newStart").value = inputTime(data.membership.start_at);
        el("newExpiry").value = inputTime(data.membership.expires_at);
        el("correctionReason").value = "";
        el("correctionForm").hidden = false; el("correctionFields").disabled = false;
        notify("correctionMessage", "Enter the corrected dates and the reason for this correction.");
    } catch (error) {
        if (request === version) notify("correctionMessage", error.status ? error.message : "Could not refresh membership. Try Correct Membership again.", true);
    } finally { if (request === version) el("openCorrection").disabled = !authenticated || !hasMembership(current); }
}
function review(event) {
    event.preventDefault();
    if (busy || !authenticated || el("correctionFields").disabled || !hasMembership(current)) return;
    try {
        const start = mmtToUtc(el("newStart").value), expiry = mmtToUtc(el("newExpiry").value);
        const reason = el("correctionReason").value.trim();
        if (!reason || reason.length > 1000 || /[\x00-\x1f]/.test(reason)) throw new Error("Enter a reason of 1–1000 characters without control characters.");
        if (expiry <= start) throw new Error("New Expiry must be later than New Start.");
        reviewed = { payload: { start_at: start, expires_at: expiry, reason }, membership: { ...current.membership } };
        display("reviewDetails", [...currentFields(current), ["New Start", dateText(start)], ["New Expiry", dateText(expiry)], ["Reason", reason]]);
        notify("saveMessage", ""); el("saveCorrection").disabled = false; dialog.showModal();
    } catch (error) { notify("correctionMessage", error.message, true); }
}
async function saveCorrection() {
    if (busy || !authenticated || !reviewed || !dialog.open || !hasMembership(current)) return;
    const proposal = reviewed;
    busy = true; ++version;
    for (const id of ["saveCorrection", "cancelCorrection", "correctionFields", "openCorrection", "logoutButton"]) el(id).disabled = true;
    notify("saveMessage", "Checking and saving correction…");
    let saved = false;
    let retrySafe = false;
    try {
        // Catch intervening changes before submitting absolute dates; backend remains authoritative.
        const fresh = await fetchDetails();
        if (!hasMembership(fresh) || ["start_at", "expires_at", "updated_at"].some(key => fresh.membership[key] !== proposal.membership[key])) {
            renderDetails(fresh);
            notify("correctionMessage", "Membership changed since review. Open Correct Membership again and review the latest dates.", true); return;
        }
        await api(userPath() + "/membership", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(proposal.payload) });
        saved = true;
        el("correctionForm").hidden = true;
        // Never project locally calculated dates into the authoritative membership display.
        const updated = await fetchDetails();
        renderDetails(updated);
        notify("correctionMessage", "Membership Corrected.");
        notify("detailsMessage", "Membership Corrected. Authoritative details refreshed.");
    } catch (error) {
        retrySafe = !saved && [400, 403].includes(error.status);
        notify("correctionMessage", saved ? "Correction saved, but updated details could not be loaded. Reload details before continuing." :
            error.status && error.status < 500 ? error.message : "Correction outcome could not be verified. Reload details before trying again; it may have been saved.", true);
        if (!retrySafe) el("retryButton").hidden = false;
    } finally {
        busy = false; dialog.close(); el("cancelCorrection").disabled = false; el("logoutButton").disabled = false;
        el("saveCorrection").disabled = true;
        el("correctionFields").disabled = !retrySafe;
        el("openCorrection").disabled = !authenticated || !hasMembership(current);
    }
}
el("retryButton").addEventListener("click", initialize);
el("historyRetry").addEventListener("click", loadHistory);
el("previousPage").addEventListener("click", () => { if (page > 1) { --page; loadHistory(); } });
el("nextPage").addEventListener("click", () => { if (page < pages) { ++page; loadHistory(); } });
el("openCorrection").addEventListener("click", openCorrection);
el("correctionForm").addEventListener("submit", review);
el("saveCorrection").addEventListener("click", saveCorrection);
el("cancelCorrection").addEventListener("click", () => { if (!busy) dialog.close(); });
dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
dialog.addEventListener("close", () => { reviewed = null; el("reviewDetails").replaceChildren(); });
el("logoutButton").addEventListener("click", async () => {
    if (busy) return;
    ++version; ++historyVersion; authenticated = false; current = null;
    if (dialog.open) dialog.close();
    el("profile").hidden = true; el("logoutButton").disabled = true;
    try {
        const response = await fetch(API_URL + "/api/logout", { method: "POST", credentials: "include" });
        if (!response.ok && response.status !== 401) throw new Error("Logout failed");
        window.location.href = "login.html";
    } catch { notify("detailsMessage", "Could not log out. Retry Logout or check your session again.", true); el("retryButton").hidden = false; }
    finally { el("logoutButton").disabled = false; }
});
window.addEventListener("pageshow", initialize);
