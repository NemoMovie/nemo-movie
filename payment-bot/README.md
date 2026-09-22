# Payment Bot foundation — development instructions only

This separate process handles Premium plan/method selection through the existing
backend. It owns no database. The Nemo Movie delivery bot remains unchanged.
No production configuration or bot has been started by this implementation.

## Configuration and manual startup (later, after review)

Payment Bot variable names: `PAYMENT_BOT_MODE`, `PAYMENT_BOT_TOKEN`, `PAYMENT_BOT_API_SECRET`,
`PAYMENT_BOT_BACKEND_URL` (explicit URL required in real mode). Backend needs the same
`PAYMENT_BOT_API_SECRET`. Use a distinct strong secret, not any existing token,
Admin credential, Premium-status secret, or mapping secret. No values are provided
here. `payment-bot/.env` and `.env.*` are ignored; no environment file is created.
Use a separate token belonging to the Payment Bot, never the delivery bot token.

`node payment-bot/bot.js` is the future manual entry point. It explicitly loads
only this folder's .env and reuses installed `dotenv`
from `telegram-bot/package.json` via createRequire. It never imports or starts the
existing delivery bot. No package installation or dependency changes are needed
in this checkout; both folders must be retained on a future deployment.
Tests/imports never start polling. Stop a manually started process with Ctrl+C.
Use a synthetic backend and its explicit non-production URL for development.

## Stage 2 internal API and persisted workflow

All routes under /api/internal/payment-bot require the dedicated Bearer secret and no-store, including errors. Admin cookies do not authorize them. Missing configuration fails closed. Public catalogue requests do not use this secret.

Existing users/plans/status endpoints remain. New POST routes: /flow/state, /flow/select, /flow/method, /flow/cancel, /flow/message. State returns membership and minimal case progress; it does not return Telegram proof storage identifiers. Message payloads contain metadata only, never binary. Parsed message payload bound is 24 KiB; other routes remain 4 KiB, subject to Express's parser limit.

Run the explicit migratePaymentBotIntake(db) amendment only after all Stage 1 migrations, on an approved database. No automatic production migration is added. Re-run the Stage 2 amendment for idempotent validation; the older Stage 1 exact-schema verifier intentionally does not accept the amended trigger.

Private /start and /start upgrade use Telegram sender identity. Backend plans/prices remain authoritative. Stage 6 explicitly permits ACTIVE members to purchase early renewals; confirmation preserves existing remaining time. Selecting a plan does not create a case; selecting a method creates/resumes one WAITING_PAYMENT case. The same case can change method only before any proof, while unexpired. Old/new method/account are immutable audit history; other purchase fields cannot change.

PHOTO metadata appends evidence plus a linked conversation entry atomically. Replacement photos before last-four remain history and newest becomes current proof. Exact ASCII four-digit TEXT submits once; leading zeros remain text. No full transaction reference is invented. Review clarification text is append-only, without changing review state. Cancellation and lazy 24-hour expiry close unpaid attempts; old cases stay preserved. New attempts require a current closed-case boundary, rejecting stale selection buttons.

Progress is derived from SQLite after every update. Durable operation receipts deduplicate callbacks/messages across restarts. This prevents duplicate data changes, not necessarily duplicate response messages if Telegram redelivers an update. Conflicting reuse of an event key fails closed. No in-memory conversational state is authoritative.

Payment accounts are deliberately nonpayable development placeholders. The Burmese instruction replaces the transfer directive with a test-only/no-payment warning. Do not run this against real customers or real payments. Real account configuration, proof retrieval, general abuse throttling and outbound 429 resilience remain separate work.

## Isolated checks

node --test --test-concurrency=1 backend/payment-bot-api.test.js backend/payment-bot-intake.test.js payment-bot/flow.test.js

Tests use in-memory SQLite, ephemeral loopback HTTP, and injected fake transport. No real Telegram, production DB, environment file or port 3000 is used.

## Stage 3 notification preparation

The explicit Stage 3 backend migration enables automatic activation after Admin
confirmation. Durable confirmation/success/rejection messages reuse SYSTEM
conversation rows and linked notification state. The future worker can read the
dedicated-secret-protected GET /notifications endpoint; no worker was started during implementation,
no Telegram messages are sent, and no token is needed for isolated tests.
Rejection actions use the existing plans:<case-id> callback. See
backend/PAYMENT-CASES.md for migration order, transaction boundaries and remaining
worker requirements. Real payment account configuration is still deliberately absent.

## Stage 4 worker (offline/injected only)

Delivery source is the existing immutable conversation message, with durable
PENDING_SEND/SENT/FAILED metadata. `delivery-worker.js` provides processOne and a
bounded processBatch; inject createClient and a transport implementing
sendMessage({telegramUserId,text,actions}). `fake-transport.js` provides offline
success/failure/delay simulation. Neither import starts polling or uses a token.
Stage 5 connects this worker through an injected transport in the controlled runtime.

