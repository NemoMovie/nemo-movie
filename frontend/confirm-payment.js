import { API_URL } from "./config.js";

const el = id => document.getElementById(id);
const codeInput = el("requestCode");
const message = el("confirmMessage");
const dialog = el("reviewDialog");
const plans = { MONTH_1: "1 Month", MONTH_3: "3 Months", MONTH_6: "6 Months", YEAR_1: "1 Year" };
const methods = { KBZPAY: "KBZPay", WAVE_MONEY: "Wave Money", AYA_PAY: "AYA Pay" };
const dates = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yangon", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
let authenticated = false;
let loaded = null;
let reviewed = null;
let version = 0;
let submitting = false;
let blocked = false;

function dateText(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value)) ? dates.format(new Date(value)) + " MMT" : "—";
}
function amount(value) { return new Intl.NumberFormat("en-US").format(value) + " MMK"; }
function username(value) { return value ? "@" + value.replace(/^@/, "") : "—"; }
function showMessage(text, error = false) {
    message.textContent = text;
    message.classList.toggle("error", error);
}
function display(id, fields) {
    const target = el(id);
    target.replaceChildren();
    for (const [label, value] of fields) {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = label;
        dd.textContent = value;
        target.append(dt, dd);
    }
}
// Interpret the entered wall-clock time as MMT, regardless of the browser's timezone.
function mmtToUtc(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error("Enter the actual payment date and time in MMT.");
    const full = value.length === 16 ? value + ":00" : value;
    const time = Date.parse(full + "+06:30");
    if (!Number.isFinite(time) || new Date(time + 390 * 60000).toISOString().slice(0, 19) !== full) throw new Error("Enter a valid payment date and time in MMT.");
    if (time > Date.now()) throw new Error("Payment time must not be in the future.");
    return new Date(time).toISOString();
}
function validPending() {
    return loaded && loaded.status === "PENDING" && typeof loaded.request_expires_at === "string" &&
        Date.parse(loaded.request_expires_at) > Date.now() && !blocked;
}
function clearLoaded() {
    loaded = null;
    reviewed = null;
    blocked = false;
    if (dialog.open) dialog.close();
    el("requestPanel").hidden = true;
    el("verificationForm").hidden = true;
    el("verificationFields").disabled = true;
    el("successPanel").hidden = true;
    for (const id of ["requestDetails", "reviewDetails", "successDetails"]) el(id).replaceChildren();
}
function errorText(status, backendMessage) {
    if (status === 401) return "Admin session expired. Please sign in again.";
    if (status === 403) return "Request origin rejected. Open this page on the approved Nemo Movie site.";
    if (status === 404) return "Request Code not found. It may have expired and been removed.";
    const safe = {
        "Transaction reference already confirmed": "This transaction reference is already confirmed for this payment method.",
        "Request is not valid for confirmation": "This request is no longer a valid PENDING request. Find it again to check its current state.",
        "Payment time is in the future": "Payment time must not be in the future.",
        "Payment plan mismatch": "The payment request could not be verified. Review it before proceeding."
    };
    if ([400, 409].includes(status) && Object.hasOwn(safe, backendMessage)) return safe[backendMessage];
    if (status === 400) return "Invalid request or input. Check the exact Request Code, transaction reference and payment time.";
    if (status === 409) return "The request could not be confirmed in its current state. Find it again before retrying.";
    return "Could not complete the request. Please try again.";
}
async function api(path, options = {}) {
    const response = await fetch(API_URL + path, { ...options, credentials: "include" });
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (response.status === 401) { authenticated = false; window.location.href = "login.html"; }
    if (!response.ok) {
        const error = new Error(errorText(response.status, data?.message));
        error.status = response.status;
        error.backendMessage = data?.message;
        throw error;
    }
    if (!data) throw new Error("Invalid response");
    return data;
}
async function lookup() {
    if (!authenticated || submitting) return;
    const request = ++version;
    const code = codeInput.value.trim();
    clearLoaded();
    el("transactionReference").value = "";
    el("paymentTime").value = "";
    if (!/^NM-[A-HJ-NP-Z2-9]{6}$/.test(code)) { showMessage("Enter an exact Request Code in the format NM-XXXXXX. Codes are case-sensitive.", true); return; }
    el("findButton").disabled = true;
    showMessage("Finding request…");
    try {
        const p = await api("/api/admin/premium/payments/request/" + encodeURIComponent(code));
        if (request !== version) return;
        if (!Number.isSafeInteger(p.id) || p.id <= 0 || p.payment_request_code !== code ||
            !Number.isSafeInteger(p.telegram_user_id) || p.telegram_user_id <= 0 ||
            !Object.hasOwn(plans, p.plan) || !Object.hasOwn(methods, p.payment_method) ||
            !Number.isSafeInteger(p.amount_mmk) || p.amount_mmk <= 0 ||
            !["PENDING", "EXPIRED", "CONFIRMED", "CORRECTED", "VOID", "REFUNDED"].includes(p.status)) throw new Error("Invalid response");
        loaded = p;
        display("requestDetails", [["Request Code", p.payment_request_code], ["Telegram User ID", p.telegram_user_id],
            ["Username", username(p.username)], ["Selected Plan", plans[p.plan]], ["Payment Method", methods[p.payment_method]],
            ["Amount", amount(p.amount_mmk)], ["Request Created", dateText(p.created_at)], ["Request Expires", dateText(p.request_expires_at)], ["Status", p.status]]);
        el("requestPanel").hidden = false;
        el("verificationForm").hidden = !validPending();
        el("verificationFields").disabled = !validPending();
        showMessage(validPending() ? "Request loaded. Verify the real payment before continuing." :
            p.status === "CONFIRMED" ? "This payment is already confirmed. No new confirmation is needed." :
            "This request is expired or is not eligible for confirmation.");
    } catch (error) {
        if (request === version) showMessage(error.status ? error.message : "Could not load the request. Please use Find Request to try again.", true);
    } finally { if (request === version) el("findButton").disabled = !authenticated; }
}
async function initialize() {
    if (submitting) return;
    const request = ++version;
    authenticated = false;
    clearLoaded();
    el("findButton").disabled = true;
    el("retryButton").hidden = true;
    showMessage("Checking Admin session…");
    try {
        await api("/api/admin/check");
        if (request !== version) return;
        authenticated = true;
        el("findButton").disabled = false;
        showMessage("Enter the exact Payment Request Code.");
        const code = new URLSearchParams(window.location.search).get("code");
        if (code !== null) { codeInput.value = code; await lookup(); }
    } catch {
        if (request === version) { showMessage("Could not verify Admin session. Please try again.", true); el("retryButton").hidden = false; }
    }
}
function review(event) {
    event.preventDefault();
    if (submitting || !authenticated) return;
    if (!validPending()) { showMessage("Find a valid PENDING request before confirming.", true); el("verificationFields").disabled = true; return; }
    try {
        const reference = el("transactionReference").value.trim();
        if (!reference || reference.length > 150 || /[\x00-\x1f]/.test(reference)) throw new Error("Enter a valid transaction reference (maximum 150 characters).");
        const payload = { transaction_reference: reference, payment_at: mmtToUtc(el("paymentTime").value) };
        reviewed = { id: loaded.id, payload };
        display("reviewDetails", [["Request Code", loaded.payment_request_code], ["Telegram User", loaded.telegram_user_id],
            ["Plan", plans[loaded.plan]], ["Method", methods[loaded.payment_method]], ["Amount", amount(loaded.amount_mmk)],
            ["Transaction Reference", reference], ["Payment Time", dateText(payload.payment_at)]]);
        el("reviewMessage").textContent = "";
        el("finalButton").disabled = false;
        dialog.showModal();
    } catch (error) { showMessage(error.message, true); }
}
async function confirmPayment() {
    if (submitting || !authenticated || !dialog.open || !reviewed || reviewed.id !== loaded?.id) return;
    if (!validPending()) { dialog.close(); el("verificationFields").disabled = true; showMessage("Request expired or unavailable. Find it again before proceeding.", true); return; }
    const selected = loaded;
    const payload = reviewed.payload;
    submitting = true;
    for (const id of ["finalButton", "cancelButton", "findButton", "requestCode", "logoutButton", "verificationFields"]) el(id).disabled = true;
    el("reviewMessage").textContent = "Confirming payment. Please wait…";
    try {
        const result = await api(`/api/admin/premium/payments/${selected.id}/confirm`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
        });
        const p = result.payment;
        const m = result.membership;
        if (!p || p.id !== selected.id || p.status !== "CONFIRMED" || p.telegram_user_id !== selected.telegram_user_id ||
            !Object.hasOwn(plans, p.plan) || !Number.isSafeInteger(p.amount_mmk) || !m ||
            m.telegram_user_id !== p.telegram_user_id || typeof m.start_at !== "string" || typeof m.expires_at !== "string" ||
            !Number.isFinite(Date.parse(m.start_at)) || !Number.isFinite(Date.parse(m.expires_at))) throw new Error("Invalid response");
        loaded = p;
        blocked = true;
        el("verificationForm").hidden = true;
        el("requestPanel").hidden = true;
        display("successDetails", [["Telegram User ID", p.telegram_user_id], ["Plan", plans[p.plan]], ["Amount", amount(p.amount_mmk)],
            ["Premium Status", Date.parse(m.expires_at) > Date.now() ? "ACTIVE" : "EXPIRED"],
            ["Start Date", dateText(m.start_at)], ["Expiry Date", dateText(m.expires_at)]]);
        el("successPanel").hidden = false;
        showMessage("Payment Confirmed. Premium membership updated successfully.");
    } catch (error) {
        // Network/server uncertainty must be resolved by lookup, never an automatic POST retry.
        blocked = ![400, 403].includes(error.status) && !(error.status === 409 && error.backendMessage === "Transaction reference already confirmed");
        showMessage(error.status && error.status < 500 ? error.message : "Confirmation outcome could not be verified. Find the request again before retrying; it may already be confirmed.", true);
    } finally {
        submitting = false;
        dialog.close();
        for (const id of ["cancelButton", "requestCode", "logoutButton"]) el(id).disabled = false;
        el("findButton").disabled = !authenticated;
        el("verificationFields").disabled = !validPending();
        el("finalButton").disabled = true;
    }
}
el("lookupForm").addEventListener("submit", event => { event.preventDefault(); lookup(); });
codeInput.addEventListener("input", () => { if (!submitting) { ++version; clearLoaded(); el("findButton").disabled = !authenticated; } });
el("verificationForm").addEventListener("submit", review);
el("finalButton").addEventListener("click", confirmPayment);
el("cancelButton").addEventListener("click", () => { if (!submitting) dialog.close(); });
dialog.addEventListener("cancel", event => { if (submitting) event.preventDefault(); });
dialog.addEventListener("close", () => { reviewed = null; el("reviewDetails").replaceChildren(); });
el("retryButton").addEventListener("click", initialize);
el("anotherButton").addEventListener("click", () => {
    if (submitting) return;
    ++version; clearLoaded(); codeInput.value = "";
    el("transactionReference").value = ""; el("paymentTime").value = "";
    showMessage("Enter another Payment Request Code."); codeInput.focus();
});
el("logoutButton").addEventListener("click", async () => {
    if (submitting) return;
    ++version; authenticated = false; clearLoaded(); el("findButton").disabled = true;
    el("logoutButton").disabled = true;
    try {
        const response = await fetch(API_URL + "/api/logout", { method: "POST", credentials: "include" });
        if (!response.ok && response.status !== 401) throw new Error("Logout failed");
        window.location.href = "login.html";
    } catch { showMessage("Could not log out. Retry Logout or check your session again.", true); el("retryButton").hidden = false; }
    finally { el("logoutButton").disabled = false; }
});
window.addEventListener("pageshow", initialize);
