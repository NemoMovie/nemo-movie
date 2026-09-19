import { API_URL } from "./config.js";

const element = id => document.getElementById(id);
const message = element("historyMessage");
const rows = element("historyRows");
const retry = element("retryButton");
const previous = element("previousPage");
const next = element("nextPage");
const search = element("historySearch");
const status = element("historyStatus");
const method = element("paymentMethod");
const sort = element("historySort");
const dialog = element("paymentDialog");
const details = element("paymentDetails");
const logout = element("logoutButton");
const PAGE_SIZE = 20;
const plans = { MONTH_1: "1 Month", MONTH_3: "3 Months", MONTH_6: "6 Months", YEAR_1: "1 Year" };
const methods = { KBZPAY: "KBZPay", WAVE_MONEY: "Wave Money", AYA_PAY: "AYA Pay" };
const numbers = new Intl.NumberFormat("en-US");
const dates = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Yangon", year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true
});
let page = 1;
let pages = 1;
let version = 0;
let debounce;
let authenticated = false;
let loggingOut = false;

function dateText(value) {
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? dates.format(time) + " MMT" : "—";
}
function usernameText(value) { return value ? "@" + value.replace(/^@/, "") : "—"; }
function amountText(value) { return numbers.format(value) + " MMK"; }
function paymentDate(payment) { return payment.payment_at ?? payment.confirmed_at ?? payment.created_at; }
function historyBadge(status) {
    const badge = document.createElement("span");
    const colors = { CONFIRMED: "is-active", CORRECTED: "is-pending", VOID: "is-expired", REFUNDED: "is-legacy" };
    badge.className = "membership-status " + colors[status];
    badge.textContent = status;
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
    if (dialog.open) dialog.close();
    details.replaceChildren();
}
function showDetail(payment) {
    details.replaceChildren();
    // Display only these fields from the list response, never the full record.
    const fields = [
        ["Request Code", payment.payment_request_code], ["Telegram User ID", payment.telegram_user_id],
        ["Username", usernameText(payment.username)], ["Plan", plans[payment.plan]],
        ["Payment Method", methods[payment.payment_method]], ["Amount", amountText(payment.amount_mmk)],
        ["Payment Date", dateText(paymentDate(payment))], ["Confirmed Date", dateText(payment.confirmed_at)],
        ["Status", historyBadge(payment.status)]
    ];
    if (payment.transaction_reference) fields.push(["Transaction Reference", payment.transaction_reference]);
    if (payment.admin_note) fields.push(["Admin Note", payment.admin_note]);
    for (const [label, value] of fields) {
        const term = document.createElement("dt");
        term.textContent = label;
        const description = document.createElement("dd");
        if (label === "Status") description.append(value);
        else description.textContent = value;
        details.append(term, description);
    }
    element("detailMessage").textContent = "Read-only history. Dates shown in Myanmar Time (MMT); missing payment dates use confirmation or creation date.";
    dialog.showModal();
}
function renderRows(payments) {
    for (const payment of payments) {
        const row = document.createElement("tr");
        for (const value of [payment.payment_request_code,
            `${payment.telegram_user_id} · ${usernameText(payment.username)}`,
            plans[payment.plan], methods[payment.payment_method], amountText(payment.amount_mmk)]) {
            const cell = document.createElement("td");
            cell.textContent = value;
            row.append(cell);
        }
        const state = document.createElement("td");
        state.append(historyBadge(payment.status));
        const paymentDateCell = document.createElement("td");
        paymentDateCell.textContent = dateText(paymentDate(payment));
        const action = document.createElement("td");
        const view = document.createElement("button");
        view.type = "button";
        view.className = "users-button";
        view.textContent = "View";
        view.setAttribute("aria-label", "View request " + payment.payment_request_code);
        view.addEventListener("click", () => showDetail(payment));
        action.append(view);
        row.append(state, paymentDateCell, action);
        rows.append(row);
    }
}
async function loadHistory() {
    if (!authenticated || loggingOut) return;
    const request = ++version;
    resetResults();
    message.textContent = "Loading payment history…";
    element("historyResults").setAttribute("aria-busy", "true");
    const query = new URLSearchParams({ page, limit: PAGE_SIZE, search: search.value.trim(), status: status.value, method: method.value, sort: sort.value });
    try {
        const data = await requestJson("/api/admin/premium/payments?" + query);
        if (request !== version) return;
        if (!data || !Array.isArray(data.records) || !Number.isSafeInteger(data.total) || data.total < 0 ||
            data.page !== page || data.limit !== PAGE_SIZE || data.totalPages !== Math.ceil(data.total / PAGE_SIZE) ||
            data.records.length > PAGE_SIZE || data.records.some(payment => !payment || !["CONFIRMED", "CORRECTED", "VOID", "REFUNDED"].includes(payment.status) ||
                !Number.isSafeInteger(payment.telegram_user_id) || payment.telegram_user_id <= 0 ||
                typeof payment.payment_request_code !== "string" || !Object.hasOwn(plans, payment.plan) ||
                !Object.hasOwn(methods, payment.payment_method) || !Number.isSafeInteger(payment.amount_mmk) || payment.amount_mmk < 0 ||
                (payment.username != null && typeof payment.username !== "string"))) throw new Error("Invalid payment history response");
        pages = Math.max(1, data.totalPages);
        if (page > pages) { page = pages; await loadHistory(); return; }
        renderRows(data.records);
        message.textContent = data.records.length ? numbers.format(data.total) + " payment records" : "No payment records found.";
        element("pageIndicator").textContent = `Page ${page} of ${pages}`;
        previous.disabled = page <= 1;
        next.disabled = page >= pages;
    } catch {
        if (request !== version) return;
        rows.replaceChildren();
        message.textContent = "Could not load payment history. Please try again.";
        message.classList.add("error");
        retry.hidden = false;
    } finally {
        if (request === version) element("historyResults").setAttribute("aria-busy", "false");
    }
}
async function initialize() {
    const request = ++version;
    clearTimeout(debounce);
    authenticated = false;
    resetResults();
    message.textContent = "Checking Admin session…";
    element("historyResults").setAttribute("aria-busy", "true");
    try {
        await requestJson("/api/admin/check");
        if (request !== version || loggingOut) return;
        authenticated = true;
        await loadHistory();
    } catch {
        if (request !== version) return;
        message.textContent = "Could not verify Admin session. Please try again.";
        message.classList.add("error");
        retry.hidden = false;
        element("historyResults").setAttribute("aria-busy", "false");
    }
}
function criteriaChanged(delay = 0) {
    page = 1;
    clearTimeout(debounce);
    if (!authenticated || loggingOut) return;
    ++version; // Discard an older response even while the debounce is pending.
    resetResults();
    message.textContent = "Loading payment history…";
    element("historyResults").setAttribute("aria-busy", "true");
    debounce = setTimeout(loadHistory, delay);
}
search.addEventListener("input", () => criteriaChanged(300));
status.addEventListener("change", () => criteriaChanged());
method.addEventListener("change", () => criteriaChanged());
sort.addEventListener("change", () => criteriaChanged());
element("historyFilters").addEventListener("submit", event => { event.preventDefault(); criteriaChanged(); });
previous.addEventListener("click", () => { if (page > 1) { --page; loadHistory(); } });
next.addEventListener("click", () => { if (page < pages) { ++page; loadHistory(); } });
retry.addEventListener("click", () => authenticated ? loadHistory() : initialize());
dialog.addEventListener("close", () => details.replaceChildren());
logout.addEventListener("click", async () => {
    loggingOut = true;
    ++version;
    clearTimeout(debounce);
    logout.disabled = true;
    resetResults();
    message.textContent = "Logging out…";
    element("historyResults").setAttribute("aria-busy", "false");
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