Claims/acks use PAYMENT_BOT_API_SECRET and the /deliveries endpoints documented in
backend/PAYMENT-CASES.md. A 120-second lease prevents simultaneous intentional
claims; failed sends retry after 60 seconds, capped at five attempts. SQLite owns
restart progress. SENT never returns to pending. Ordering is per customer;
exhaustion holds that customer's subsequent messages for future operator review.

No real Telegram delivery guarantee is made: accepted send + crash/lost ack can
produce a duplicate on lease recovery. Never retry the whole business/payment
flow. An ACK_UNCERTAIN result stops the batch; consult durable state on next run.
No raw transport error, recipient, token, payload or claim token is logged.

Offline checks: node --test --test-concurrency=1 backend/payment-case-delivery.test.js
Token setup and production migration remain
explicitly deferred. Do not run the existing real bot entry point for these tests.

## Stage 5 transport and controlled runtime (not activated)

`telegram-transport.js` implements sendMessage, flow reply keyboards, callback
acknowledgement and getUpdates using Node 24 fetch. All network calls are injectable;
tests intercept them. No BotFather bot, real token, payment account or production
worker is configured by this stage. The existing movie bot is untouched.

`PAYMENT_BOT_MODE=real` is an explicit future opt-in. Before polling, real mode
requires PAYMENT_BOT_TOKEN (Telegram only), PAYMENT_BOT_API_SECRET (backend only)
and PAYMENT_BOT_BACKEND_URL. There is no default production backend connection.
Remote backend URLs require HTTPS; HTTP is allowed only for loopback. URLs must
be origin-only, without credentials. Redirects are rejected. Missing real-mode
configuration fails closed, never silently falling back to fake delivery.

Default `development` mode requires an injected synthetic `api` function through
`configure({env:{PAYMENT_BOT_MODE:'development'},api})`; it uses a fake transport,
requires no token and opens no network connection itself. For synthetic inbound
updates, inject a fake `telegram` into `createRuntime({api,telegram,transport})`
and call processUpdates/processDelivery. The CLI deliberately exits unless a safe
configuration is provided; it does not invent a backend or load real data for dev.
See runtime.test.js and backend/payment-bot-runtime.test.js for offline harnesses.

The runtime passes private Telegram updates to the unchanged Stage 2 workflow.
Identity comes from from.id, never callback payloads. Approved callbacks retain
their existing names and case-boundary IDs (not customer identity); premium_reselect
is an alias for returning to plan selection. Every callback is acknowledged, and
acknowledgement failure does not discard its business action. Plans do not create
cases; methods do. Photos append metadata only, with no getFile/download. Replacement
proofs and exact ASCII last-four evidence retain the existing SQLite receipt rules.
Customer wording and nonpayable development instructions remain in place.

Two independent sequential loops poll updates and claim durable delivery work.
Each iteration pauses two seconds (injectable 1–60 seconds), with a 20-second
Telegram long poll and 50-update maximum. Requests have finite timeouts. Importing
modules starts nothing; start rejects duplicate calls. Polling errors are contained.
SIGINT/SIGTERM abort the current long poll, stop taking new work, wake idle waits,
and await active flow/send/ack work. Use Ctrl+C to stop a future manual process.
Run only one polling process per Payment Bot token.

Offsets advance after handled/ignored updates, including permanent input rejection
(400/404/409/422); transient/backend-auth failures leave the update unacknowledged
for retry. Telegram acknowledges an offset on the next getUpdates request.
Offsets are in memory and restart at zero. Unconfirmed updates can replay after
restart; durable backend operation receipts prevent duplicate mutations, not
duplicate customer reply messages. This is not exactly-once delivery.

Stage 3 Admin replies/notifications still travel exclusively through the Stage 4
claim -> transport -> SENT/FAILED acknowledgement path. No Admin HTTP handler sends
Telegram directly. Existing 120-second leases, 60-second retry delay, five-attempt
cap and per-customer ordering remain authoritative. Ambiguous accepted-send/lost-ack
can duplicate delivery on recovery; no new retry scheduler is introduced here.

Transport errors contain only categories (network, rate limit, unavailable recipient,
API rejection, malformed response) and an optional integer retryAfter of 1–3600
seconds. No raw error/response/URL is logged. This hint does not override Stage 4
retry scheduling yet. Text is sent without parse_mode; keyboard actions are
allowlisted and never contain secrets, payment accounts or trusted user identity.
Never put real credentials in source, tests, logs, delivery payloads or documentation.

Additional isolated checks:

```
node --test payment-bot/runtime.test.js backend/payment-bot-runtime.test.js
```

Stage 5 prepares real transport; it does not authorize enabling it for customers.
Real credentials, accounts, production migration approval and real end-to-end
verification remain separate work.
